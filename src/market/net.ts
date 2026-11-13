/**
 * v12.1 shared network budget. Every desk caller (Scout polls, enrichment, held-position
 * pricing, Add coin lookups, watchlist) goes through one NetLimiter, so callers that hit
 * the same API share one token bucket per rate-limit bucket.
 *
 * - Budgets sit at ~80% of each API's documented free limit.
 * - A 429 pauses that bucket: Retry-After when sent (or the API's own reset header),
 *   otherwise exponential backoff with jitter capped at 2 minutes. The refill rate is
 *   also halved and steps back up as requests succeed.
 * - Identical in-flight GETs share one request; successful GETs are cached briefly.
 * - Hosts without a known limit pass straight through (still counted).
 */

export type SourceId = "pump" | "dexscreener" | "gecko" | "jupiter" | "dexpaprika" | "bitquery" | "pumpapi" | "launchlab" | "solana";

/** Public cluster endpoint. Solana documents it as rate-limited and not for production apps. */
export const PUBLIC_SOLANA_RPC_HOST = "api.mainnet-beta.solana.com";

export interface BucketSpec {
  id: string;
  source: SourceId | "other";
  /** Documented free limit, requests per minute. */
  limitPerMin: number;
  /** What the desk lets itself use (~80% of the limit). */
  budgetPerMin: number;
  /** Tokens that can be spent back-to-back. budget + burst never exceeds the limit, so no 60s window can. */
  burst: number;
  /** Success cache for identical GETs. */
  cacheMs: number;
  note: string;
}

/**
 * Limits verified 2026-10-29:
 * - DexScreener docs: /tokens/v1, /latest/dex/tokens, /latest/dex/pairs = 300/min;
 *   token-profiles, token-boosts, community-takeovers = 60/min each.
 * - GeckoTerminal: FAQ says 30/min, API docs say ~10/min "may fluctuate", CoinGecko's
 *   keyless page says ~5/min shared per IP. Austin saw 429s at 6/min, so budget 4/min.
 *   Its endpoints are cached server-side for 60s, so faster polling gains nothing.
 * - Jupiter keyless: 0.5 rps = 30/min, 60s sliding window, one bucket for price,
 *   tokens and quotes (headers on lite-api showed 5 per 10s).
 * - DexPaprika: response headers ratelimit-limit 10 per window; budget 8/min.
 * - Bitquery free: 10/min; budget 8/min.
 * v13.3 (checked 2026-10-31, keyless):
 * - Pump.fun frontend-api-v3 /coins is not called (Cloudflare challenge). The bucket remains so a stray URL is still named.
 * - Raydium LaunchLab (Bonk.fun and other LaunchLab platforms) /get/list: no published limit
 *   and no rate headers, so stay polite at 8/min (desk polls 4/min).
 */
