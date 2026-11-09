import WebSocket from "ws";
import type { EventBus } from "../bus.js";
import { EnrichDeferred, EnrichMeter, enrichSighting, isHeliusUrl, rpcHostname } from "../market/enrich.js";
import { DexTokenBatcher } from "../market/dex-batch.js";
import { classifyHttpFailure, isPumpDiscoveryUrl, PUMP_API_CHALLENGE } from "../market/http-class.js";
import { bucketFor, type NetLimiter, type SourceId } from "../market/net.js";
import { FeedHealth, SOURCE_ORDER } from "./feed-health.js";
import {
  LAUNCHLAB_NEW_URL,
  PUMP_API_NEW_URL,
  parseDexListings,
  parseDexPaprika,
  parseGeckoPools,
  parseJupiterRecent,
  parseLaunchLabList,
  parsePumpApiCoins
} from "../market/listings.js";
import { draftFromRaw, type RawTapeRow } from "../desk/raw-tape.js";
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
  bitquery: 30_000,
  pumpApi: 10_000,
  launchLab: 15_000
} as const;

/** v13.3 Pump stream watchdog: no message for this long marks the stream stale and reconnects. */
export const PUMP_STALE_MS = 60_000;
export const PUMP_WATCHDOG_EVERY_MS = 10_000;
export const PUMP_BACKOFF_MIN_MS = 2_000;
export const PUMP_BACKOFF_MAX_MS = 60_000;

/** The small part of a WebSocket the Pump stream uses, so tests can inject a fake. */
export interface PumpSocket {
  on(event: "open", fn: () => void): unknown;
  on(event: "message", fn: (buf: { toString(): string }) => void): unknown;
  on(event: "close", fn: () => void): unknown;
  on(event: "error", fn: (err: unknown) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?: () => void;
}

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
  /** Pump.fun HTTP coin list. The host is challenged, so the poll does not run. */
  pumpapi: boolean;
  /** v13.3 Raydium LaunchLab newest launches (Bonk.fun and friends), keyless. */
  launchlab: boolean;
}

