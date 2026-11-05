/**
 * Normalized Shannon entropy of retail holder balances, 0–1.
 *
 * H = −Σ pᵢ ln pᵢ / ln N, with pᵢ each holder's share of the top-N retail balance.
 * Near 0: one or two wallets hold nearly everything.
 * Near 1: balances are close to identical — what a script splitting supply across
 * fresh wallets looks like. Organic memecoin books are lumpy and sit well below 1.
 *
 * Reserves (bonding curve, LP vaults, burn) must already be removed by the caller.
 * Returns null when there are fewer than two positive balances.
 */
export function holderEntropy(balances: readonly number[], topN = 25): number | null {
  const top = balances
    .filter((b) => Number.isFinite(b) && b > 0)
    .sort((a, b) => b - a)
    .slice(0, topN);
  const n = top.length;
  if (n < 2) return null;
  const total = top.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let h = 0;
  for (const b of top) {
    const p = b / total;
    h -= p * Math.log(p);
  }
  return Math.min(1, Math.max(0, h / Math.log(n)));
}

/** Uniformity line for the sybil check. Only judged once there are enough holders to mean anything. */
export const SYBIL_ENTROPY_MAX = 0.985;
export const SYBIL_MIN_HOLDERS = 15;

export function looksSybilSplit(entropy: number | null, holdersMeasured: number | null): boolean {
  if (entropy == null || holdersMeasured == null) return false;
  return holdersMeasured >= SYBIL_MIN_HOLDERS && entropy > SYBIL_ENTROPY_MAX;
}