export const BUCKETS: BucketSpec[] = [
  { id: "dexscreener:pairs", source: "dexscreener", limitPerMin: 300, budgetPerMin: 240, burst: 10, cacheMs: 3_000, note: "/tokens/v1, /latest/dex/tokens, /latest/dex/pairs" },
  { id: "dexscreener:search", source: "dexscreener", limitPerMin: 25, budgetPerMin: 20, burst: 2, cacheMs: 30_000, note: "/latest/dex/search (v13.6 Add coin by ticker). Docs allow 300/min; the desk caps itself at 25 so Scout keeps its pairs budget" },
  { id: "dexscreener:profiles", source: "dexscreener", limitPerMin: 60, budgetPerMin: 48, burst: 3, cacheMs: 3_000, note: "/token-profiles/latest/v1" },
  { id: "dexscreener:boosts-latest", source: "dexscreener", limitPerMin: 60, budgetPerMin: 48, burst: 3, cacheMs: 3_000, note: "/token-boosts/latest/v1" },
  { id: "dexscreener:boosts-top", source: "dexscreener", limitPerMin: 60, budgetPerMin: 48, burst: 3, cacheMs: 3_000, note: "/token-boosts/top/v1" },
  { id: "dexscreener:takeovers", source: "dexscreener", limitPerMin: 60, budgetPerMin: 48, burst: 3, cacheMs: 3_000, note: "/community-takeovers/latest/v1" },
  { id: "gecko", source: "gecko", limitPerMin: 5, budgetPerMin: 4, burst: 1, cacheMs: 30_000, note: "keyless ~5/min per IP (docs: 10–30/min)" },
  { id: "jupiter", source: "jupiter", limitPerMin: 30, budgetPerMin: 24, burst: 4, cacheMs: 2_000, note: "keyless 0.5 rps, shared by price/tokens/quote" },
  { id: "dexpaprika", source: "dexpaprika", limitPerMin: 10, budgetPerMin: 8, burst: 1, cacheMs: 5_000, note: "ratelimit-limit 10" },
  { id: "bitquery", source: "bitquery", limitPerMin: 10, budgetPerMin: 8, burst: 1, cacheMs: 0, note: "free plan" },
  { id: "pumpapi", source: "pumpapi", limitPerMin: 60, budgetPerMin: 45, burst: 3, cacheMs: 3_000, note: "pump.fun frontend-api-v3, x-ratelimit-limit 60" },
  { id: "launchlab", source: "launchlab", limitPerMin: 10, budgetPerMin: 8, burst: 1, cacheMs: 5_000, note: "Raydium LaunchLab list (Bonk.fun), no published limit" },
  {
    id: "solana:public",
    source: "solana",
    limitPerMin: 12,
    budgetPerMin: 9,
    burst: 2,
    cacheMs: 8_000,
    note: "api.mainnet-beta.solana.com background reads only (priority 0): getBalance, getTokenAccountsByOwner, getMultipleAccounts. Published ceilings are 100 requests/10s per IP, 40/10s per method, and 40 concurrent, and they vary. The endpoint is not a production RPC. 9/min is the desk's own poll budget, not a claim the public endpoint will serve it. Held-account polls run every 10s, past this 8s cache, so a mark is not stuck on a 20s copy."
  },
  {
    id: "solana:public:exec",
    source: "solana",
    limitPerMin: 80,
    budgetPerMin: 64,
    burst: 16,
    cacheMs: 0,
    note: "Same public host, separate lane for swap preparation, simulation, and broadcast (priority 1). A full read-lane queue cannot delay these. Burst 16 covers one pump or Jupiter transaction. 64/min is still under the published 40 requests/10s per method. Nothing here is cached."
  },
  {
    id: "helius",
    source: "solana",
    limitPerMin: 13,
    budgetPerMin: 10,
    burst: 3,
    cacheMs: 0,
    note: "helius-rpc.com background polls (priority 0): getBalance, getTokenAccountsByOwner, getMultipleAccounts. Wallet SOL/USDC reads use priority -1 on this same lane so a mark queue cannot bury them. 10/min is a hard sliding-minute ceiling (burst 3 only when that minute still has room). Together with the exec lane the two reqLastMin counts never pass 18. The URL is not logged; it may carry an API key. Nothing is cached."
  },
  {
    id: "helius:exec",
    source: "solana",
    limitPerMin: 10,
    budgetPerMin: 8,
    burst: 2,
    cacheMs: 0,
    note: "Same Helius host, separate lane for swap preparation, simulation, and broadcast. 8/min is a hard sliding-minute ceiling, burst 2 only inside that minute. A full read-lane queue cannot delay these. Together with the read lane the two reqLastMin counts never pass 18. Nothing here is cached."
  },
  {
    id: "enrich",
    source: "solana",
    limitPerMin: 57,
    budgetPerMin: 45,
    burst: 8,
    cacheMs: 0,
    note: "Scout enrich reads on whatever host SOLANA_RPC_URL names, when that host is not Helius and not the public RPC. Default 45/min (about 15 coins). ENRICH_RPC_CALLS_PER_MIN moves the budget. A hard ceiling of 20 requests/second still applies. 429 and 5xx pause this lane only. The sighting stays pending. Nothing here is sent to a Helius lane."
  }
];

/** Default enrich budget. About three reads per coin, so ~15 coins/min. */
export const ENRICH_CALLS_PER_MIN_DEFAULT = 45;
/** Hard ceiling for the enrich lane. Not a Helius cap. */
export const ENRICH_RPS_CAP = 20;
/** Consecutive 429s or 5xxs before the enrich host is paused. */
export const ENRICH_CIRCUIT_FAILS = 3;
/** How long a tripped enrich host stays paused. */
export const ENRICH_CIRCUIT_MS = 15_000;

const ENRICH_BUCKET_ID = "enrich";

/** Budget for the enrich lane. Never above 20 requests/second on average, and burst stays inside that. */
export function enrichLaneBudget(callsPerMin: number): { limitPerMin: number; budgetPerMin: number; burst: number } {
  const raw = Number.isFinite(callsPerMin) ? Math.floor(callsPerMin) : ENRICH_CALLS_PER_MIN_DEFAULT;
  const budgetPerMin = Math.min(ENRICH_RPS_CAP * 60, Math.max(1, raw));
  const limitPerMin = Math.max(budgetPerMin + 1, Math.ceil(budgetPerMin / 0.8));
  const burst = Math.min(8, ENRICH_RPS_CAP, limitPerMin - budgetPerMin);
  return { limitPerMin, budgetPerMin, burst: Math.max(1, burst) };
}

