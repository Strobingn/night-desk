import { SourceGate } from "./source-gate.js";

type FetchLike = typeof fetch;

const BATCH = 30;
const WSOL = "So11111111111111111111111111111111111111112";

export interface DexQuote {
  priceUsd: number;
  liquidityUsd: number;
  feed?: "dexscreener" | "jupiter";
  pairAddress?: string;
  dex?: string;
  /** v13.2: SOL per token when the pool is quoted in SOL (DexScreener priceNative). */
  priceNative?: number;
}

/**
 * Deepest-pool USD quote per mint from DexScreener (30 mints per request).
 * A mint with no listed pair is absent. This never invents a price.
 * Throws if a request fails, so callers can tell "no price" from "could not ask".
 */
export async function fetchDexQuotes(mints: string[], fetchImpl: FetchLike = fetch, opts: { bust?: number } = {}): Promise<Map<string, DexQuote>> {
  const out = new Map<string, DexQuote>();
  mints = [...new Set(mints)];
  for (let i = 0; i < mints.length; i += BATCH) {
    const batch = mints.slice(i, i + BATCH);
    // v13.2: the endpoint is CDN-cached 30s. A stop confirmation may skip that cache, rarely.
    const bust = opts.bust ? `?t=${opts.bust}` : "";
    const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}${bust}`, {
      headers: { accept: "application/json", "user-agent": "night-desk/1.0" },
      signal: AbortSignal.timeout(6_000)
    });
    if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{
      baseToken?: { address?: string };
      priceUsd?: string | number;
      liquidity?: { usd?: number };
      pairAddress?: string;
      dexId?: string;
      priceNative?: string | number;
      quoteToken?: { address?: string };
    }>;
    if (!Array.isArray(rows)) continue;
    const best = new Map<string, DexQuote>();
    for (const row of rows) {
      const mint = row.baseToken?.address;
      const priceUsd = Number(row.priceUsd);
      if (!mint || !(priceUsd > 0) || !Number.isFinite(priceUsd)) continue;
      const liquidityUsd = Number(row.liquidity?.usd) || 0;
      const prev = best.get(mint);
      if (!prev || liquidityUsd > prev.liquidityUsd) {
        best.set(mint, {
          priceUsd,
          liquidityUsd,
          feed: "dexscreener",
          pairAddress: typeof row.pairAddress === "string" ? row.pairAddress : undefined,
          dex: typeof row.dexId === "string" ? row.dexId : undefined,
          ...(row.quoteToken?.address === WSOL && Number(row.priceNative) > 0 && Number.isFinite(Number(row.priceNative))
            ? { priceNative: Number(row.priceNative) }
            : {})
        });
      }
    }
    for (const [mint, quote] of best) out.set(mint, quote);
  }
  return out;
}

export async function fetchDexPrices(mints: string[], fetchImpl: FetchLike = fetch): Promise<Map<string, number>> {
  const quotes = await fetchDexQuotes(mints, fetchImpl);
  return new Map([...quotes].map(([mint, quote]) => [mint, quote.priceUsd]));
}

/**
 * Jupiter price v3 (`usdPrice`). v2 is a dead 404 and its `price` field is only still
 * read so an older mock keeps working. A missing or non-positive price is omitted.
 * Liquidity of 0 must not overwrite a pool the entry already priced.
 */
export function parseJupiterPrices(body: unknown, mints: string[]): Map<string, DexQuote> {
  const out = new Map<string, DexQuote>();
  if (!body || typeof body !== "object" || Array.isArray(body)) return out;
  const rec = body as { data?: unknown };
  const table = rec.data && typeof rec.data === "object" && !Array.isArray(rec.data) ? (rec.data as Record<string, unknown>) : (body as Record<string, unknown>);
  for (const mint of mints) {
    const row = table[mint];
    if (!row || typeof row !== "object") continue;
    const fields = row as { usdPrice?: unknown; price?: unknown; liquidity?: unknown };
    const priceUsd = Number(fields.usdPrice ?? fields.price);
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) continue;
    const liquidityUsd = Number(fields.liquidity);
    out.set(mint, { priceUsd, liquidityUsd: Number.isFinite(liquidityUsd) && liquidityUsd > 0 ? liquidityUsd : 0, feed: "jupiter" });
  }
  return out;
}

/** Jupiter price v3 takes up to 50 ids per call. */
export const JUPITER_PRICE_BATCH = 50;

/**
 * v12.1: api.jup.ag (lite-api.jup.ag is being retired; both share one keyless bucket).
 * Unique ids only, 50 per call.
 */
export async function fetchJupiterQuotes(mints: string[], fetchImpl: FetchLike = fetch): Promise<Map<string, DexQuote>> {
  const unique = [...new Set(mints)];
  if (!unique.length) return new Map();
  const out = new Map<string, DexQuote>();
  for (let i = 0; i < unique.length; i += JUPITER_PRICE_BATCH) {
    const chunk = unique.slice(i, i + JUPITER_PRICE_BATCH);
    const res = await fetchImpl(`https://api.jup.ag/price/v3?ids=${encodeURIComponent(chunk.join(","))}`, {
      headers: { accept: "application/json", "user-agent": "night-desk/1.0" },
      signal: AbortSignal.timeout(6_000)
    });
    if (!res.ok) throw new Error(`jupiter HTTP ${res.status}`);
    for (const [mint, quote] of parseJupiterPrices(await res.json(), chunk)) out.set(mint, quote);
  }
  return out;
}

export type QuoteSource = "dexscreener" | "jupiter";

const SOURCES: QuoteSource[] = ["dexscreener", "jupiter"];