export const DEFAULT_SCOUT_SOURCES: ScoutSources = {
  dexscreener: true,
  gecko: true,
  jupiter: true,
  dexpaprika: false,
  bitquery: true,
  pumpapi: true,
  launchlab: true
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
  /** Helius DAS pages. Default 0. Ignored unless the enrich RPC is Helius. */
  holderPagesMax?: number;
  fetchImpl?: typeof fetch;
  /** v12.1 shared request budget. Without it (unit tests) calls go straight to fetchImpl. */
  net?: NetLimiter;
  onStatus: (patch: Partial<FeedStatus>) => void;
  /** v13.3 desk log line for watchdog events (stale, reconnect, back). */
  onLog?: (message: string, code: "PUMP_STALE" | "PUMP_RECONNECT" | "PUMP_BACK") => void;
  /** Test hook. Defaults to a real `ws` WebSocket. */
  pumpSocketFactory?: (url: string) => PumpSocket;
  /** Test hook. Default PUMP_STALE_MS. */
  pumpStaleMs?: number;
  /**
   * v13.27 one lightweight Tape row per sighting. Called synchronously, before enrich.
   * Must not fetch. `queue_full` is a sighting dropped before enrich; the row stays.
   */
  onTape?: (row: RawTapeRow) => void;
  /**
   * Every raw PumpPortal frame, on the socket Scout already opened.
   * Pump core listens here. It must not open a second PumpPortal socket.
   */
  onPumpFrame?: (text: string) => void;
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
  private pump: PumpSocket | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private pumpWatchdog: NodeJS.Timeout | null = null;
  /** Last frame of any kind from the Pump stream (create, migrate, or ack). */
  private pumpLastMsgAt: number | null = null;
  private pumpStale: string | null = null;
  private pumpBackoffMs = PUMP_BACKOFF_MIN_MS;
  private pumpReconnects = 0;
  private readonly timers: NodeJS.Timeout[] = [];
  private sources: ScoutSources = { ...DEFAULT_SCOUT_SOURCES };
  readonly status: FeedStatus;
  readonly health = new FeedHealth();
  private readonly goneUntil = new Map<SourceId, number>();
  private readonly listFetch: typeof fetch;
  private readonly enrichFetch: typeof fetch | undefined;
  private readonly batcher: DexTokenBatcher | null;
  private readonly meter = new EnrichMeter();
  private holdUntil = 0;
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ScoutOptions) {
    this.concurrency = clampInt(opts.enrichConcurrency, 8, 1, 16);
    this.queueCap = clampInt(opts.queueCap, 160, 1, 2000);
    this.listFetch = opts.net ? opts.net.fetchAt(2) : opts.fetchImpl ?? fetch;
    this.enrichFetch = opts.net ? opts.net.fetchEnrich() : opts.fetchImpl;
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
    this.pumpWatchdog = setInterval(() => this.checkPumpWatchdog(), PUMP_WATCHDOG_EVERY_MS);
    this.every(500, SCOUT_POLL_MS.pumpApi, () => this.pollPumpApi());
    this.every(1_500, SCOUT_POLL_MS.launchLab, () => this.pollLaunchLab());
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

  /** Hostname of SOLANA_RPC_URL and enrich RPC calls in the last minute. No key, no path. */
  enrichStatus(now = Date.now()): { host: string | null; callsPerMin: number } {
    return { host: rpcHostname(this.opts.rpcUrl), callsPerMin: this.meter.callsPerMin(now) };
  }

  stop(): void {
    this.stopped = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.pumpWatchdog) clearInterval(this.pumpWatchdog);
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
    // The Tape row is the sighting itself. Enrichment is still queued below and does not block this.
    this.opts.onTape?.(draftFromRaw(raw, "pending"));
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
      const dropped = this.queue.splice(worstIndex(this.queue), 1)[0];
      if (dropped) {
        this.seen.delete(dropped.mint);
        this.opts.onTape?.(draftFromRaw(dropped, "queue_full"));
      }
      this.status.dropped += 1;
    }
    this.queue.push(raw);
    this.opts.onStatus({ ...this.status });
    this.drain();
  }

  private drain(): void {
    if (Date.now() < this.holdUntil) {
      this.ensureHoldTimer();
      return;
    }
    while (this.active < this.concurrency && this.queue.length) {
      const raw = this.queue.splice(bestIndex(this.queue), 1)[0]!;
      this.inflight.set(raw.mint, raw);
      this.active += 1;
      void this.enrich(raw).finally(() => {
        this.inflight.delete(raw.mint);
        this.active -= 1;
        this.drain();
      });
    }
  }

  /** Provider 429 or error: leave the Tape row pending and try again after the pause. Never a Helius read. */
  private defer(raw: RawSighting, retryMs: number): void {
    const slot = this.seen.get(raw.mint);
    if (slot) slot.state = "queued";
    if (!this.queue.some((item) => item.mint === raw.mint)) {
      if (this.queue.length >= this.queueCap) {
        const idx = worstIndex(this.queue);
        const dropped = this.queue[idx];
        if (dropped && enrichBefore(raw, dropped) > 0) {
          this.seen.delete(raw.mint);
          this.opts.onTape?.(draftFromRaw(raw, "queue_full"));
          this.status.dropped += 1;
          return;
        }
        this.queue.splice(idx, 1);
        if (dropped) {
          this.seen.delete(dropped.mint);
          this.opts.onTape?.(draftFromRaw(dropped, "queue_full"));
        }
        this.status.dropped += 1;
      }
      this.queue.push(raw);
    }
    const at = Date.now() + Math.max(250, retryMs);
    if (at > this.holdUntil) {
      this.holdUntil = at;
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
    }
    this.ensureHoldTimer();
  }

  /** Arm a wake-up for `holdUntil`. A longer pause replaces a timer that would fire too soon. */
  private ensureHoldTimer(): void {
    if (this.holdTimer || this.stopped) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.stopped) this.drain();
    }, Math.max(1, this.holdUntil - Date.now()));
  }

  private async enrich(raw: RawSighting): Promise<void> {
    try {
      const token = await enrichSighting(raw, {
        rpcUrl: this.opts.rpcUrl,
        fetchImpl: this.enrichFetch,
        holderPagesMax: this.isHeliusEnrich() ? this.opts.holderPagesMax : 0,
        meter: this.meter,
        dexLookup: this.batcher ? (mint) => this.batcher!.get(mint) : undefined
      });
      const slot = this.seen.get(raw.mint);
      if (slot) {
        slot.state = "done";
        slot.volume = token.volume1hUsd;
      }
      this.status.enriched += 1;
      this.opts.onStatus({ ...this.status });
      this.opts.onTape?.(
        draftFromRaw(
          {
            ...raw,
            symbol: token.symbol,
            name: token.name,
            priceUsd: token.priceUsd > 0 ? token.priceUsd : raw.priceUsd,
            volume1hUsd: token.volume1hUsd > 0 ? token.volume1hUsd : raw.volume1hUsd,
            liquidityUsd: token.liquidityUsd > 0 ? token.liquidityUsd : raw.liquidityUsd,
            marketCapUsd: token.marketCapUsd ?? raw.marketCapUsd
          },
          "enriched"
        )
      );
      this.publish(token);
    } catch (err) {
      if (err instanceof EnrichDeferred) {
        this.defer(raw, err.retryMs);
        return;
      }
      // One coin failing to enrich is not a feed outage; it never reaches the banner.
      const slot = this.seen.get(raw.mint);
      if (slot) slot.state = "done";
    }
  }

  private isHeliusEnrich(): boolean {
    return isHeliusUrl(this.opts.rpcUrl);
  }

  private pumpFrameHook: ((text: string) => void) | null = null;

  /** Swap the pump-frame listener after construction (the desk builds the feed later). */
  setPumpFrameHook(fn: ((text: string) => void) | null): void {
    this.pumpFrameHook = fn;
  }

  /** Exposed for tests: the Pump stream socket currently in use. */
  get pumpSocket(): PumpSocket | null {
    return this.pump;
  }

  private connectPump(): void {
    if (this.stopped) return;
    let ws: PumpSocket;
    try {
      ws = this.opts.pumpSocketFactory ? this.opts.pumpSocketFactory(this.opts.pumpWsUrl) : (new WebSocket(this.opts.pumpWsUrl) as unknown as PumpSocket);
    } catch (err) {
      this.health.fail("pump", err instanceof Error ? err.message : String(err));
      this.schedulePumpReconnect();
      return;
    }
    this.pump = ws;
    ws.on("open", () => {
      if (this.pump !== ws) return;
      this.status.pumpConnected = true;
      // The watchdog clock starts at open: an open socket that never speaks still goes stale.
      this.pumpLastMsgAt = Date.now();
      this.opts.onStatus({ ...this.status });
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      // v13.3: graduations to PumpSwap ride the same free socket.
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    });
    ws.on("message", (buf) => {
      if (this.pump !== ws) return;
      this.notePumpMessage();
      const raw = buf.toString();
      try {
        (this.pumpFrameHook ?? this.opts.onPumpFrame)?.(raw);
      } catch {
        /* the pump tab never takes the scout feed down with it */
      }
      try {
        const msg = JSON.parse(raw) as {
          mint?: string;
          symbol?: string;
          name?: string;
          traderPublicKey?: string;
          txType?: string;
        };
        if (!msg.mint) return;
        if (msg.txType && msg.txType !== "create" && msg.txType !== "migrate") return;
        this.ingest({
          mint: msg.mint,
          symbol: msg.symbol,
          name: msg.name,
          source: "pumpfun",
          devWallet: msg.txType === "migrate" ? undefined : msg.traderPublicKey,
          observedAt: Date.now()
        }, "pump");
      } catch {
        /* malformed frame */
      }
    });
    ws.on("close", () => {
      if (this.pump !== ws) return;
      this.pump = null;
      this.health.fail("pump", this.pumpStale ?? "stream closed, reconnecting");
      this.status.pumpConnected = false;
      this.opts.onStatus({ ...this.status });
      this.schedulePumpReconnect();
    });
    ws.on("error", (err) => {
      if (this.pump !== ws) return;
      this.health.fail("pump", err instanceof Error ? err.message : String(err));
      this.status.pumpConnected = false;
      this.opts.onStatus({ ...this.status });
    });
  }

  /** Any frame proves the stream is alive: lastOkAt follows the last message, not the last connect. */
  private notePumpMessage(now = Date.now()): void {
    this.pumpLastMsgAt = now;
    this.health.ok("pump", now);
    this.pumpBackoffMs = PUMP_BACKOFF_MIN_MS;
    if (this.pumpStale) {
      this.pumpStale = null;
      this.opts.onLog?.(`Pump stream back after ${this.pumpReconnects} reconnect${this.pumpReconnects === 1 ? "" : "s"}.`, "PUMP_BACK");
      this.pumpReconnects = 0;
    }
    if (!this.status.pumpConnected) {
      this.status.pumpConnected = true;
      this.opts.onStatus({ ...this.status });
    }
  }

  /**
   * v13.3 watchdog. A socket that is open but silent for 60s is not live: mark it stale,
   * log it, drop the socket, and reconnect with backoff (2s doubling to 60s).
   */
  checkPumpWatchdog(now = Date.now()): void {
    if (this.stopped || !this.pump || this.pumpLastMsgAt == null) return;
    const staleMs = this.opts.pumpStaleMs ?? PUMP_STALE_MS;
    const silent = now - this.pumpLastMsgAt;
    if (silent < staleMs) return;
    const secs = Math.round(silent / 1000);
    const first = this.pumpStale == null;
    this.pumpStale = `no message for ${secs}s, reconnecting`;
    this.health.fail("pump", this.pumpStale, now);
    this.status.pumpConnected = false;
    this.opts.onStatus({ ...this.status });
    if (first) this.opts.onLog?.(`Pump stream stale: no message for ${secs}s. Dropping the socket and reconnecting.`, "PUMP_STALE");
    const ws = this.pump;
    this.pump = null;
    try {
      if (ws.terminate) ws.terminate();
      else ws.close();
    } catch {
      /* already gone */
    }
    this.schedulePumpReconnect();
  }

  private schedulePumpReconnect(): void {
    if (this.stopped) return;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    const delay = this.pumpBackoffMs;
    this.pumpBackoffMs = Math.min(PUMP_BACKOFF_MAX_MS, this.pumpBackoffMs * 2);
    this.pumpReconnects += 1;
    if (this.pumpStale) this.opts.onLog?.(`Pump stream reconnect #${this.pumpReconnects} in ${Math.round(delay / 1000)}s.`, "PUMP_RECONNECT");
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      // The watchdog clock restarts with the new socket.
      this.pumpLastMsgAt = Date.now();
      this.connectPump();
    }, delay);
  }

  /** Exposed for tests. */
  get pumpReconnectDelayMs(): number {
    return this.pumpBackoffMs;
  }

  private pollPumpApi(): Promise<void> {
    if (!this.sources.pumpapi) return Promise.resolve();
    return this.poll("pumpapi", PUMP_API_NEW_URL, (body) => parsePumpApiCoins(body), () => undefined);
  }

  private pollLaunchLab(): Promise<void> {
    if (!this.sources.launchlab) return Promise.resolve();
    return this.poll("launchlab", LAUNCHLAB_NEW_URL, (body) => parseLaunchLabList(body), () => undefined);
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
    if (isPumpDiscoveryUrl(url)) {
      this.health.blocked(id, PUMP_API_CHALLENGE);
      return;
    }
    const now = Date.now();
    if ((this.goneUntil.get(id) ?? 0) > now) return;
    const spec = bucketFor(url);
    if (spec && this.opts.net?.pausedUntil(spec)) return;
    try {
      const res = await this.http(url, init);
      const text = await res.text();
      const failure = classifyHttpFailure(res.status, res.headers, text);
      if (failure) {
        if (failure.kind === "challenge") this.health.blocked(id, failure.detail);
        else this.health.unavailable(id, failure.detail);
        this.goneUntil.set(id, Date.now() + GONE_RECHECK_MS);
        return;
      }
      if (!res.ok) {
        this.health.fail(id, `HTTP ${res.status}`);
        return;
      }
      const rows = parse(JSON.parse(text) as unknown);
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
        id === "solana" ||
        (!replay &&
          (id === "pump" ? true : id === "bitquery" ? this.sources.bitquery && Boolean(this.opts.bitqueryKey) : this.sources[id as keyof ScoutSources]));
      const idleReason = replay ? "replay mode" : id === "bitquery" && !this.opts.bitqueryKey ? "no API key" : "turned off";
      return this.health.status(id, { enabled, idleReason, buckets: budgets, connected: id === "pump" ? this.status.pumpConnected : undefined, stale: id === "pump" ? this.pumpStale ?? undefined : undefined, now });
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
      const text = await res.text();
      const failure = classifyHttpFailure(res.status, res.headers, text);
      if (failure) {
        if (failure.kind === "challenge") this.health.blocked("bitquery", failure.detail);
        else this.health.unavailable("bitquery", failure.detail);
        this.goneUntil.set("bitquery", Date.now() + GONE_RECHECK_MS);
        return;
      }
      if (!res.ok) {
        this.health.fail("bitquery", `HTTP ${res.status}`);
        return;
      }
      const body = JSON.parse(text) as {
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

/** Positive when `b` should be enriched before `a`: newer sighting, then higher 1h volume. */
export function enrichBefore(a: RawSighting, b: RawSighting): number {
  const age = (b.observedAt || 0) - (a.observedAt || 0);
  if (age !== 0) return age;
  return (b.volume1hUsd || 0) - (a.volume1hUsd || 0);
}

function bestIndex(queue: RawSighting[]): number {
  let idx = 0;
  for (let i = 1; i < queue.length; i += 1) {
    if (enrichBefore(queue[idx]!, queue[i]!) > 0) idx = i;
  }
  return idx;
}

function worstIndex(queue: RawSighting[]): number {
  let idx = 0;
  for (let i = 1; i < queue.length; i += 1) {
    if (enrichBefore(queue[i]!, queue[idx]!) > 0) idx = i;
  }
  return idx;
}

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  const n = raw == null || !Number.isFinite(raw) ? fallback : Math.floor(raw);
  return Math.min(max, Math.max(min, n));
}
