type FetchLike = typeof fetch;

const BATCH = 30;

export interface DexQuote {
  priceUsd: number;
  liquidityUsd: number;
}

/**
 * Deepest-pool USD quote per mint from DexScreener (30 mints per request).
 * A mint with no listed pair is absent. This never invents a price.
 * Throws if a request fails, so callers can tell "no price" from "could not ask".
 */
export async function fetchDexQuotes(mints: string[], fetchImpl: FetchLike = fetch): Promise<Map<string, DexQuote>> {
  const out = new Map<string, DexQuote>();
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
    }>;
    if (!Array.isArray(rows)) continue;
    const best = new Map<string, DexQuote>();
    for (const row of rows) {
      const mint = row.baseToken?.address;
      const priceUsd = Number(row.priceUsd);
      if (!mint || !(priceUsd > 0) || !Number.isFinite(priceUsd)) continue;
      const liquidityUsd = Number(row.liquidity?.usd) || 0;
      const prev = best.get(mint);
      if (!prev || liquidityUsd > prev.liquidityUsd) best.set(mint, { priceUsd, liquidityUsd });
    }
    for (const [mint, quote] of best) out.set(mint, quote);
  }
  return out;
}

export async function fetchDexPrices(mints: string[], fetchImpl: FetchLike = fetch): Promise<Map<string, number>> {
  const quotes = await fetchDexQuotes(mints, fetchImpl);
  return new Map([...quotes].map(([mint, quote]) => [mint, quote.priceUsd]));
}
