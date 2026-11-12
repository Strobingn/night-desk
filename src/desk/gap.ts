import type { ReasonCode } from "../types.js";

/**
 * v13.3 honest stop labels.
 *
 * A stop only says "sell once a mark at or below this line is seen". It cannot make the
 * market trade at the line: when the price jumps past it between two marks (a gap) or the
 * pool is pulled (a rug), the fill lands wherever the market is. Those exits are recorded
 * as GAP_RUG with the true fill, never as a clean STOP_LOSS.
 */

/** A stop fill more than this far (fraction of entry) past the stop line is a gap, not a stop. */
export const GAP_TOLERANCE = 0.03;
/** A fill this far below entry reads as a rug, not just a gap. */
export const RUG_DROP = 0.5;

export interface StopExitInput {
  code: ReasonCode;
  entryPrice: number;
  /** Mark the stop is measured from. Falls back to the fill when the buy never recorded one. */
  basisPrice?: number;
  stopPct: number;
  fillPrice: number;
  triggerPrice?: number;
}

export interface StopExitLabel {
  code: ReasonCode;
  /** Line the stop was set at. 0 when entry is unknown. */
  stopPrice: number;
  /** Fill vs entry, e.g. -0.124. null when entry is unknown. */
  fillDropPct: number | null;
  /** How far past the stop line the fill landed (fraction of entry). 0 when not a gap. */
  gapPct: number;
  rug: boolean;
}

export function classifyStopExit(input: StopExitInput): StopExitLabel {
  const basis = input.basisPrice != null && input.basisPrice > 0 ? input.basisPrice : input.entryPrice;
  const stopPrice = basis > 0 ? basis * (1 - input.stopPct) : 0;
  if (!(input.entryPrice > 0) || !(input.fillPrice >= 0)) {
    return { code: input.code, stopPrice, fillDropPct: null, gapPct: 0, rug: false };
  }
  const fillDropPct = input.fillPrice / input.entryPrice - 1;
  if (input.code !== "STOP_LOSS") return { code: input.code, stopPrice, fillDropPct, gapPct: 0, rug: false };
  // How far the fill landed through the line that actually fired, as a fraction of that basis.
  const past = basis > 0 ? (stopPrice - input.fillPrice) / basis : 0;
  if (past > GAP_TOLERANCE) {
    return { code: "GAP_RUG", stopPrice, fillDropPct, gapPct: past, rug: -fillDropPct >= RUG_DROP };
  }
  return { code: "STOP_LOSS", stopPrice, fillDropPct, gapPct: 0, rug: false };
}

/** Short label for trades, recap, and UI. */
export function exitLabel(code: string): string {
  switch (code) {
    case "GAP_RUG":
      return "gap/rug";
    case "STOP_LOSS":
      return "stop-loss";
    case "TRAIL_STOP":
      return "trailing stop";
    case "MANUAL_CLOSE":
      return "manual sell";
    case "PARTIAL_SELL":
      return "partial sell";
    case "TAKE_PROFIT":
      return "take-profit";
    case "STRATEGY_STOP":
      return "engine stop";
    case "BREAKEVEN_STOP":
      return "breakeven";
    case "TIME_LIMIT":
      return "time limit";
    default:
      return code.toLowerCase().replace(/_/g, " ");
  }
}
