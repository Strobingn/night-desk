import WebSocket from "ws";
import type { EventBus } from "../bus.js";
import { enrichSighting } from "../market/enrich.js";
import { DexTokenBatcher } from "../market/dex-batch.js";
import { bucketFor, type NetLimiter, type SourceId } from "../market/net.js";
import { FeedHealth, SOURCE_ORDER } from "./feed-health.js";
import { parseDexListings, parseDexPaprika, parseGeckoPools, parseJupiterRecent } from "../market/listings.js";
import type { DeskEvents, FeedStatus, RawSighting } from "../types.js";

/**
 * How often each live listing feed is polled. Pump stays on its websocket, unthrottled.
 * v12.1: DexScreener lists poll twice as often (6/min each against a 60/min limit) and
 * Jupiter recent goes 20s -> 15s. GeckoTerminal caches every answer for 60s server-side
 * and its keyless limit is ~5/min, so it drops to 3/min (budget 4/min) and gets what is left.
 */
export const SCOUT_POLL_MS = {
  dexProfiles: 10_000,
  dexBoostsLatest: 10_000,
  dexBoostsTop: 30_000,
  dexTakeovers: 30_000,
  geckoNew: 30_000,
  geckoTrending: 60_000,
  jupiterRecent: 15_000,
  dexPaprikaNew: 20_000,
  dexPaprikaTop: 60_000,
  bitquery: 30_000
} as const;

/** After an HTTP 410 the source is marked down and only re-checked this often. */
export const GONE_RECHECK_MS = 30 * 60_000;

export const JUPITER_RECENT_URL = "https://api.jup.ag/tokens/v2/recent";
/** DexPaprika removed /networks/solana/pools (HTTP 410) and points at pools/search. */
export const DEXPAPRIKA_NEW_URL = "https://api.dexpaprika.com/networks/solana/pools/search?limit=25&order_by=created_at&sort=desc";
export const DEXPAPRIKA_TOP_URL = "https://api.dexpaprika.com/networks/solana/pools/search?limit=25&order_by=volume_usd_24h&sort=desc";

export interface ScoutSources {
  dexscreener: boolean;
  gecko: boolean;
  jupiter: boolean;
  dexpaprika: boolean;
  bitquery: boolean;
}

export const DEFAULT_SCOUT_SOURCES: ScoutSources = {
  dexscreener: true,
  gecko: true,
  jupiter: true,
  dexpaprika: false,
  bitquery: true
};

export interface ScoutOptions {
  bus: EventBus<DeskEvents>;
  feedMode: FeedStatus["mode"];
  demo: boolean;
  rpcUrl?: string;
  rugcheckUrl?: string;
  pumpWsUrl: string;
  bitqueryKey?: string;
  /** In-flight enrichments. Default 8, clamped 1–16 by config. */
  enrichConcurrency?: number;
  /** Pending sightings before the oldest is dropped. Default 160. */
  queueCap?: number;
  /** Helius DAS pages past the 20-account RPC cap. Ignored on a public RPC. */
  holderPagesMax?: number;
  fetchImpl?: typeof fetch;
  /** v12.1 shared request budget. Without it (unit tests) calls go straight to fetchImpl. */
  net?: NetLimiter;
  onStatus: (patch: Partial<FeedStatus>) => void;
}

/**
 * Scout is the only publisher of `scout.candidate`.
 * Live sightings are enriched, then handed to Filter. They never skip ahead.
 */
export class Scout {
  private seen = new Map<string, { state: "queued" | "done"; volume: number; refreshes: number }>();
  private queue: RawSighting[] = [];
  private inflight = new Map<string, RawSighting>();
  private active = 0;
  private stopped = false;
  private readonly concurrency: number;
  private readonly queueCap: number;
  private pump: WebSocket | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private readonly timers: NodeJS.Timeout[] = [];
  private sources: ScoutSources = { ...DEFAULT_SCOUT_SOURCES };
  readonly status: FeedStatus;
  readonly health = new FeedHealth();
  private readonly goneUntil = new Map<SourceId, number>();
  private readonly listFetch: typeof fetch;
  private readonly enrichFetch: typeof fetch | undefined;
  private readonly batcher: DexTokenBatcher | null;

