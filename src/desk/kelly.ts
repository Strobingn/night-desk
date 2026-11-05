import type { ClosedTrade } from "../types.js";

export interface KellyHint {
  /** Closed trades the read is taken over. */
  trades: number;
  winRate: number;
  /** Average win / average loss, as positive fractions of cost. */
  payoffRatio: number;
  /** Full Kelly fraction. Negative means the record shows no edge. */
  fullKelly: number;
  /** Quarter Kelly, floored at 0 and capped by the position cap. Display only. */
  suggestedPct: number;
  /** True when there are too few trades for the number to mean much. */
  thin: boolean;
}

export const KELLY_FRACTION = 0.25;
export const KELLY_MIN_TRADES = 30;

/**
 * Quarter-Kelly read of the closed book: f* = ¼ · (p − (1 − p) / b).
 * This is a hint for the phone and the web desk. It does not size orders; the 8% cap does.
 * Returns null until there is at least one win and one loss to measure.
 */
export function kellyHint(closed: readonly ClosedTrade[], capPct: number): KellyHint | null {
  const rows = closed.filter((t) => Number.isFinite(t.pnlPct));
  const wins = rows.filter((t) => t.pnlPct > 0);
  const losses = rows.filter((t) => t.pnlPct < 0);
  if (wins.length === 0 || losses.length === 0) return null;
  const p = wins.length / (wins.length + losses.length);
  const avgWin = wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length;
  const avgLoss = losses.reduce((a, t) => a + Math.abs(t.pnlPct), 0) / losses.length;
  if (!(avgLoss > 0)) return null;
  const b = avgWin / avgLoss;
  const fullKelly = p - (1 - p) / b;
  const suggestedPct = Math.min(capPct, Math.max(0, KELLY_FRACTION * fullKelly));
  const trades = wins.length + losses.length;
  return {
    trades,
    winRate: p,
    payoffRatio: b,
    fullKelly,
    suggestedPct,
    thin: trades < KELLY_MIN_TRADES
  };
}
