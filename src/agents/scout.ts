import WebSocket from "ws";
import type { EventBus } from "../bus.js";
import { enrichSighting } from "../market/enrich.js";
import { parseDexListings, parseDexPaprika, parseGeckoPools, parseJupiterRecent } from "../market/listings.js";
import type { DeskEvents, FeedStatus, RawSighting } from "../types.js";

/** How often each live listing feed is polled. Pump stays on its websocket. */
export const SCOUT_POLL_MS = {
  dexProfiles: 20_000,
  dexBoostsLatest: 20_000,
  dexBoostsTop: 45_000,
  dexTakeovers: 60_000,
  geckoNew: 15_000,
  geckoTrending: 30_000,
  jupiterRecent: 20_000,
  bitquery: 30_000
} as const;

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

  constructor(private readonly opts: ScoutOptions) {
    this.concurrency = clampInt(opts.enrichConcurrency, 8, 1, 16);
    this.queueCap = clampInt(opts.queueCap, 160, 1, 2000);
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
    this.every(8_000, SCOUT_POLL_MS.geckoTrending, () => this.pollGecko("https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1"));
    this.every(3_000, SCOUT_POLL_MS.jupiterRecent, () => this.pollJupiter());
    if (this.opts.bitqueryKey) {
      this.every(5_000, SCOUT_POLL_MS.bitquery, () => this.pollBitquery());
    }
    this.every(7_000, 20_000, () => this.pollDexPaprika());
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

  ingest(raw: RawSighting): void {
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
        fetchImpl: this.opts.fetchImpl,
        holderPagesMax: this.opts.holderPagesMax
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
      const message = err instanceof Error ? err.message : String(err);
      this.status.lastError = message;
      this.opts.onStatus({ ...this.status });
    }
  }

  private connectPump(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.pumpWsUrl);
    } catch (err) {
      this.noteError(err);
      this.schedulePumpReconnect();
      return;
    }
    this.pump = ws;
    ws.on("open", () => {
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
        });
      } catch {
        /* malformed frame */
      }
    });
    ws.on("close", () => {
      this.status.pumpConnected = false;
      this.opts.onStatus({ ...this.status });
      this.schedulePumpReconnect();
    });
    ws.on("error", (err) => {
      this.noteError(err);
      this.status.pumpConnected = false;
      this.opts.onStatus({ ...this.status });
    });
  }

  private schedulePumpReconnect(): void {
    if (this.stopped) return;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.connectPump(), 5_000);
  }

  private async pollDexList(url: string): Promise<void> {
    if (this.stopped || !this.sources.dexscreener) return;
    try {
      const res = await this.http(url);
      if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
      const rows = parseDexListings(await res.json());
      this.status.dexLastPollAt = Date.now();
      this.opts.onStatus({ ...this.status });
      for (const row of rows) this.ingest(row);
    } catch (err) {
      this.noteError(err);
    }
  }

  private async pollGecko(url: string): Promise<void> {
    if (this.stopped || !this.sources.gecko) return;
    try {
      const res = await this.http(url);
      if (!res.ok) throw new Error(`geckoterminal HTTP ${res.status}`);
      const rows = parseGeckoPools(await res.json());
      this.status.geckoLastPollAt = Date.now();
      this.opts.onStatus({ ...this.status });
      for (const row of rows) this.ingest(row);
    } catch (err) {
      this.noteError(err);
    }
  }

  private async pollJupiter(): Promise<void> {
    if (this.stopped || !this.sources.jupiter) return;
    try {
      const res = await this.http("https://lite-api.jup.ag/tokens/v2/recent");
      if (!res.ok) throw new Error(`jupiter HTTP ${res.status}`);
      const rows = parseJupiterRecent(await res.json());
      this.status.jupiterLastPollAt = Date.now();
      this.opts.onStatus({ ...this.status });
      for (const row of rows) this.ingest(row);
    } catch (err) {
      this.noteError(err);
    }
  }

  private http(url: string, init?: RequestInit): Promise<Response> {
    const impl = this.opts.fetchImpl ?? fetch;
    return impl(url, {
      ...init,
      headers: { accept: "application/json", "user-agent": "night-desk/1.0", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(6000)
    });
  }

  /**
   * Optional Bitquery poll. Requires BITQUERY_API_KEY. Failures stay on the feed status
   * and never block PumpPortal or DexScreener.
   */
  private async pollDexPaprika(): Promise<void> {
    if (this.stopped || !this.sources.dexpaprika) return;
    try {
      const res = await this.http("https://api.dexpaprika.com/networks/solana/pools?limit=25&orderBy=volume_usd&sort=desc");
      if (!res.ok) throw new Error(`dexpaprika HTTP ${res.status}`);
      const rows = parseDexPaprika(await res.json());
      for (const row of rows) this.ingest(row);
    } catch (err) {
      this.noteError(err);
    }
  }

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
    try {
      const res = await this.http("https://streaming.bitquery.io/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.bitqueryKey}`
        },
        body: JSON.stringify({ query })
      });
      if (!res.ok) throw new Error(`bitquery HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: { Solana?: { DEXTrades?: Array<{ Trade?: { Buy?: { Currency?: { MintAddress?: string; Symbol?: string; Name?: string } } } }> } };
      };
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
        });
      }
    } catch (err) {
      this.noteError(err);
    }
  }

  private noteError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.status.lastError = message;
    this.opts.onStatus({ ...this.status });
  }
}

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  const n = raw == null || !Number.isFinite(raw) ? fallback : Math.floor(raw);
  return Math.min(max, Math.max(min, n));
}
