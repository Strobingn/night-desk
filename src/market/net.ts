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
    limitPerMin: 33,
    budgetPerMin: 25,
    burst: 8,
    cacheMs: 0,
    note: "helius-rpc.com background polls (priority 0): getBalance, getTokenAccountsByOwner, getMultipleAccounts. 25/min average, at most 8 back-to-back. The URL is not logged; it may carry an API key. Nothing is cached: a held mark must not look newer than the account read."
  },
  {
    id: "helius:exec",
    source: "solana",
    limitPerMin: 32,
    budgetPerMin: 24,
    burst: 8,
    cacheMs: 0,
    note: "Same Helius host, separate lane for swap preparation, simulation, and broadcast. A full read-lane queue cannot delay these. Burst 8 covers one transaction. Nothing here is cached."
  }
];

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
  if (host === "helius-rpc.com" || host.endsWith(".helius-rpc.com")) return BY_ID.get("helius")!;
  return null;
}

/** Read-lane hosts split polls from swap/simulate traffic. Null when this spec is not split. */
function execLaneId(id: string): string | null {
  if (id === "solana:public") return "solana:public:exec";
  if (id === "helius") return "helius:exec";
  return null;
}

export function rpcLane(spec: BucketSpec | null, priority: Priority | undefined, body: unknown): BucketSpec | null {
  if (!spec) return null;
  const execId = execLaneId(spec.id);
  if (!execId) return spec;
  const pri = priority ?? 1;
  if (pri !== 0) return BY_ID.get(execId)!;
  if (typeof body === "string" && !SOLANA_POLL_METHODS.has(rpcMethod(body) ?? "")) return BY_ID.get(execId)!;
  return spec;
}

const RPC_METHOD = /"method"\s*:\s*"([A-Za-z]+)"/;

/** Background polls. Everything else on the public host, including getAccountInfo and getLatestBlockhash, uses the exec lane. */
const SOLANA_POLL_METHODS = new Set(["getBalance", "getTokenAccountsByOwner", "getMultipleAccounts"]);

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

/** 0 = held-position marks and Add coin (never starve), 1 = enrichment, 2 = Scout list polls. */
export type Priority = 0 | 1 | 2;

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 120_000;
const MIN_RATE_FACTOR = 0.25;
const RATE_STEP_UP = 0.05;
const MAX_QUEUE = 200;

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

export class NetLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly inflight = new Map<string, Promise<CachedResponse>>();
  private readonly cache = new Map<string, { at: number; res: CachedResponse }>();
  private seq = 0;
  private readonly clock: NetClock;
  private readonly baseFetch: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch; clock?: Partial<NetClock>; specs?: BucketSpec[] } = {}) {
    this.baseFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.clock = { ...realClock, ...(opts.clock ?? {}) };
    for (const spec of opts.specs ?? BUCKETS) this.buckets.set(spec.id, new Bucket(spec, this.clock.now()));
  }

  private bucket(spec: BucketSpec): Bucket {
    let b = this.buckets.get(spec.id);
    if (!b) {
      b = new Bucket(spec, this.clock.now());
      this.buckets.set(spec.id, b);
    }
    return b;
  }

  /** Wait for a token in this bucket. Lower priority number goes first. */
  acquire(spec: BucketSpec, priority: Priority = 1): Promise<void> {
    const b = this.bucket(spec);
    return new Promise<void>((resolve, reject) => {
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
      b.queue.push({ priority, seq: this.seq++, resolve, reject });
      b.queue.sort((a, c) => a.priority - c.priority || a.seq - c.seq);
      this.pump(b);
    });
  }

  private pump(b: Bucket): void {
    if (b.timer) return;
    const now = this.clock.now();
    b.refill(now);
    while (b.queue.length && now >= b.pauseUntil && b.tokens >= 1) {
      b.tokens -= 1;
      b.sent += 1;
      b.sentTimes.push(now);
      b.queue.shift()!.resolve();
    }
    if (!b.queue.length) return;
    const perMs = (b.spec.budgetPerMin * b.rateFactor) / 60_000;
    const waitToken = b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / perMs);
    const wait = Math.max(waitToken, b.pauseUntil - now, 1);
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
    return wait;
  }

  /** A good answer: clear the backoff ladder and step the rate back toward full budget. */
  noteOk(spec: BucketSpec): void {
    const b = this.bucket(spec);
    b.backoffStep = 0;
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
    const spec = bucketFor(url);
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
    const run = this.send(lane, url, rest, priority ?? 1, retry429 ?? isGet, timeoutMs ?? 8_000);
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

  private async send(spec: BucketSpec, url: string, init: RequestInit, priority: Priority, retry: boolean, timeoutMs: number): Promise<CachedResponse> {
    for (let attempt = 0; ; attempt += 1) {
      // Held marks and Add coin never sit out a backoff: they get a local 429 at once,
      // so the held-price book switches to its other source instead of freezing.
      if (priority === 0 && this.pausedUntil(spec)) {
        return { status: 429, statusText: "Desk backing off", headers: [["x-nd-local", "1"]], body: "" };
      }
      await this.acquire(spec, priority);
      const { signal: _ignored, ...rest } = init;
      const res = await this.baseFetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
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
      if (res.status < 500) this.noteOk(spec);
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
