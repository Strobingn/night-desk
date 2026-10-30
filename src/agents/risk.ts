import type { ReasonCode, Rejection } from "../types.js";
import type { ResolvedRules } from "../rules.js";

export interface RiskPositionState {
  entryPrice: number;
  peakPrice: number;
  trailArmed: boolean;
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
}

/**
 * The only automatic exit is the hard stop, −6% from the fill.
 * Peak and the old trail gap stay on the book as hints. Dirk closes winners.
 */
export function assessPosition(
  pos: RiskPositionState,
  mark: number,
  rules: ResolvedRules,
  options?: { trailExits?: boolean }
): RiskAssessment {
  const entry = pos.entryPrice;
  const peak = Math.max(pos.peakPrice, mark, entry);
  const pnlPct = entry > 0 ? (mark - entry) / entry : 0;
  const peakPnl = entry > 0 ? (peak - entry) / entry : 0;
  const trailArmed = pos.trailArmed || peakPnl >= rules.trailArmPct;
  const stopPrice = entry * (1 - rules.stopLossPct);
  const trailHintPrice = trailArmed ? peak * (1 - rules.trailGapPct) : null;

  if (pnlPct <= -rules.stopLossPct) {
    return {
      action: "stop",
      code: "STOP_LOSS",
      message: `Hard stop: mark is ${(pnlPct * 100).toFixed(2)}% from entry (limit -${(rules.stopLossPct * 100).toFixed(0)}%).`,
      pnlPct,
      peakPrice: peak,
      trailArmed,
      stopPrice,
      trailHintPrice
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
      trailHintPrice
    };
  }

  return {
    action: "hold",
    message: trailArmed
      ? `Holding. Hard stop ${stopPrice.toFixed(8)}. Peak ${peak.toFixed(8)} is a hint, not a sell. Unrealized ${(pnlPct * 100).toFixed(2)}%.`
      : `Holding. Hard stop ${stopPrice.toFixed(8)}, unrealized ${(pnlPct * 100).toFixed(2)}%.`,
    pnlPct,
    peakPrice: peak,
    trailArmed,
    stopPrice,
    trailHintPrice
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