const BY_ID = new Map(BUCKETS.map((b) => [b.id, b]));

export function bucketFor(url: string): BucketSpec | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname;
  const path = u.pathname;
  if (host === "api.dexscreener.com") {
    if (path.startsWith("/latest/dex/search")) return BY_ID.get("dexscreener:search")!;
    if (path.startsWith("/token-profiles/")) return BY_ID.get("dexscreener:profiles")!;
    if (path.startsWith("/token-boosts/top")) return BY_ID.get("dexscreener:boosts-top")!;
    if (path.startsWith("/token-boosts/")) return BY_ID.get("dexscreener:boosts-latest")!;
    if (path.startsWith("/community-takeovers/")) return BY_ID.get("dexscreener:takeovers")!;
    return BY_ID.get("dexscreener:pairs")!;
  }
  if (host === "api.geckoterminal.com") return BY_ID.get("gecko")!;
  if (host === "lite-api.jup.ag" || host === "api.jup.ag" || host === "quote-api.jup.ag") return BY_ID.get("jupiter")!;
  if (host === "api.dexpaprika.com") return BY_ID.get("dexpaprika")!;
  if (host === "streaming.bitquery.io" || host === "graphql.bitquery.io") return BY_ID.get("bitquery")!;
  if (host === "frontend-api-v3.pump.fun") return BY_ID.get("pumpapi")!;
  if (host === "launch-mint-v1.raydium.io") return BY_ID.get("launchlab")!;
  if (host === PUBLIC_SOLANA_RPC_HOST) return BY_ID.get("solana:public")!;
  // Sender does not spend Helius credits and is not part of the 18/min cap.
  if (host === "sender.helius-rpc.com" || host.endsWith("-sender.helius-rpc.com")) return null;
  if (host === "helius-rpc.com" || host.endsWith(".helius-rpc.com")) return BY_ID.get("helius")!;
  return null;
}

/** Host of SOLANA_RPC_URL when enrich should use its own lane. Helius and the public RPC stay on their lanes. */
export function dedicatedEnrichHost(url: string | undefined | null): string | null {
  if (!url?.trim()) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === PUBLIC_SOLANA_RPC_HOST) return null;
  if (host === "helius-rpc.com" || host.endsWith(".helius-rpc.com") || host.endsWith(".helius.xyz")) return null;
  if (host === "sender.helius-rpc.com" || host.endsWith("-sender.helius-rpc.com")) return null;
  return host;
}

/** Read-lane hosts split polls from swap/simulate traffic. Null when this spec is not split. */
function execLaneId(id: string): string | null {
  if (id === "solana:public") return "solana:public:exec";
  if (id === "helius") return "helius:exec";
  return null;
}

export function rpcLane(spec: BucketSpec | null, priority: Priority | undefined, body: unknown): BucketSpec | null {
  if (!spec) return null;
  const pri = priority ?? 1;
  const execId = execLaneId(spec.id);
  if (!execId) return spec;
  // Safety and bundle reads share the existing read budget at the lowest priority.
  if (pri === 2 && typeof body === "string" && LOW_PRIORITY_READ.has(rpcMethod(body) ?? "")) return spec;
  // Wallet balance (-1) and mark polls (0) stay on the read lane. Higher priorities are the exec lane.
  if (pri > 0) return BY_ID.get(execId)!;
  if (typeof body === "string" && !SOLANA_POLL_METHODS.has(rpcMethod(body) ?? "")) return BY_ID.get(execId)!;
  return spec;
}

const RPC_METHOD = /"method"\s*:\s*"([A-Za-z]+)"/;

/** Background polls. Everything else on the public host, including getAccountInfo and getLatestBlockhash, uses the exec lane. */
const SOLANA_POLL_METHODS = new Set(["getBalance", "getTokenAccountsByOwner", "getMultipleAccounts"]);
/** Priority 2 only. Stays on the read lane so a mint check cannot take a swap slot. */
const LOW_PRIORITY_READ = new Set(["getAccountInfo", "getMultipleAccounts", "getSignaturesForAddress", "getTransaction", "getBlock"]);

export function rpcMethod(body: string): string | null {
  return RPC_METHOD.exec(body)?.[1] ?? null;
}

