/**
 * v13.10 Tape quotes: a live price, 5m / 1h volume and 1h change for every coin on the Tape,
 * killed or not. Batched and rate-limit safe so the Scout feeds are never starved:
 *  - one DexScreener /tokens/v1 call per tick (≤30 mints, ~8 s apart → ≤8 calls/min),
 *  - one batched getMultipleAccounts for pump.fun curves DexScreener has no price for,
 *  - one Jupiter price call (≤50 mints) for whatever is still unpriced.
 * A price is never 0: an unknown value is null with a short reason ("no pool yet").
 */

type FetchLike = typeof fetch;

export interface TapeQuote {
  priceUsd: number | null;
  vol1hUsd: number | null;
  vol5mUsd: number | null;
  change1hPct: number | null;
  /** "dexscreener" | "pump.fun curve" | "jupiter" */
  source: string | null;
  at: number;
  /** Short reason a value is missing, e.g. "no pool yet". Null when the price is known. */
  why: string | null;
}

export interface DexTapeRow {
  priceUsd: number | null;
  vol1hUsd: number | null;
  vol5mUsd: number | null;
  change1hPct: number | null;
  liquidityUsd: number;
  dex?: string;
}

const finite = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const positive = (v: unknown): number | null => {
  const n = finite(v);
  return n != null && n > 0 ? n : null;
};

