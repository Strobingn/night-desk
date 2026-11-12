import type { ReasonCode, Rejection } from "../types.js";
import type { ResolvedRules } from "../rules.js";

export interface RiskPositionState {
  entryPrice: number;
  peakPrice: number;
  trailArmed: boolean;
  /** v13.5 live positions only: the mark the buy was sized against. */
  entryMark?: number;
  /** v13.5 live positions only: highest accepted risk mark since entry. */
  markPeak?: number;
  live?: boolean;
}

export interface RiskAssessment {
  action: "hold" | "stop";
  code?: Extract<ReasonCode, "STOP_LOSS" | "TRAIL_STOP">;
  message: string;
  pnlPct: number;
  peakPrice: number;
  /** Hint only. A winner is not sold because this is true. */
  trailArmed: boolean;
  /** The only automatic exit: entry × (1 − hard stop). */
  stopPrice: number;
  /** Peak × (1 − trail gap) once the hint is armed. Never an order. */
  trailHintPrice: number | null;
  /** v13.5 live trail: highest accepted mark (entry mark at the start). Undefined for paper. */
  markPeak?: number;
}

/**
 * The only automatic exit is the hard stop, the configured percent under the entry mark.
 * The fill is often worse than that mark by entry slippage. Measuring the stop from the
 * fill makes an unchanged mark look like a loss and can stop out one tick later.
 * When the buy did not record a mark, the fill is still the line.
 * Peak and the old trail gap stay on the book as hints. Dirk closes winners.
 */
export function assessPosition(
  pos: RiskPositionState,
  mark: number,
  rules: ResolvedRules,
  options?: { trailExits?: boolean; liveTrailPct?: number | null }
): RiskAssessment {
  const entry = pos.entryPrice;
  const basis = pos.entryMark != null && pos.entryMark > 0 && Number.isFinite(pos.entryMark) ? pos.entryMark : entry;
  const peak = Math.max(pos.peakPrice, mark, entry);
  const pnlPct = entry > 0 ? (mark - entry) / entry : 0;
  const fromMark = basis > 0 ? (mark - basis) / basis : 0;
  const peakPnl = entry > 0 ? (peak - entry) / entry : 0;
  const trailArmed = pos.trailArmed || peakPnl >= rules.trailArmPct;
  const stopPrice = basis * (1 - rules.stopLossPct);
  let trailHintPrice = trailArmed ? peak * (1 - rules.trailGapPct) : null;
  // v13.5 live trail. Armed from entry, measured on marks (not the fill), so paying entry slippage
  // does not trip it on the first tick. Line = highest accepted mark × (1 − trail %). The hard
  // stop below is checked first and is never loosened by this.
  const liveTrail = pos.live === true && options?.liveTrailPct != null && options.liveTrailPct > 0 ? options.liveTrailPct : null;
  const markPeak = liveTrail != null ? Math.max(pos.markPeak ?? 0, pos.entryMark ?? 0, mark) || entry : undefined;
  const liveTrailPrice = liveTrail != null && markPeak != null ? markPeak * (1 - liveTrail) : null;
  if (liveTrailPrice != null) trailHintPrice = liveTrailPrice;

  if (basis > 0 && mark <= stopPrice) {
    return {
      action: "stop",
      code: "STOP_LOSS",
      message: `Hard stop: mark is ${(fromMark * 100).toFixed(2)}% from the entry mark (limit -${(rules.stopLossPct * 100).toFixed(0)}%).`,
      pnlPct: fromMark,
      peakPrice: peak,
      trailArmed,
      stopPrice,
      trailHintPrice,
      markPeak
    };
  }

  if (liveTrail != null && liveTrailPrice != null && mark <= liveTrailPrice) {
    return {
      action: "stop",
      code: "TRAIL_STOP",
      message: `Live trail ${(liveTrail * 100).toFixed(1)}%: mark ${mark.toPrecision(4)} fell to the trail line ${liveTrailPrice.toPrecision(4)} (peak ${markPeak!.toPrecision(4)}). ${(pnlPct * 100).toFixed(2)}% from entry.`,
      pnlPct,
      peakPrice: peak,
      trailArmed: true,
      stopPrice,
      trailHintPrice,
      markPeak
    };
  }

  if (options?.trailExits === true && trailArmed && trailHintPrice != null && mark <= trailHintPrice) {
    return {
      action: "stop",
      code: "TRAIL_STOP",
      message: `Trail stop: mark is ${(pnlPct * 100).toFixed(2)}% from entry. The trail hint was armed and the gap was hit.`,
      pnlPct,
      peakPrice: peak,
      trailArmed,
      stopPrice,
      trailHintPrice,
      markPeak
    };
  }

  return {
    action: "hold",
    message: trailArmed
      ? `Holding. Hard stop ${stopPrice.toFixed(8)}. Peak ${peak.toFixed(8)} is a hint, not a sell. Unrealized ${(pnlPct * 100).toFixed(2)}%.`
      : `Holding. Hard stop ${stopPrice.toFixed(8)}, unrealized ${(pnlPct * 100).toFixed(2)}%.`,
    pnlPct,
    peakPrice: peak,
    trailArmed: trailArmed || liveTrail != null,
    stopPrice,
    trailHintPrice,
    markPeak
  };
}

export type EntryBlock =
  | { ok: true }
  | { ok: false; reason: Rejection };

/**
 * No averaging down: an open mint cannot be added to.
 * No revenge trade: a hard stop bans that mint until the cooldown ends.
 * A manual close is not a hard stop and does not ban.
 */
export function entryAllowed(input: {
  hasPosition: boolean;
  cooldownUntil: number | null;
  now: number;
  /** Manual buys only, after the operator confirms. Analyst buys never set this. */
  ignoreCooldown?: boolean;
}): EntryBlock {
  if (input.hasPosition) {
    return {
      ok: false,
      reason: {
        code: "NO_AVERAGE_DOWN",
        message: "Position already open. Adding to a loser or a winner is disabled."
      }
    };
  }
  if (!input.ignoreCooldown && input.cooldownUntil != null && input.now < input.cooldownUntil) {
    const mins = Math.ceil((input.cooldownUntil - input.now) / 60_000);
    return {
      ok: false,
      reason: {
        code: "REVENGE_COOLDOWN",
        message: `Mint is banned after a hard stop. Cooldown has about ${mins} minute(s) left.`
      }
    };
  }
  return { ok: true };
}