  constructor(private readonly opts: ScoutOptions) {
    this.concurrency = clampInt(opts.enrichConcurrency, 8, 1, 16);
    this.queueCap = clampInt(opts.queueCap, 160, 1, 2000);
    this.listFetch = opts.net ? opts.net.fetchAt(2) : opts.fetchImpl ?? fetch;
    this.enrichFetch = opts.net ? opts.net.fetchAt(1) : opts.fetchImpl;
    this.batcher = opts.net ? new DexTokenBatcher(opts.net.fetchAt(1)) : null;
    this.status = {
      mode: opts.feedMode,
      demo: opts.demo,
      pumpConnected: false,
      dexLastPollAt: null,
      geckoLastPollAt: null,
      jupiterLastPollAt: null,
      bitqueryLastPollAt: null,
      sightings: 0,
      enriched: 0,
      dropped: 0
    };
  }

  start(): void {
    if (this.opts.feedMode === "replay") return;
    this.connectPump();
    this.every(0, SCOUT_POLL_MS.dexProfiles, () => this.pollDexList("https://api.dexscreener.com/token-profiles/latest/v1"));
    this.every(2_000, SCOUT_POLL_MS.dexBoostsLatest, () => this.pollDexList("https://api.dexscreener.com/token-boosts/latest/v1"));
    this.every(4_000, SCOUT_POLL_MS.dexBoostsTop, () => this.pollDexList("https://api.dexscreener.com/token-boosts/top/v1"));
    this.every(6_000, SCOUT_POLL_MS.dexTakeovers, () => this.pollDexList("https://api.dexscreener.com/community-takeovers/latest/v1"));
    this.every(1_000, SCOUT_POLL_MS.geckoNew, () => this.pollGecko("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1"));
    this.every(16_000, SCOUT_POLL_MS.geckoTrending, () => this.pollGecko("https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1"));
    this.every(3_000, SCOUT_POLL_MS.jupiterRecent, () => this.pollJupiter());
    if (this.opts.bitqueryKey) {
      this.every(5_000, SCOUT_POLL_MS.bitquery, () => this.pollBitquery());
    }
    this.every(7_000, SCOUT_POLL_MS.dexPaprikaNew, () => this.pollDexPaprika(DEXPAPRIKA_NEW_URL));
    this.every(37_000, SCOUT_POLL_MS.dexPaprikaTop, () => this.pollDexPaprika(DEXPAPRIKA_TOP_URL));
  }

  /** Pump stays on. The other polls read these flags on each tick, so a save takes effect without a restart. */
  setSources(next: Partial<ScoutSources>): void {
    this.sources = { ...this.sources, ...next };
  }

  stop(): void {
    this.stopped = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
    this.pump?.close();
  }

  private every(delayMs: number, everyMs: number, fn: () => Promise<void>): void {
    const kick = setTimeout(() => {
      if (this.stopped) return;
      void fn();
      const interval = setInterval(() => {
        if (!this.stopped) void fn();
      }, everyMs);
      this.timers.push(interval);
    }, delayMs);
    this.timers.push(kick);
  }

  /** Replay and tests enter here — the same topic live enrichment publishes. */
  publish(token: DeskEvents["scout.candidate"]): void {
    this.opts.bus.emit("scout.candidate", token);
  }

  tick(
    mint: string,
    priceUsd: number,
    origin?: { feed?: string; pairAddress?: string; dex?: string; liquidityUsd?: number }
  ): void {
    this.opts.bus.emit("market.tick", { mint, priceUsd, at: Date.now(), ...origin });
  }