/** Deepest pair per mint (priced pairs first), with volume and change. Throws on HTTP errors. */
export async function fetchDexTape(mints: string[], fetchImpl: FetchLike): Promise<Map<string, DexTapeRow>> {
  const out = new Map<string, DexTapeRow>();
  const uniq = [...new Set(mints)].slice(0, 30);
  if (!uniq.length) return out;
  const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${uniq.join(",")}`, {
    headers: { accept: "application/json", "user-agent": "night-desk/1.0" },
    signal: AbortSignal.timeout(6_000)
  });
  if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{
    baseToken?: { address?: string };
    priceUsd?: string | number;
    liquidity?: { usd?: number };
    volume?: { h1?: number; m5?: number };
    priceChange?: { h1?: number };
    dexId?: string;
  }>;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const mint = row.baseToken?.address;
    if (!mint || !uniq.includes(mint)) continue;
    const cand: DexTapeRow = {
      priceUsd: positive(row.priceUsd),
      vol1hUsd: finite(row.volume?.h1),
      vol5mUsd: finite(row.volume?.m5),
      change1hPct: finite(row.priceChange?.h1),
      liquidityUsd: finite(row.liquidity?.usd) ?? 0,
      dex: typeof row.dexId === "string" ? row.dexId : undefined
    };
    const prev = out.get(mint);
    // 1h / 5m volume: the busiest pair, the same way the Scout's filter reads it.
    if (prev) {
      cand.vol1hUsd = Math.max(cand.vol1hUsd ?? 0, prev.vol1hUsd ?? 0);
      cand.vol5mUsd = Math.max(cand.vol5mUsd ?? 0, prev.vol5mUsd ?? 0);
    }
    const better =
      !prev ||
      (cand.priceUsd != null && prev.priceUsd == null) ||
      ((cand.priceUsd != null) === (prev.priceUsd != null) && cand.liquidityUsd > prev.liquidityUsd);
    if (better) out.set(mint, cand);
    else if (prev) {
      prev.vol1hUsd = cand.vol1hUsd;
      prev.vol5mUsd = cand.vol5mUsd;
    }
  }
  return out;
}

export interface TapeQuoterDeps {
  dex?: (mints: string[]) => Promise<Map<string, DexTapeRow>>;
  /** Batched pump.fun curve read: USD price per mint, or a reason it has none. */
  curves?: (mints: string[]) => Promise<{ prices: Map<string, number>; missing: Map<string, string> }>;
  jupiter?: (mints: string[]) => Promise<Map<string, number>>;
  now?: () => number;
}

export const TAPE_TICK_MS = 8_000;
export const TAPE_STALE_MS = 20_000;
export const TAPE_MAX_TRACKED = 90;
export const TAPE_DEX_COOLOFF_MS = 60_000;
export const TAPE_PINNED_STALE_MS = 10_000;

/** Short Tape reason from a longer curve-reader reason. */
export function shortWhy(reason: string | undefined, pumpLike: boolean): string {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("no sol has traded")) return "no trades yet";
  if (r.includes("complete")) return "curve done, no pool yet";
  if (r.includes("empty")) return "curve empty";
  if (r.includes("could not be read") || r.includes("rpc")) return "chain read failed";
  return pumpLike ? "no pool yet" : "not listed yet";
}

export class TapeQuoter {
  private tracked = new Map<string, { source: string; seenAt: number }>();
  private quotes = new Map<string, TapeQuote>();
  private dexPausedUntil = 0;
  private running = false;
  /** v13.11 mints with an open limit order: always tracked, re-quoted every 10 s. */
  private pinned = new Set<string>();
  stats = { ticks: 0, dexCalls: 0, dexErrors: 0, curveCalls: 0, jupCalls: 0 };

  constructor(private readonly deps: TapeQuoterDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** A coin appeared on the Tape (scout sighting). Newest first; the oldest drop off. */
  note(mint: string, source: string): void {
    if (!mint) return;
    this.tracked.delete(mint);
    this.tracked.set(mint, { source, seenAt: this.now() });
    this.evict();
  }

  private evict(): void {
    for (const key of [...this.tracked.keys()]) {
      if (this.tracked.size <= TAPE_MAX_TRACKED + this.pinned.size) break;
      if (this.pinned.has(key)) continue;
      this.tracked.delete(key);
      this.quotes.delete(key);
    }
  }

  /** v13.11 keep these mints quoted (limit orders). Replaces the previous pin set. */
  pin(mints: Iterable<string>, source = "order"): void {
    this.pinned = new Set([...mints].filter(Boolean));
    for (const m of this.pinned) if (!this.tracked.has(m)) this.tracked.set(m, { source, seenAt: this.now() });
    this.evict();
  }

  get(mint: string): TapeQuote | undefined {
    return this.quotes.get(mint);
  }

  /** Quotes for every tracked mint (snapshot field). */
  view(): Record<string, TapeQuote> {
    const out: Record<string, TapeQuote> = {};
    for (const mint of this.tracked.keys()) {
      const q = this.quotes.get(mint);
      if (q) out[mint] = q;
    }
    return out;
  }

  /** The ≤30 tracked mints most in need of a quote: never quoted first, then the stalest; newest sightings win ties. */
  due(now = this.now(), max = 30): string[] {
    const list = [...this.tracked.entries()].reverse();
    const never = list.filter(([m]) => !this.quotes.has(m)).map(([m]) => m);
    const stale = list
      .filter(([m]) => {
        const q = this.quotes.get(m);
        return q != null && now - q.at >= TAPE_STALE_MS;
      })
      .sort((a, b) => (this.quotes.get(a[0])!.at - this.quotes.get(b[0])!.at))
      .map(([m]) => m);
    const pinnedDue = [...this.pinned].filter((m) => {
      const q = this.quotes.get(m);
      return q == null || now - q.at >= TAPE_PINNED_STALE_MS;
    });
    return [...new Set([...pinnedDue, ...never, ...stale])].slice(0, max);
  }

  /** One batched pass. Safe to call on a timer; overlapping calls are skipped. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.now();
      const mints = this.due(now);
      if (!mints.length) return 0;
      this.stats.ticks += 1;
      let dex = new Map<string, DexTapeRow>();
      let dexFailed = false;
      if (this.deps.dex && now < this.dexPausedUntil) dexFailed = true; // cooling off: keep what we had
      else if (this.deps.dex) {
        try {
          this.stats.dexCalls += 1;
          dex = await this.deps.dex(mints);
        } catch (err) {
          dexFailed = true;
          this.stats.dexErrors += 1;
          // 429 or any failure: leave DexScreener alone for a minute (the Scout uses it too).
          this.dexPausedUntil = now + TAPE_DEX_COOLOFF_MS;
          void err;
        }
      }
      const unpriced = mints.filter((m) => dex.get(m)?.priceUsd == null);
      const pumpLike = (m: string) => this.tracked.get(m)?.source === "pumpfun" || m.endsWith("pump") || dex.get(m)?.dex === "pumpfun";
      const curvePrices = new Map<string, number>();
      const curveWhy = new Map<string, string>();
      const curveWanted = unpriced.filter(pumpLike);
      if (this.deps.curves && curveWanted.length) {
        try {
          this.stats.curveCalls += 1;
          const r = await this.deps.curves(curveWanted);
          for (const [m, p] of r.prices) if (p > 0 && Number.isFinite(p)) curvePrices.set(m, p);
          for (const [m, w] of r.missing) curveWhy.set(m, w);
        } catch {
          for (const m of curveWanted) curveWhy.set(m, "rpc read failed");
        }
      }
      const jupWanted = unpriced.filter((m) => !curvePrices.has(m));
      const jup = new Map<string, number>();
      if (this.deps.jupiter && jupWanted.length) {
        try {
          this.stats.jupCalls += 1;
          for (const [m, p] of await this.deps.jupiter(jupWanted)) if (p > 0 && Number.isFinite(p)) jup.set(m, p);
        } catch {
          /* price stays unknown, with a reason */
        }
      }
      const at = this.now();
      for (const m of mints) {
        const d = dex.get(m);
        const prev = this.quotes.get(m);
        const fresh = d?.priceUsd ?? curvePrices.get(m) ?? jup.get(m) ?? null;
        // DexScreener down / cooling off: keep the last good price rather than blanking the card.
        const keep = fresh == null && dexFailed && prev?.priceUsd != null;
        const price = keep ? prev!.priceUsd : fresh;
        const source = keep ? prev!.source : d?.priceUsd != null ? "dexscreener" : curvePrices.has(m) ? "pump.fun curve" : jup.has(m) ? "jupiter" : null;
        let why: string | null = null;
        if (price == null) {
          if (dexFailed && !curveWhy.has(m)) why = "price source busy";
          else why = shortWhy(curveWhy.get(m), pumpLike(m));
        }
        this.quotes.set(m, {
          priceUsd: price,
          // DexScreener's volume is the only real volume source; keep the last known one if this pass missed it.
          vol1hUsd: d?.vol1hUsd ?? (dexFailed ? prev?.vol1hUsd ?? null : null),
          vol5mUsd: d?.vol5mUsd ?? (dexFailed ? prev?.vol5mUsd ?? null : null),
          change1hPct: d?.change1hPct ?? (dexFailed ? prev?.change1hPct ?? null : null),
          source,
          at,
          why
        });
      }
      return mints.length;
    } finally {
      this.running = false;
    }
  }
}