/**
 * v13.2 pacing for held marks. DexScreener's tokens endpoint is CDN-cached 30s, so asking
 * faster than every 3s gains nothing. Jupiter's keyless bucket is ~5 requests per 10s and
 * is shared with the Scout and paper-fill quotes, so held marks take at most one per 5s.
 */
export const SOURCE_MIN_MS: Record<QuoteSource, number> = { dexscreener: 3_000, jupiter: 5_000 };

export interface SourceResult {
  source: QuoteSource;
  quotes?: Map<string, DexQuote>;
  error?: string;
}

/**
 * Held-mint prices. Each source has its own gate: a 429 cools that source (5s, doubled,
 * capped at 60s), a 5xx or timeout cools it 2s doubling to 30s. The other source is still tried.
 */
export class HeldQuoteBook {
  private next = 0;
  readonly gates: Record<QuoteSource, SourceGate> = {
    dexscreener: new SourceGate(SOURCE_MIN_MS.dexscreener),
    jupiter: new SourceGate(SOURCE_MIN_MS.jupiter)
  };
  /**
   * Last SOL/USD already on a quote the desk fetched.
   * Jupiter's wrapped-SOL price wins. A Dex pool quoted in SOL (priceUsd / priceNative) fills in when Jupiter has not.
   */
  solUsd: { value: number; at: number; source?: "jupiter" | "dex" } | null = null;

  /** A print outside this band is not a SOL/USD mark (display only; trading still fail-closes). */
  private noteSol(value: number, at: number, source: "jupiter" | "dex"): void {
    if (!(value >= 5) || value > 5_000 || !Number.isFinite(value)) return;
    const cur = this.solUsd;
    if (cur?.source === "jupiter" && source === "dex" && at - cur.at <= 120_000) return;
    this.solUsd = { value, at, source };
  }

  private noteDexSol(quotes: Map<string, DexQuote>, now: number): void {
    for (const quote of quotes.values()) {
      if (quote.priceNative && quote.priceNative > 0 && quote.priceUsd > 0) {
        this.noteSol(quote.priceUsd / quote.priceNative, now, "dex");
        return;
      }
    }
  }

  private async one(source: QuoteSource, mints: string[], fetchImpl: FetchLike, now: number, bust?: number): Promise<Map<string, DexQuote>> {
    this.gates[source].started(now);
    if (source === "dexscreener") {
      const quotes = await fetchDexQuotes(mints, fetchImpl, bust ? { bust } : {});
      this.noteDexSol(quotes, now);
      return quotes;
    }
    const quotes = await fetchJupiterQuotes([...mints, WSOL], fetchImpl);
    const sol = quotes.get(WSOL);
    if (sol && sol.priceUsd > 0) this.noteSol(sol.priceUsd, now, "jupiter");
    if (sol && !mints.includes(WSOL)) quotes.delete(WSOL);
    return quotes;
  }

  /** Runs the given sources in parallel. Each result carries its quotes or its error. */
  async fetchSources(
    mints: string[],
    sources: QuoteSource[],
    fetchImpl: FetchLike,
    now = Date.now(),
    opts: { bust?: number } = {}
  ): Promise<SourceResult[]> {
    const ready = sources.filter((source) => !this.gates[source].cooling(now));
    return Promise.all(
      ready.map(async (source): Promise<SourceResult> => {
        try {
          const quotes = await this.one(source, mints, fetchImpl, now, source === "dexscreener" ? opts.bust : undefined);
          this.gates[source].ok(now);
          for (const quote of quotes.values()) quote.feed = source;
          return { source, quotes };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.gates[source].fail(message, now);
          return { source, error: message };
        }
      })
    );
  }

  async fetch(mints: string[], fetchImpl: FetchLike, now = Date.now()): Promise<Map<string, DexQuote>> {
    const ready = this.ready(now);
    if (!ready.length) return new Map();
    const errors: string[] = [];
    for (const source of ready) {
      const [result] = await this.fetchSources(mints, [source], fetchImpl, now);
      if (result?.quotes) {
        this.next = (SOURCES.indexOf(source) + 1) % SOURCES.length;
        return result.quotes;
      }
      if (result?.error) errors.push(result.error);
    }
    throw new Error(errors.join("; ") || "no price source");
  }

  /**
   * Every ready source, tagged. The desk keeps the entry feed and drops the rest.
   * One dead source (Jupiter v2 was a 404) must not hide the other, and must not
   * be substituted for it.
   */
  async fetchAll(mints: string[], fetchImpl: FetchLike, now = Date.now()): Promise<Map<string, DexQuote[]>> {
    const ready = this.ready(now);
    if (!ready.length) return new Map();
    return mergeResults(await this.fetchSources(mints, ready, fetchImpl, now));
  }

  private ready(now: number): QuoteSource[] {
    const open = SOURCES.filter((source) => !this.gates[source].cooling(now));
    if (!open.length) return [];
    const start = open.indexOf(SOURCES[this.next] ?? "dexscreener");
    const at = start >= 0 ? start : 0;
    return [...open.slice(at), ...open.slice(0, at)];
  }
}

/** Per-mint quote lists. Throws only when every source that ran failed. */
export function mergeResults(results: SourceResult[]): Map<string, DexQuote[]> {
  const out = new Map<string, DexQuote[]>();
  if (!results.length) return out;
  if (!results.some((r) => r.quotes)) throw new Error(results.map((r) => r.error).join("; ") || "no price source");
  for (const r of results) {
    for (const [mint, quote] of r.quotes ?? []) {
      const list = out.get(mint) ?? [];
      list.push(quote);
      out.set(mint, list);
    }
  }
  return out;
}