/** JSON-RPC reads may be cached. Sends and simulations may not. */
export function rpcReadMethod(body: string): string | null {
  const method = rpcMethod(body);
  if (!method || !method.startsWith("get") || method === "getProgramAccounts") return null;
  return method;
}

export function solanaExecSpec(): BucketSpec {
  return BY_ID.get("solana:public:exec")!;
}

/**
 * -1 = wallet SOL/USDC reads and manual Search / buy pre-checks (same read-lane budget, ahead of marks).
 * 0 = held-position marks and watch marks (never starve), 1 = enrichment, 2 = Scout list polls.
 */
export type Priority = -1 | 0 | 1 | 2;

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 120_000;
const MIN_RATE_FACTOR = 0.25;
const RATE_STEP_UP = 0.05;
const MAX_QUEUE = 200;
/**
 * v13.33 priority-0 Helius reads (marks). Wallet (-1) and the exec lane are outside this cap.
 * The 10/min and 8/min ceilings are unchanged.
 */
export const HELIUS_P0_QUEUE_MAX = 24;

/** Pubkeys inside a JSON-RPC body, used to collapse duplicate mark polls. */
const PUBKEY_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/**
 * Identity of a priority-0 Helius poll. Same mint set means the older queued call is stale.
 * Returns null when the body is not a background poll.
 */
export function heliusPollKey(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const method = rpcMethod(body);
  if (!method || !SOLANA_POLL_METHODS.has(method)) return null;
  const ids = body.match(PUBKEY_RE);
  if (!ids || ids.length === 0) return method;
  return `${method}:${[...new Set(ids)].sort().join(",")}`;
}

export interface NetClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  random: () => number;
}

const realClock: NetClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  random: () => Math.random()
};

interface Waiter {
  priority: Priority;
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
  /** Set once this waiter is granted a token or dropped, so a late abort cannot settle it twice. */
  settled: boolean;
  /** Set for priority-0 Helius polls so a newer read of the same accounts replaces this one. */
  key?: string;
}

interface CachedResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

export interface BucketStats {
  id: string;
  source: SourceId | "other";
  limitPerMin: number;
  budgetPerMin: number;
  /** Requests actually sent in the last 60s. */
  reqLastMin: number;
  cacheHitsLastMin: number;
  count429: number;
  /** HTTP 5xx on an enrich host. Other buckets stay at 0. */
  count5xx: number;
  /** Enrich host paused after repeated 429s or 5xxs. Helius lanes never set this. */
  circuitOpen: boolean;
  sent: number;
  rateFactor: number;
  pausedUntil: number | null;
  queued: number;
  note: string;
}

class Bucket {
  tokens: number;
  last: number;
  rateFactor = 1;
  pauseUntil = 0;
  backoffStep = 0;
  queue: Waiter[] = [];
  sentTimes: number[] = [];
  hitTimes: number[] = [];
  count429 = 0;
  count5xx = 0;
  consecutiveFail = 0;
  circuitUntil = 0;
  sent = 0;
  timer = false;

  constructor(readonly spec: BucketSpec, now: number) {
    this.tokens = spec.burst;
    this.last = now;
  }

  refill(now: number): void {
    const perMs = (this.spec.budgetPerMin * this.rateFactor) / 60_000;
    this.tokens = Math.min(this.spec.burst, this.tokens + (now - this.last) * perMs);
    this.last = now;
  }

