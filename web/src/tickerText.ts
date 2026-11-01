import type { CoinCandidate } from "./types";

function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

const ORIGIN: Record<CoinCandidate["origin"], string> = {
  position: "held",
  trade: "traded",
  tape: "Tape",
  dexscreener: "DexScreener"
};

/** v13.6 one line per pick-list row: mint short · liquidity · 1h vol · where it was found. */
export function candidateLine(row: CoinCandidate): string {
  return `${row.mintShort} · liq ${compact(row.liquidityUsd)} · 1h vol ${compact(row.volume1hUsd)} · ${ORIGIN[row.origin] ?? row.origin}`;
}

/**
 * v13.6 the one-tap hint names the limit behind the cap (per-position %, cash, or the
 * max-exposure room) and only says "cut" when the size is actually cut.
 */
export function capHint(why: { binding: string; line: string; capUsd: number } | null | undefined, capUsd: number, tapUsd: number): string {
  const cap = why?.capUsd ?? capUsd;
  const cut = tapUsd > cap + 0.005;
  if (!why) return cut ? `cut to the $${cap.toFixed(2)} cap and cash` : `within the $${cap.toFixed(2)} cap`;
  return cut ? `cut to $${cap.toFixed(2)} by the ${why.line}` : `within the $${cap.toFixed(2)} cap, set by the ${why.line}`;
}