  ingest(raw: RawSighting, origin?: SourceId): void {
    const mint = raw.mint.trim();
    if (!mint) return;
    raw.mint = mint;
    const hint = raw.volume1hUsd ?? 0;
    const prior = this.seen.get(mint);
    if (prior) {
      if (prior.state === "queued") {
        const target = this.queue.find((item) => item.mint === mint) ?? this.inflight.get(mint);
        if (target && hint > (target.volume1hUsd ?? 0)) {
          target.volume1hUsd = hint;
          if ((raw.priceUsd ?? 0) > (target.priceUsd ?? 0)) target.priceUsd = raw.priceUsd;
          if ((raw.liquidityUsd ?? 0) > (target.liquidityUsd ?? 0)) target.liquidityUsd = raw.liquidityUsd;
        }
        return;
      }
      if (!(hint > prior.volume && prior.volume <= 0 && prior.refreshes < 1)) return;
      prior.refreshes += 1;
      prior.state = "queued";
    } else {
      this.seen.set(mint, { state: "queued", volume: 0, refreshes: 0 });
      if (this.seen.size > 8000) {
        const first = this.seen.keys().next().value;
        if (first) this.seen.delete(first);
      }
    }
    this.status.sightings += 1;
    if (origin) this.health.sighting(origin);
    if (this.queue.length >= this.queueCap) {
      const dropped = this.queue.shift();
      if (dropped) this.seen.delete(dropped.mint);
      this.status.dropped += 1;
    }
    this.queue.push(raw);
    this.opts.onStatus({ ...this.status });
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const raw = this.queue.shift()!;
      this.inflight.set(raw.mint, raw);
      this.active += 1;
      void this.enrich(raw).finally(() => {
        this.inflight.delete(raw.mint);
        this.active -= 1;
        this.drain();
      });
    }
  }

  private async enrich(raw: RawSighting): Promise<void> {
    try {
      const token = await enrichSighting(raw, {
        rpcUrl: this.opts.rpcUrl,
        rugcheckUrl: this.opts.rugcheckUrl,
        fetchImpl: this.enrichFetch,
        holderPagesMax: this.opts.holderPagesMax,
        dexLookup: this.batcher ? (mint) => this.batcher!.get(mint) : undefined
      });
      const slot = this.seen.get(raw.mint);
      if (slot) {
        slot.state = "done";
        slot.volume = token.volume1hUsd;
      }
      this.status.enriched += 1;
      this.opts.onStatus({ ...this.status });
      this.publish(token);
    } catch (err) {
      // One coin failing to enrich is not a feed outage; it never reaches the banner.
      const slot = this.seen.get(raw.mint);
      if (slot) slot.state = "done";
      void err;
    }
  }

  private connectPump(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.pumpWsUrl);
    } catch (err) {
      this.health.fail("pump", err instanceof Error ? err.message : String(err));
      this.schedulePumpReconnect();
      return;
    }
    this.pump = ws;
    ws.on("open", () => {
      this.health.ok("pump");
      this.status.pumpConnected = true;
      this.opts.onStatus({ ...this.status });
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });
    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString()) as {
          mint?: string;
          symbol?: string;
          name?: string;
          traderPublicKey?: string;
          txType?: string;
        };
        if (!msg.mint) return;
        if (msg.txType && msg.txType !== "create") return;
        this.ingest({
          mint: msg.mint,
          symbol: msg.symbol,
          name: msg.name,
          source: "pumpfun",
          devWallet: msg.traderPublicKey,
          observedAt: Date.now()
        }, "pump");
      } catch {
        /* malformed frame */
      }
    });
    ws.on("close", () => {
      this.health.fail("pump", "stream closed, reconnecting");
      this.status.pumpConnected = false;
      this.opts.onStatus({ ...this.status });
      this.schedulePumpReconnect();
    });
    ws.on("error", (err) => {
      this.health.fail("pump", err instanceof Error ? err.message : String(err));
      this.status.pumpConnected = false;
      this.opts.onStatus({ ...this.status });
    });
  }

  private schedulePumpReconnect(): void {
    if (this.stopped) return;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.connectPump(), 5_000);
  }

  private pollDexList(url: string): Promise<void> {
    if (!this.sources.dexscreener) return Promise.resolve();
    return this.poll("dexscreener", url, parseDexListings, () => {
      this.status.dexLastPollAt = Date.now();
    });
  }

  private pollGecko(url: string): Promise<void> {
    if (!this.sources.gecko) return Promise.resolve();
    return this.poll("gecko", url, parseGeckoPools, () => {
      this.status.geckoLastPollAt = Date.now();
    });
  }

  private pollJupiter(): Promise<void> {
    if (!this.sources.jupiter) return Promise.resolve();
    return this.poll("jupiter", JUPITER_RECENT_URL, parseJupiterRecent, () => {
      this.status.jupiterLastPollAt = Date.now();
    });
  }

  private pollDexPaprika(url: string): Promise<void> {
    if (!this.sources.dexpaprika) return Promise.resolve();
    return this.poll("dexpaprika", url, parseDexPaprika, () => undefined);
  }

  /**
   * One list poll through the shared budget. A bucket that is backing off is skipped
   * (no queue pile-up). HTTP 410 marks the source down and re-checks every 30 minutes.
   */
  private async poll(id: SourceId, url: string, parse: (body: unknown) => RawSighting[], onOk: () => void, init?: RequestInit): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    if ((this.goneUntil.get(id) ?? 0) > now) return;
    const spec = bucketFor(url);
    if (spec && this.opts.net?.pausedUntil(spec)) return;
    try {
      const res = await this.http(url, init);
      if (this.markUnavailable(id, res.status)) return;
      if (!res.ok) {
        this.health.fail(id, `HTTP ${res.status}`);
        return;
      }
      const rows = parse(await res.json());
      this.goneUntil.delete(id);
      this.health.ok(id);
      onOk();
      this.opts.onStatus({ ...this.status });
      for (const row of rows) this.ingest(row, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.health.fail(id, /abort|timeout/i.test(message) ? "timed out" : message.slice(0, 80));
    }
  }

  /**
   * HTTP 410 (endpoint removed) and 401/402/403 (key or plan rejected) will not fix
   * themselves in two minutes: show the source as down, re-check every 30 minutes, no banner.
   */
  private markUnavailable(id: SourceId, status: number): boolean {
    const reason =
      status === 410 ? "endpoint removed (HTTP 410)" : status === 401 || status === 402 || status === 403 ? `key or plan rejected (HTTP ${status})` : null;
    if (!reason) return false;
    this.goneUntil.set(id, Date.now() + GONE_RECHECK_MS);
    this.health.unavailable(id, reason);
    return true;
  }

  private http(url: string, init?: RequestInit): Promise<Response> {
    return this.listFetch(url, {
      ...init,
      headers: { accept: "application/json", "user-agent": "night-desk/1.0", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(8000)
    });
  }

  /**
   * Live per-source status for the snapshot. `lastError` is the banner text and is only
   * set when a source that is on has failed for 2+ minutes straight.
   */
  report(now = Date.now()): Pick<FeedStatus, "sources" | "budgets" | "lastError"> {
    const budgets = this.opts.net?.stats() ?? [];
    const replay = this.opts.feedMode === "replay";
    const sources = SOURCE_ORDER.map((id) => {
      const enabled =
        !replay &&
        (id === "pump" ? true : id === "bitquery" ? this.sources.bitquery && Boolean(this.opts.bitqueryKey) : this.sources[id]);
      const idleReason = replay ? "replay mode" : id === "bitquery" && !this.opts.bitqueryKey ? "no API key" : "turned off";
      return this.health.status(id, { enabled, idleReason, buckets: budgets, connected: id === "pump" ? this.status.pumpConnected : undefined, now });
    });
    return { sources, budgets, lastError: this.health.banner(sources, now) };
  }

  /**
   * Optional Bitquery poll. Requires BITQUERY_API_KEY. Failures stay on the feed status
   * and never block PumpPortal or DexScreener.
   */
  private async pollBitquery(): Promise<void> {
    if (this.stopped || !this.opts.bitqueryKey || !this.sources.bitquery) return;
    const query = `
      query {
        Solana {
          DEXTrades(limit: { count: 25 }, orderBy: { descending: Block_Time }) {
            Trade {
              Buy { Currency { MintAddress Symbol Name } }
            }
          }
        }
      }`;
    const spec = bucketFor("https://streaming.bitquery.io/graphql");
    if (spec && this.opts.net?.pausedUntil(spec)) return;
    if ((this.goneUntil.get("bitquery") ?? 0) > Date.now()) return;
    try {
      const res = await this.http("https://streaming.bitquery.io/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.bitqueryKey}`
        },
        body: JSON.stringify({ query })
      });
      if (this.markUnavailable("bitquery", res.status)) return;
      if (!res.ok) {
        this.health.fail("bitquery", `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as {
        data?: { Solana?: { DEXTrades?: Array<{ Trade?: { Buy?: { Currency?: { MintAddress?: string; Symbol?: string; Name?: string } } } }> } };
      };
      this.health.ok("bitquery");
      this.status.bitqueryLastPollAt = Date.now();
      this.opts.onStatus({ ...this.status });
      const trades = body.data?.Solana?.DEXTrades ?? [];
      for (const trade of trades) {
        const cur = trade.Trade?.Buy?.Currency;
        if (!cur?.MintAddress) continue;
        this.ingest({
          mint: cur.MintAddress,
          symbol: cur.Symbol,
          name: cur.Name,
          source: "raydium",
          observedAt: Date.now()
        }, "bitquery");
      }
    } catch (err) {
      this.health.fail("bitquery", err instanceof Error ? err.message.slice(0, 80) : String(err));
    }
  }
}

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  const n = raw == null || !Number.isFinite(raw) ? fallback : Math.floor(raw);
  return Math.min(max, Math.max(min, n));
}
