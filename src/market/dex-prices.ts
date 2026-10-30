type FetchLike = typeof fetch;

const BATCH = 30;

export interface DexQuote {
  priceUsd: number;
  liquidityUsd: number;
  feed?: "dexscreener" | "jupiter";
  pairAddress?: string;
  dex?: string;
}

/**
 * Deepest-pool USD quote per mint from DexScreener (30 mints per request).
 * A mint with no listed pair is absent. This never invents a price.
 * Throws if a request fails, so callers can tell "no price" from "could not ask".
 */
export async function fetchDexQuotes(mints: string[], fetchImpl: FetchLike = fetch): Promise<Map<string, DexQuote>> {
  const out = new Map<string, DexQuote>();
  mints = [...new Set(mints)];
  for (let i = 0; i < mints.length; i += BATCH) {
    const batch = mints.slice(i, i + BATCH);
    const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`, {
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
          dex: typeof row.dexId === "string" ? row.dexId : undefined
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
 * Held-mint prices. Rotates DexScreener and Jupiter so one feed cannot freeze the book.
 * A 429 cools that source (5s, then doubled, capped at 60s). The other source is tried immediately.
 */
export class HeldQuoteBook {
  private next = 0;
  private coolUntil = new Map<QuoteSource, number>();
  private backoffMs = new Map<QuoteSource, number>();

  async fetch(mints: string[], fetchImpl: FetchLike, now = Date.now()): Promise<Map<string, DexQuote>> {
    const ready = this.ready(now);
    if (!ready.length) return new Map();
    const errors: string[] = [];
    for (const source of ready) {
      try {
        const quotes = source === "dexscreener" ? await fetchDexQuotes(mints, fetchImpl) : await fetchJupiterQuotes(mints, fetchImpl);
        this.backoffMs.set(source, 5_000);
        this.next = (SOURCES.indexOf(source) + 1) % SOURCES.length;
        return quotes;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        if (/\b429\b/.test(message)) {
          const wait = this.backoffMs.get(source) ?? 5_000;
          this.coolUntil.set(source, now + wait);
          this.backoffMs.set(source, Math.min(60_000, wait * 2));
        }
      }
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
    const out = new Map<string, DexQuote[]>();
    const errors: string[] = [];
    let ok = false;
    for (const source of ready) {
      try {
        const quotes = source === "dexscreener" ? await fetchDexQuotes(mints, fetchImpl) : await fetchJupiterQuotes(mints, fetchImpl);
        this.backoffMs.set(source, 5_000);
        ok = true;
        for (const [mint, quote] of quotes) {
          const list = out.get(mint) ?? [];
          list.push({ ...quote, feed: source });
          out.set(mint, list);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        if (/\b429\b/.test(message)) {
          const wait = this.backoffMs.get(source) ?? 5_000;
          this.coolUntil.set(source, now + wait);
          this.backoffMs.set(source, Math.min(60_000, wait * 2));
        }
      }
    }
    if (!ok) throw new Error(errors.join("; ") || "no price source");
    return out;
  }

  private ready(now: number): QuoteSource[] {
    const open = SOURCES.filter((source) => (this.coolUntil.get(source) ?? 0) <= now);
    if (!open.length) return [];
    const start = open.indexOf(SOURCES[this.next] ?? "dexscreener");
    const at = start >= 0 ? start : 0;
    return [...open.slice(at), ...open.slice(0, at)];
  }
}
