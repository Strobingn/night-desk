import { HARD_RULES } from "../rules.js";
import type { ResolvedRules } from "../rules.js";
import type { CandidateToken, Rejection } from "../types.js";
import { entryAllowed } from "./risk.js";

export interface OrderPlan {
  ok: true;
  sizeUsd: number;
  capUsd: number;
}

export interface OrderRefusal {
  ok: false;
  reason: Rejection;
}

/**
 * Position size is the 8% cap clipped by cash. It is never rounded above the cap.
 * `maxPositionPct` is already clamped by resolveRules, and this function clamps again.
 */
export function planOrder(input: {
  equityUsd: number;
  cashUsd: number;
  rules: ResolvedRules;
  token: Pick<CandidateToken, "priceUsd" | "liquidityUsd">;
  hasPosition: boolean;
  cooldownUntil: number | null;
  now: number;
}): OrderPlan | OrderRefusal {
  const gate = entryAllowed({
    hasPosition: input.hasPosition,
    cooldownUntil: input.cooldownUntil,
    now: input.now
  });
  if (!gate.ok) return gate;

  if (!(input.token.priceUsd > 0)) {
    return {
      ok: false,
      reason: { code: "PRICE_UNAVAILABLE", message: "No usable price. Order refused." }
    };
  }

  const pct = Math.min(input.rules.maxPositionPct, HARD_RULES.maxPositionPct);
  const capUsd = floorUsd(input.equityUsd * pct);
  const cashUsd = floorUsd(Math.max(0, input.cashUsd));
  if (!(capUsd > 0) || !(cashUsd > 0)) {
    return {
      ok: false,
      reason: { code: "INSUFFICIENT_CASH", message: "No cash available under the position cap." }
    };
  }
  const sizeUsd = Math.min(capUsd, cashUsd);
  if (!(sizeUsd > 0)) {
    return {
      ok: false,
      reason: { code: "INSUFFICIENT_CASH", message: "Sized order rounded to zero." }
    };
  }
  if (sizeUsd > input.equityUsd * pct + 1e-6) {
    return {
      ok: false,
      reason: {
        code: "POSITION_CAP",
        message: `Refusing order of $${sizeUsd.toFixed(2)} above the ${(pct * 100).toFixed(0)}% cap.`
      }
    };
  }
  return { ok: true, sizeUsd, capUsd };
}

export function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Cents, never rounded up. Used for the position cap so a half-cent cannot cross 8%. */
export function floorUsd(n: number): number {
  return Math.floor(n * 100 + 1e-9) / 100;
}

/** Cents, never rounded down. Used for fees. */
export function ceilUsd(n: number): number {
  return Math.ceil(n * 100 - 1e-9) / 100;
}

export interface PaperFillQuote {
  fillPrice: number;
  slippage: number;
  feeUsd: number;
  qty: number;
  notionalUsd: number;
  proceedsUsd?: number;
}

export function quotePaperBuy(mark: number, notionalUsd: number, liquidityUsd: number): PaperFillQuote {
  const slippage = slippageFor(notionalUsd, liquidityUsd, "buy");
  const fillPrice = mark * (1 + slippage);
  const feeUsd = ceilUsd(notionalUsd * (HARD_RULES.feeBps / 10_000));
  const spend = notionalUsd - feeUsd;
  const qty = spend / fillPrice;
  return { fillPrice, slippage, feeUsd, qty, notionalUsd };
}

/** Same silence window the position pricer uses before it calls a mark stale. */
export const MARK_STALE_MS = 5 * 60_000;

export interface RealizablePnl {
  netPnlUsd: number;
  netPnlPct: number;
  /** Sell-side rate from `slippageFor` (base slippage + pool impact, capped). */
  exitSlippage: number;
  proceedsUsd: number;
}

/**
 * What a close would clear right now, using the same paper sell quote the executor fills with.
 * Cost already includes the buy fill (price paid above the mark, plus the fee). This subtracts
 * the exit haircut on top of that. Returns null when the mark or the slippage inputs are not
 * usable — never a made-up gain.
 *
 * Unknown but numeric liquidity (0 or negative) still goes through `slippageFor`, which charges
 * the configured ceiling. A non-finite liquidity figure is missing, not zero.
 */
export function realizablePnl(input: {
  markPrice: number;
  qty: number;
  costUsd: number;
  liquidityUsd: number;
  /** When the mark was actually printed. Null means the price was restored or never stamped. */
  markAt: number | null;
  now: number;
  staleMs?: number;
}): RealizablePnl | null {
  const staleMs = input.staleMs ?? MARK_STALE_MS;
  if (!(input.markPrice > 0) || !Number.isFinite(input.markPrice)) return null;
  if (!(input.qty > 0) || !Number.isFinite(input.qty)) return null;
  if (!(input.costUsd > 0) || !Number.isFinite(input.costUsd)) return null;
  if (input.markAt == null || !Number.isFinite(input.markAt)) return null;
  if (!Number.isFinite(input.now)) return null;
  if (input.markAt > input.now + 5_000) return null;
  if (input.now - input.markAt >= staleMs) return null;
  if (!Number.isFinite(input.liquidityUsd)) return null;

  const quote = quotePaperSell(input.markPrice, input.qty, input.liquidityUsd);
  if (quote.proceedsUsd == null || !Number.isFinite(quote.proceedsUsd) || !Number.isFinite(quote.slippage)) {
    return null;
  }
  const netPnlUsd = roundUsd(quote.proceedsUsd - input.costUsd);
  const netPnlPct = netPnlUsd / input.costUsd;
  if (!Number.isFinite(netPnlPct)) return null;
  return {
    netPnlUsd,
    netPnlPct,
    exitSlippage: quote.slippage,
    proceedsUsd: quote.proceedsUsd
  };
}

export function quotePaperSell(mark: number, qty: number, liquidityUsd: number): PaperFillQuote {
  const grossEstimate = qty * mark;
  const slippage = slippageFor(grossEstimate, liquidityUsd, "sell");
  const fillPrice = mark * (1 - slippage);
  const gross = qty * fillPrice;
  const feeUsd = ceilUsd(gross * (HARD_RULES.feeBps / 10_000));
  const proceedsUsd = floorUsd(gross - feeUsd);
  return {
    fillPrice,
    slippage,
    feeUsd,
    qty,
    notionalUsd: roundUsd(gross),
    proceedsUsd
  };
}

/**
 * Average slippage against a constant-product pool. Reserve R is one side of the pool:
 *   buy  x USD: slippage = x / R
 *   sell y USD: slippage = y / (R + y)
 * Unknown liquidity is charged the ceiling.
 */
export function slippageFor(notionalUsd: number, liquidityUsd: number, side: "buy" | "sell" = "buy"): number {
  if (!(liquidityUsd > 0)) return HARD_RULES.maxSlippage;
  const reserve = liquidityUsd * HARD_RULES.poolSideShare;
  const share = Math.max(0, notionalUsd) / reserve;
  const impact = side === "buy" ? share : share / (1 + share);
  return Math.min(HARD_RULES.maxSlippage, HARD_RULES.baseSlippage + impact);
}