  /** Requests sent in the trailing 60s. */
  windowCount(now: number): number {
    while (this.sentTimes.length && this.sentTimes[0]! <= now - 60_000) this.sentTimes.shift();
    return this.sentTimes.length;
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** A caller gave up while its request was still waiting for a token. The waiter is not sent. */
function abortedError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

export class NetLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly inflight = new Map<string, Promise<CachedResponse>>();
  private readonly cache = new Map<string, { at: number; res: CachedResponse }>();
  private seq = 0;
  private enrichHost: string | null = null;
  private readonly clock: NetClock;
  private readonly baseFetch: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch; clock?: Partial<NetClock>; specs?: BucketSpec[]; enrichRpcUrl?: string; enrichCallsPerMin?: number } = {}) {
    this.baseFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.clock = { ...realClock, ...(opts.clock ?? {}) };
    for (const spec of opts.specs ?? BUCKETS) this.buckets.set(spec.id, new Bucket(spec, this.clock.now()));
    if (opts.enrichRpcUrl || opts.enrichCallsPerMin != null) this.useEnrichRpc(opts.enrichRpcUrl, opts.enrichCallsPerMin);
  }

  /**
   * Point the enrich lane at SOLANA_RPC_URL. Helius and the public RPC keep their own lanes.
   * The host is stored as a hostname only. The key in the URL is not kept on the spec.
   */
  useEnrichRpc(url: string | undefined, callsPerMin = ENRICH_CALLS_PER_MIN_DEFAULT): void {
    this.enrichHost = dedicatedEnrichHost(url);
    const base = this.buckets.get(ENRICH_BUCKET_ID)?.spec ?? BY_ID.get(ENRICH_BUCKET_ID);
    if (!base) return;
    const budget = enrichLaneBudget(callsPerMin);
    this.buckets.set(ENRICH_BUCKET_ID, new Bucket({ ...base, ...budget }, this.clock.now()));
  }

  private specFor(url: string): BucketSpec | null {
    const known = bucketFor(url);
    if (known) return known;
    if (!this.enrichHost) return null;
    try {
      if (new URL(url).hostname.toLowerCase() !== this.enrichHost) return null;
    } catch {
      return null;
    }
    return this.buckets.get(ENRICH_BUCKET_ID)?.spec ?? null;
  }

  private bucket(spec: BucketSpec): Bucket {
    let b = this.buckets.get(spec.id);
    if (!b) {
      b = new Bucket(spec, this.clock.now());
      this.buckets.set(spec.id, b);
    }
    return b;
  }

  /** Wait for a token in this bucket. Lower priority number goes first. An aborted signal drops a waiter that is still queued. */
  acquire(spec: BucketSpec, priority: Priority = 1, coalesceKey?: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortedError());
    const b = this.bucket(spec);
    return new Promise<void>((resolve, reject) => {
      if (spec.id === "helius" && priority === 0) {
        this.shedHeliusPriority0(b, coalesceKey);
      }
      const waiter: Waiter = {
        priority,
        seq: this.seq++,
        key: coalesceKey,
        settled: false,
        resolve: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (err: Error) => {
          if (waiter.settled) return;
          waiter.settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        }
      };
      const onAbort = () => {
        if (waiter.settled) return;
        const idx = b.queue.indexOf(waiter);
        if (idx >= 0) b.queue.splice(idx, 1);
        waiter.reject(abortedError());
      };
      if (b.queue.length >= MAX_QUEUE) {
        // Shed the newest lowest-priority waiter so marks and lookups never wait behind a pile.
        const worst = b.queue.reduce((acc, w) => (w.priority > acc.priority || (w.priority === acc.priority && w.seq > acc.seq) ? w : acc));
        if (worst.priority < priority) {
          reject(new RateLimitError(`${spec.id} budget queue full`));
          return;
        }
        b.queue.splice(b.queue.indexOf(worst), 1);
        worst.reject(new RateLimitError(`${spec.id} budget queue full`));
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      b.queue.push(waiter);
      b.queue.sort((a, c) => a.priority - c.priority || a.seq - c.seq);
      this.pump(b);
    });
  }

  /**
   * Priority-0 Helius marks only. Drop an older queued call for the same accounts, then drop
   * the oldest mark until the lane is back under HELIUS_P0_QUEUE_MAX. Wallet (-1) and exec stay.
   */
  private shedHeliusPriority0(b: Bucket, coalesceKey: string | undefined): void {
    if (coalesceKey) {
      for (let i = b.queue.length - 1; i >= 0; i -= 1) {
        const waiter = b.queue[i]!;
        if (waiter.priority === 0 && waiter.key === coalesceKey) {
          b.queue.splice(i, 1);
          waiter.reject(new RateLimitError("helius dropped stale duplicate"));
        }
      }
    }
    while (b.queue.some((waiter) => waiter.priority === 0) && this.priority0Depth(b) >= HELIUS_P0_QUEUE_MAX) {
      let oldest = -1;
      let oldestSeq = Number.POSITIVE_INFINITY;
      for (let i = 0; i < b.queue.length; i += 1) {
        const waiter = b.queue[i]!;
        if (waiter.priority === 0 && waiter.seq < oldestSeq) {
          oldestSeq = waiter.seq;
          oldest = i;
        }
      }
      if (oldest < 0) break;
      const dropped = b.queue.splice(oldest, 1)[0]!;
      dropped.reject(new RateLimitError("helius priority-0 queue full"));
    }
  }

  private priority0Depth(b: Bucket): number {
    let depth = 0;
    for (const waiter of b.queue) if (waiter.priority === 0) depth += 1;
    return depth;
  }

  /**
   * Helius read (10) and exec (8) are hard sliding-minute ceilings. A full token bucket
   * must not push the pair past 18 reqLastMin (a minute of 11+8 was the leak).
   * Other hosts keep the token bucket they already had.
   */
  private heliusWait(b: Bucket, now: number): number {
    if (b.spec.id !== "helius" && b.spec.id !== "helius:exec") return 0;
    const own = b.windowCount(now);
    const other = this.buckets.get(b.spec.id === "helius" ? "helius:exec" : "helius");
    const otherCount = other?.windowCount(now) ?? 0;
    const combinedCap = b.spec.budgetPerMin + (other?.spec.budgetPerMin ?? 0);
    const blocked = own >= b.spec.budgetPerMin || own + otherCount >= combinedCap;
    if (!blocked) return 0;
    const oldest = [b.sentTimes[0], other?.sentTimes[0]].filter((t): t is number => t != null).sort((a, c) => a - c)[0];
    if (oldest == null) return 60_000;
    return Math.max(1, oldest + 60_000 + 1 - now);
  }

  /** Enrich lane only. At most ENRICH_RPS_CAP sends in any one second. Helius lanes do not use this. */
  private enrichRpsWait(b: Bucket, now: number): number {
    if (b.spec.id !== ENRICH_BUCKET_ID) return 0;
    let count = 0;
    let oldest = now;
    for (let i = b.sentTimes.length - 1; i >= 0; i -= 1) {
      const t = b.sentTimes[i]!;
      if (t <= now - 1000) break;
      count += 1;
      oldest = t;
    }
    if (count < ENRICH_RPS_CAP) return 0;
    return Math.max(1, oldest + 1000 - now);
  }

  private pump(b: Bucket): void {
    if (b.timer) return;
    const now = this.clock.now();
    b.refill(now);
    while (b.queue.length && now >= b.pauseUntil && b.tokens >= 1 && this.heliusWait(b, now) === 0 && this.enrichRpsWait(b, now) === 0) {
      b.tokens -= 1;
      b.sent += 1;
      b.sentTimes.push(now);
      b.queue.shift()!.resolve();
    }
    if (!b.queue.length) return;
    const perMs = (b.spec.budgetPerMin * b.rateFactor) / 60_000;
    const waitToken = b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / perMs);
    const wait = Math.max(waitToken, this.heliusWait(b, now), this.enrichRpsWait(b, now), b.pauseUntil - now, 1);
    b.timer = true;
    this.clock.setTimeout(() => {
      b.timer = false;
      this.pump(b);
    }, wait);
  }

  /** A 429 (or an exhausted rate-limit header) on this bucket. */
  note429(spec: BucketSpec, retryAfterMs: number | null): number {
    const b = this.bucket(spec);
    const now = this.clock.now();
    b.count429 += 1;
    b.rateFactor = Math.max(MIN_RATE_FACTOR, b.rateFactor * 0.5);
    b.tokens = Math.min(b.tokens, 0);
    let wait: number;
    if (retryAfterMs != null && retryAfterMs >= 0) {
      wait = Math.min(BACKOFF_CAP_MS, Math.max(500, retryAfterMs));
    } else {
      const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** b.backoffStep);
      const jitter = 0.75 + this.clock.random() * 0.5;
      wait = Math.min(BACKOFF_CAP_MS, Math.round(raw * jitter));
    }
    b.backoffStep = Math.min(b.backoffStep + 1, 10);
    b.pauseUntil = Math.max(b.pauseUntil, now + wait);
    b.consecutiveFail += 1;
    this.armCircuit(b, now);
    return b.circuitUntil > now ? Math.max(wait, b.circuitUntil - now) : wait;
  }

  /** HTTP 5xx on an enrich host. Same pause ladder as a 429, without counting it as a 429. */
  note5xx(spec: BucketSpec): number {
    if (spec.id !== ENRICH_BUCKET_ID) return 0;
    const b = this.bucket(spec);
    const now = this.clock.now();
    b.count5xx += 1;
    b.rateFactor = Math.max(MIN_RATE_FACTOR, b.rateFactor * 0.5);
    b.tokens = Math.min(b.tokens, 0);
    const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** b.backoffStep);
    const jitter = 0.75 + this.clock.random() * 0.5;
    const wait = Math.min(BACKOFF_CAP_MS, Math.round(raw * jitter));
    b.backoffStep = Math.min(b.backoffStep + 1, 10);
    b.pauseUntil = Math.max(b.pauseUntil, now + wait);
    b.consecutiveFail += 1;
    this.armCircuit(b, now);
    return b.circuitUntil > now ? b.circuitUntil - now : wait;
  }

  /** Repeated enrich-host failures pause that host. Helius lanes are not armed. */
  private armCircuit(b: Bucket, now: number): void {
    if (b.spec.id !== ENRICH_BUCKET_ID) return;
    if (b.consecutiveFail < ENRICH_CIRCUIT_FAILS) return;
    const until = Math.max(b.pauseUntil, now + ENRICH_CIRCUIT_MS);
    b.pauseUntil = until;
    b.circuitUntil = until;
  }

  /** A good answer: clear the backoff ladder and step the rate back toward full budget. */
  noteOk(spec: BucketSpec): void {
    const b = this.bucket(spec);
    b.backoffStep = 0;
    b.consecutiveFail = 0;
    b.circuitUntil = 0;
    if (b.rateFactor < 1) {
      b.refill(this.clock.now());
      b.rateFactor = Math.min(1, b.rateFactor + RATE_STEP_UP);
    }
  }

  /** Server said the window is spent (Jupiter x-ratelimit-*, DexPaprika ratelimit-*). Pause without the 429 penalty. */
  notePauseUntil(spec: BucketSpec, untilMs: number): void {
    const b = this.bucket(spec);
    const now = this.clock.now();
    if (untilMs > now) b.pauseUntil = Math.max(b.pauseUntil, Math.min(untilMs, now + BACKOFF_CAP_MS));
  }

  pausedUntil(spec: BucketSpec): number | null {
    const b = this.buckets.get(spec.id);
    if (!b) return null;
    return b.pauseUntil > this.clock.now() ? b.pauseUntil : null;
  }

  /** True when this enrich host is in its circuit pause. Wallet and Helius URLs are never open. */
  circuitOpenFor(url: string): boolean {
    const spec = this.specFor(url);
    const lane = rpcLane(spec, 1, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [] }));
    if (!lane || lane.id !== ENRICH_BUCKET_ID) return false;
    const b = this.buckets.get(lane.id);
    return b != null && b.circuitUntil > this.clock.now();
  }

  /** Priority-0 depth is the mark queue. Wallet and manual reads (-1) are not included in priority0. */
  heliusQueue(): { queued: number; priority0: number } {
    const b = this.buckets.get("helius");
    if (!b) return { queued: 0, priority0: 0 };
    let priority0 = 0;
    for (const waiter of b.queue) if (waiter.priority === 0) priority0 += 1;
    return { queued: b.queue.length, priority0 };
  }

  stats(): BucketStats[] {
    const now = this.clock.now();
    return [...this.buckets.values()].map((b) => {
      while (b.hitTimes.length && b.hitTimes[0]! <= now - 60_000) b.hitTimes.shift();
      return {
        id: b.spec.id,
        source: b.spec.source,
        limitPerMin: b.spec.limitPerMin,
        budgetPerMin: b.spec.budgetPerMin,
        reqLastMin: b.windowCount(now),
        cacheHitsLastMin: b.hitTimes.length,
        count429: b.count429,
        count5xx: b.count5xx,
        circuitOpen: b.circuitUntil > now,
        sent: b.sent,
        rateFactor: Math.round(b.rateFactor * 100) / 100,
        pausedUntil: b.pauseUntil > now ? b.pauseUntil : null,
        queued: b.queue.length,
        note: b.spec.note
      };
    });
  }

  /**
   * fetch() with the shared budget. Same signature as fetch, plus an optional priority.
   * Never throws on 429 itself: the 429 Response is returned after the bucket is paused,
   * so callers keep their own error handling. GETs retry once after the pause when asked.
   */
  fetch = async (input: string | URL | Request, init?: RequestInit & { ndPriority?: Priority; retry429?: boolean; timeoutMs?: number }): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const spec = this.specFor(url);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET")).toUpperCase();
    const { ndPriority: priority, retry429, timeoutMs, ...rest } = init ?? {};
    const lane = rpcLane(spec, priority, rest.body);
    if (!lane) return this.baseFetch(input, rest);
    const isGet = method === "GET" && rest.body == null;
    const rpcRead = method === "POST" && typeof rest.body === "string" && (lane.id === "solana:public" || lane.id === "helius") && rpcReadMethod(rest.body) != null;
    const key = rpcRead ? `POST ${url} ${rest.body}` : `${method} ${url}`;
    const now = this.clock.now();
    if ((isGet || rpcRead) && lane.cacheMs > 0) {
      const hit = this.cache.get(key);
      if (hit && now - hit.at <= lane.cacheMs) {
        this.bucket(lane).hitTimes.push(now);
        return toResponse(hit.res);
      }
      const shared = this.inflight.get(key);
      if (shared) {
        this.bucket(lane).hitTimes.push(now);
        return toResponse(await shared);
      }
    }
    const run = this.send(lane, url, rest, priority ?? 1, retry429 ?? isGet, timeoutMs ?? 8_000, rest.signal ?? undefined);
    if (isGet || rpcRead) {
      this.inflight.set(key, run);
      try {
        const res = await run;
        if (res.status >= 200 && res.status < 300 && lane.cacheMs > 0) {
          this.cache.set(key, { at: this.clock.now(), res });
          if (this.cache.size > 500) {
            const first = this.cache.keys().next().value;
            if (first) this.cache.delete(first);
          }
        }
        return toResponse(res);
      } finally {
        this.inflight.delete(key);
      }
    }
    return toResponse(await run);
  };

  /** A plain fetch-compatible function bound to one priority, for callers that take `typeof fetch`. */
  fetchAt(priority: Priority): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => this.fetch(input, { ...(init ?? {}), ndPriority: priority })) as typeof fetch;
  }

  private async send(spec: BucketSpec, url: string, init: RequestInit, priority: Priority, retry: boolean, timeoutMs: number, callerSignal?: AbortSignal): Promise<CachedResponse> {
    for (let attempt = 0; ; attempt += 1) {
      // A paused enrich host returns at once so the sighting stays pending.
      // This lane is not Helius, so a wallet or mark read is not held here.
      if (spec.id === ENRICH_BUCKET_ID && this.pausedUntil(spec)) {
        const circuit = (this.buckets.get(spec.id)?.circuitUntil ?? 0) > this.clock.now();
        return {
          status: 429,
          statusText: circuit ? "enrich circuit" : "enrich backing off",
          headers: [["x-nd-local", "1"], ["x-nd-circuit", circuit ? "1" : "0"]],
          body: ""
        };
      }
      // Held marks and Add coin never sit out a backoff: they get a local 429 at once,
      // so the held-price book switches to its other source instead of freezing.
      if (priority === 0 && this.pausedUntil(spec)) {
        return { status: 429, statusText: "Desk backing off", headers: [["x-nd-local", "1"]], body: "" };
      }
      const coalesceKey = spec.id === "helius" && priority === 0 ? heliusPollKey(init.body) ?? undefined : undefined;
      await this.acquire(spec, priority, coalesceKey, callerSignal);
      const { signal: _ignored, ...rest } = init;
      const signal = callerSignal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), callerSignal]) : AbortSignal.timeout(timeoutMs);
      const res = await this.baseFetch(url, { ...rest, signal });
      const cached: CachedResponse = {
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
        body: await res.text()
      };
      this.readWindowHeaders(spec, res.headers);
      if (res.status === 429) {
        this.note429(spec, retryAfterMs(res.headers.get("retry-after"), this.clock.now()) ?? resetHeaderMs(res.headers, this.clock.now()));
        if (retry && attempt === 0 && priority !== 0) continue;
        return cached;
      }
      if (res.status >= 500) {
        if (spec.id === ENRICH_BUCKET_ID) this.note5xx(spec);
        return cached;
      }
      this.noteOk(spec);
      return cached;
    }
  }

  private readWindowHeaders(spec: BucketSpec, headers: Headers): void {
    const remaining = Number(headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining"));
    if (headers.get("x-ratelimit-remaining") == null && headers.get("ratelimit-remaining") == null) return;
    if (!(Number.isFinite(remaining) && remaining <= 0)) return;
    const until = resetHeaderMs(headers, this.clock.now());
    if (until != null) this.notePauseUntil(spec, this.clock.now() + until);
  }
}

function toResponse(res: CachedResponse): Response {
  const body = res.status === 204 || res.status === 304 ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Retry-After as seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** x-ratelimit-reset (Jupiter: unix seconds) or ratelimit-reset (DexPaprika: seconds from now). */
export function resetHeaderMs(headers: Headers, now: number): number | null {
  const abs = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-reset") != null && Number.isFinite(abs)) {
    return abs > 1e9 ? Math.max(0, abs * 1000 - now) : Math.max(0, abs * 1000);
  }
  const rel = Number(headers.get("ratelimit-reset"));
  if (headers.get("ratelimit-reset") != null && Number.isFinite(rel)) return Math.max(0, rel * 1000);
  return null;
}
