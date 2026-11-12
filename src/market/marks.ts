import { quoteUsdFromDexPair } from "./dex-prices.js";
/** Highest-liquidity DexScreener pair price for each mint. */
export function bestDexPrices(payload: unknown): Map<string, { priceUsd: number; liquidityUsd: number; quoteUsd?: number }> {
  const pairs = Array.isArray(payload)
    ? payload
    : ((payload as { pairs?: unknown[] } | null)?.pairs ?? []);
  const best = new Map<string, { priceUsd: number; liquidityUsd: number; quoteUsd?: number }>();
  if (!Array.isArray(pairs)) return best;
  for (const pair of pairs) {
    const row = pair as {
      baseToken?: { address?: string };
      priceUsd?: string | number;
      priceNative?: string | number;
      liquidity?: { usd?: number; base?: number; quote?: number };
    };
    const mint = row.baseToken?.address;
    const priceUsd = Number(row.priceUsd);
    const liquidityUsd = Number(row.liquidity?.usd ?? 0);
    if (!mint || !(priceUsd > 0)) continue;
    const prev = best.get(mint);
    if (!prev || liquidityUsd > prev.liquidityUsd) {
      const quoteUsd = quoteUsdFromDexPair(row);
      best.set(mint, { priceUsd, liquidityUsd, ...(quoteUsd != null ? { quoteUsd } : {}) });
    }
  }
  return best;
}
