import { HARD_RULES, SIZING_BAND, clampEntrySlippage } from "../rules.js";
import type { ResolvedRules } from "../rules.js";
import type { CandidateToken, Rejection } from "../types.js";
import { entryAllowed } from "./risk.js";

export interface OrderPlan {
  ok: true;
  sizeUsd: number;
  capUsd: number;
  /** Set when a manual request was above the cap and cut down to it. */
  clampedFrom?: number;
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
  /** Set only for a manual buy the operator confirmed past the hard-stop ban. */
  ignoreCooldown?: boolean;
  /**
   * Highest share of equity this order may use. Defaults to the 8% hard cap, so rules widened
   * by hand still size at 8%. The desk passes the saved cap (≤ 50%) or, for one confirmed
   * manual buy, up to 100%. Never above SIZING_BAND.manualMaxPct.
   */
  ceilingPct?: number;
  /** Dollars of new exposure still allowed under the total-exposure cap. Omitted = no extra limit. */
  exposureRoomUsd?: number;
}): OrderPlan | OrderRefusal {
  const gate = entryAllowed({
    hasPosition: input.hasPosition,
    cooldownUntil: input.cooldownUntil,
    now: input.now,
    ignoreCooldown: input.ignoreCooldown === true
  });
  if (!gate.ok) return gate;

  if (!(input.token.priceUsd > 0)) {
    return {
      ok: false,
      reason: { code: "PRICE_UNAVAILABLE", message: "No usable price. Order refused." }
    };
  }

  const pct =
    input.ceilingPct != null
      ? sizingCeiling(input.ceilingPct)
      : Math.min(input.rules.maxPositionPct, HARD_RULES.maxPositionPct);
  if (!(pct > 0) || !Number.isFinite(input.equityUsd)) {
    return { ok: false, reason: { code: "POSITION_CAP", message: "Position cap is not a usable percent. Order refused." } };
  }
  let capUsd = floorUsd(input.equityUsd * pct);
  if (input.exposureRoomUsd != null) {
    const room = Number.isFinite(input.exposureRoomUsd) ? floorUsd(Math.max(0, input.exposureRoomUsd)) : 0;
    if (!(room >= 0.01)) {
      return {
        ok: false,
        reason: { code: "EXPOSURE_CAP", message: "Total exposure is already at the max-exposure cap. Close or trim a position first." }
      };
    }
    capUsd = Math.min(capUsd, room);
  }
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

/** Order ceiling: omitted = 8% hard cap; otherwise between 1% and SIZING_BAND.manualMaxPct. */
export function sizingCeiling(ceilingPct?: number): number {
  if (ceilingPct == null || !Number.isFinite(ceilingPct) || !(ceilingPct > 0)) return HARD_RULES.maxPositionPct;
  return Math.min(SIZING_BAND.manualMaxPct, Math.max(SIZING_BAND.minPct, ceilingPct));
}

/**
 * Manual size is optional. Omitted means the planned cap.
 * A requested size above the cap is cut down to the cap and filled.
 * The fill is never above the cap. A non-positive size is still refused.
 * Values are floored to cents so a half-cent cannot cross the cap.
 */
export function resolveManualSize(
  planSizeUsd: number,
  requested: number | undefined
): OrderPlan | OrderRefusal {
  if (!(planSizeUsd > 0)) {
    return {
      ok: false,
      reason: { code: "INSUFFICIENT_CASH", message: "No planned size under the position cap." }
    };
  }
  if (requested == null) return { ok: true, sizeUsd: planSizeUsd, capUsd: planSizeUsd };
  if (typeof requested !== "number" || !Number.isFinite(requested) || !(requested > 0)) {
    return {
      ok: false,
      reason: { code: "POSITION_CAP", message: "Manual size must be a positive USD amount. Order refused." }
    };
  }
  const floored = floorUsd(requested);
  if (!(floored > 0)) {
    return {
      ok: false,
      reason: { code: "INSUFFICIENT_CASH", message: "Manual size rounded to zero. Order refused." }
    };
  }
  if (floored > planSizeUsd + 1e-9) {
    return { ok: true, sizeUsd: planSizeUsd, capUsd: planSizeUsd, clampedFrom: floored };
  }
  return { ok: true, sizeUsd: floored, capUsd: planSizeUsd };
}

export function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A mark older than this is not a fill. Net stays blank instead of looking profitable. */
export const NET_MARK_STALE_MS = 5 * 60_000;

export interface RealizablePnl {
  netPnlUsd: number;
  netPnlPct: number;
  exitSlippage: number;
  proceedsUsd: number;
}

/**
 * What a paper sell would book right now, using quotePaperSell (the same pool model as an exit).
 * Null when the mark is missing, non-finite, or stale, or when the quote cannot be checked.
 * A missing pool is a zero fill (a loss), never a made-up profit.
 */
export function realizablePnl(input: {
  markPrice: number;
  qty: number;
  costUsd: number;
  liquidityUsd: number;
  markAt: number;
  now: number;
}): RealizablePnl | null {
  const { markPrice, qty, costUsd, liquidityUsd, markAt, now } = input;
  if (!(markPrice > 0) || !Number.isFinite(markPrice)) return null;
  if (!(qty > 0) || !Number.isFinite(qty)) return null;
  if (!(costUsd > 0) || !Number.isFinite(costUsd)) return null;
  if (!Number.isFinite(liquidityUsd)) return null;
  if (!Number.isFinite(markAt) || !Number.isFinite(now)) return null;
  if (markAt > now + 5_000) return null;
  if (now - markAt >= NET_MARK_STALE_MS) return null;
  let quote: PaperFillQuote;
  try {
    quote = quotePaperSell(markPrice, qty, liquidityUsd);
  } catch {
    return null;
  }
  const proceeds = quote.proceedsUsd ?? 0;
  if (!Number.isFinite(proceeds) || proceeds < 0) return null;
  const raw = qty * markPrice - costUsd;
  const net = roundUsd(proceeds - costUsd);
  if (net > roundUsd(raw) + 0.02) return null;
  if (!Number.isFinite(quote.slippage)) return null;
  return { netPnlUsd: net, netPnlPct: net / costUsd, exitSlippage: quote.slippage, proceedsUsd: proceeds };
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
  ok: true;
  fillPrice: number;
  slippage: number;
  feeUsd: number;
  qty: number;
  notionalUsd: number;
  proceedsUsd?: number;
}

export interface EntrySlipRefusal {
  ok: false;
  code: "ENTRY_SLIPPAGE";
  slippage: number;
  message: string;
}

export function entrySlippageMessage(slippage: number, cap: number, fillPrice: number, mark: number): string {
  if (!Number.isFinite(slippage)) {
    return mark > 0 && Number.isFinite(mark)
      ? "Can't measure the entry cost: no readable pool depth yet. Buy refused for safety."
      : "No usable price for it right now. Buy refused for safety.";
  }
  const slipText = Number.isFinite(slippage) ? `${(slippage * 100).toFixed(2)}%` : "unknown";
  const fillText = fillPrice > 0 && Number.isFinite(fillPrice) ? fillPrice.toPrecision(6) : "unusable";
  const markText = mark > 0 && Number.isFinite(mark) ? mark.toPrecision(6) : "unusable";
  return `Entry slippage ${slipText} is above the ${(cap * 100).toFixed(2)}% cap (fill ${fillText} vs mark ${markText}). Buy refused.`;
}

/** True when the quote or fill is at or under the entry cap above the mark. */
export function entryPriceAllowed(mark: number, fillPrice: number, maxEntrySlippage: number): { ok: true; slippage: number } | EntrySlipRefusal {
  const cap = clampEntrySlippage(maxEntrySlippage);
  if (!(mark > 0) || !(fillPrice > 0) || !Number.isFinite(fillPrice) || !Number.isFinite(mark)) {
    return { ok: false, code: "ENTRY_SLIPPAGE", slippage: Number.NaN, message: entrySlippageMessage(Number.NaN, cap, fillPrice, mark) };
  }
  const slippage = (fillPrice - mark) / mark;
  if (slippage > cap + 1e-9) {
    return { ok: false, code: "ENTRY_SLIPPAGE", slippage, message: entrySlippageMessage(slippage, cap, fillPrice, mark) };
  }
  return { ok: true, slippage };
}

export function quotePaperBuy(
  mark: number,
  notionalUsd: number,
  liquidityUsd: number,
  maxEntrySlippage: number = HARD_RULES.maxEntrySlippage
): PaperFillQuote | EntrySlipRefusal {
  const cap = clampEntrySlippage(maxEntrySlippage);
  const slippage = slippageFor(notionalUsd, liquidityUsd, "buy");
  const fillPrice = mark > 0 && Number.isFinite(slippage) ? mark * (1 + slippage) : Number.NaN;
  const gate = entryPriceAllowed(mark, fillPrice, cap);
  if (!gate.ok) return { ...gate, slippage: Number.isFinite(slippage) ? slippage : gate.slippage };
  const feeUsd = ceilUsd(notionalUsd * (HARD_RULES.feeBps / 10_000));
  const spend = notionalUsd - feeUsd;
  const qty = spend / fillPrice;
  if (!(qty > 0) || !Number.isFinite(qty)) {
    return { ok: false, code: "ENTRY_SLIPPAGE", slippage, message: entrySlippageMessage(slippage, cap, fillPrice, mark) };
  }
  return { ok: true, fillPrice, slippage, feeUsd, qty, notionalUsd };
}

/**
 * Book money is a finite number of dollars at or above zero.
 * A negative or a NaN is a bug in the quote, not a fill.
 */
export function assertNonNegativeFinite(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

export interface ExitImpactRefusal {
  ok: false;
  code: "EXIT_IMPACT";
  slippage: number;
  message: string;
}

export function exitImpactMessage(slippage: number, cap: number, exitCap?: number | null): string {
  if (!Number.isFinite(slippage)) return "Can't measure what a full sell would cost: no readable pool depth yet. Buy refused for safety.";
  const slipText = Number.isFinite(slippage) ? `${(slippage * 100).toFixed(2)}%` : "unknown";
  if (exitCap != null) {
    return `A full exit would cost ${slipText}, more than your ${(exitCap * 100).toFixed(2)}% exit slippage setting. Buy refused.`;
  }
  const limit = cap + HARD_RULES.exitImpactSlack;
  return `A full exit would cost ${slipText}, more than the ${(cap * 100).toFixed(2)}% entry cap plus ${(HARD_RULES.exitImpactSlack * 100).toFixed(0)}% (${(limit * 100).toFixed(2)}%). Buy refused.`;
}

/** v13.3 the full-exit limit: the exit setting when set, else entry cap + exitImpactSlack. Capped below 100%. */
export function exitLimit(maxEntrySlippage: number, maxExitSlippage?: number | null): number {
  const cap = clampEntrySlippage(maxEntrySlippage);
  const limit = maxExitSlippage != null && Number.isFinite(maxExitSlippage) ? maxExitSlippage : cap + HARD_RULES.exitImpactSlack;
  return Math.min(0.5, Math.max(0.005, limit));
}

/**
 * Estimate selling the whole position back into the same pool.
 * Refuse when that haircut is wider than the entry cap plus a few percent.
 */
export function exitImpactAllowed(
  notionalUsd: number,
  liquidityUsd: number,
  maxEntrySlippage: number = HARD_RULES.maxEntrySlippage,
  maxExitSlippage?: number | null
): { ok: true; slippage: number } | ExitImpactRefusal {
  const cap = clampEntrySlippage(maxEntrySlippage);
  const slippage = slippageFor(notionalUsd, liquidityUsd, "sell");
  const limit = exitLimit(cap, maxExitSlippage);
  if (!Number.isFinite(slippage) || slippage > limit + 1e-9) {
    return { ok: false, code: "EXIT_IMPACT", slippage, message: exitImpactMessage(slippage, cap, maxExitSlippage ?? null) };
  }
  return { ok: true, slippage };
}

export function quotePaperSell(mark: number, qty: number, liquidityUsd: number): PaperFillQuote {
  if (!(mark > 0) || !Number.isFinite(mark) || !(qty > 0) || !Number.isFinite(qty)) {
    return checkedQuote({
      ok: true,
      fillPrice: 0,
      slippage: 0,
      feeUsd: 0,
      qty: 0,
      notionalUsd: 0,
      proceedsUsd: 0
    });
  }
  const raw = slippageFor(qty * mark, liquidityUsd, "sell");
  // Constant-product impact is below 1. A missing pool is a total loss of proceeds, not a negative price.
  // A pool that still has liquidity cannot fill at 0: keep the mark and a haircut that stays under 100%.
  let slippage = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
  let fillPrice = slippage >= 1 ? 0 : mark * (1 - slippage);
  if (!(fillPrice > 0) && liquidityUsd > 0 && mark > 0) {
    slippage = Math.min(0.99, Number.isFinite(raw) && raw > 0 ? raw : HARD_RULES.baseSlippage);
    fillPrice = mark * (1 - slippage);
  }
  const gross = qty * fillPrice;
  const grossCents = floorUsd(Math.max(0, gross));
  let feeUsd = ceilUsd(Math.max(0, gross) * (HARD_RULES.feeBps / 10_000));
  // The 10 bps fee ceils to the next cent. On a sub-cent gross that cent is larger than the sale.
  if (feeUsd > grossCents) feeUsd = grossCents;
  const proceedsUsd = floorUsd(Math.max(0, gross - feeUsd));
  return checkedQuote({
    ok: true,
    fillPrice,
    slippage,
    feeUsd,
    qty,
    notionalUsd: roundUsd(Math.max(0, gross)),
    proceedsUsd
  });
}

function checkedQuote(quote: PaperFillQuote): PaperFillQuote {
  assertNonNegativeFinite("fillPrice", quote.fillPrice);
  assertNonNegativeFinite("feeUsd", quote.feeUsd);
  assertNonNegativeFinite("notionalUsd", quote.notionalUsd);
  assertNonNegativeFinite("proceedsUsd", quote.proceedsUsd ?? 0);
  if ((quote.proceedsUsd ?? 0) - quote.notionalUsd > 1e-9) {
    throw new Error("proceedsUsd cannot exceed the sale notional");
  }
  return quote;
}

/**
 * Average slippage against a constant-product pool. Reserve R is one side of the pool:
 *   buy  x USD: slippage = x / R
 *   sell y USD: slippage = y / (R + y)
 * Both grow with size against that reserve. Neither is clipped to a flat percent.
 * Unknown or non-positive liquidity is infinite, so a buy is refused and a paper
 * sell of an already-open position books a zero fill instead of a made-up price.
 */
export function slippageFor(notionalUsd: number, liquidityUsd: number, side: "buy" | "sell" = "buy"): number {
  if (!(liquidityUsd > 0) || !Number.isFinite(liquidityUsd)) return Number.POSITIVE_INFINITY;
  if (!(notionalUsd > 0) || !Number.isFinite(notionalUsd)) return Number.POSITIVE_INFINITY;
  const reserve = liquidityUsd * HARD_RULES.poolSideShare;
  if (!(reserve > 0) || !Number.isFinite(reserve)) return Number.POSITIVE_INFINITY;
  const share = notionalUsd / reserve;
  const impact = side === "buy" ? share : share / (1 + share);
  return HARD_RULES.baseSlippage + impact;
}

/**
 * Largest buy, in whole cents, that this pool takes under the entry slippage cap and the
 * full-exit depth check. Unknown liquidity is 0. Used for the Add coin slider and messages.
 */
export function maxSizeForPool(
  liquidityUsd: number,
  maxEntrySlippage: number = HARD_RULES.maxEntrySlippage,
  maxExitSlippage?: number | null
): number {
  if (!(liquidityUsd > 0) || !Number.isFinite(liquidityUsd)) return 0;
  const cap = clampEntrySlippage(maxEntrySlippage);
  const reserve = liquidityUsd * HARD_RULES.poolSideShare;
  const entryRoom = cap - HARD_RULES.baseSlippage;
  const exitRoom = exitLimit(cap, maxExitSlippage) - HARD_RULES.baseSlippage;
  if (!(entryRoom > 0) || !(exitRoom > 0) || exitRoom >= 1) return 0;
  const byEntry = entryRoom * reserve;
  const byExit = (exitRoom * reserve) / (1 - exitRoom);
  const raw = Math.min(byEntry, byExit);
  // Step back a cent so float noise cannot put the edge one cent over a cap.
  return Math.max(0, floorUsd(raw) - 0.01);
}

export interface PositionSplit {
  ok: true;
  fraction: number;
  sellQty: number;
  soldCostUsd: number;
  remainQty: number;
  remainCostUsd: number;
}

/**
 * Partial sell math. Qty and cost basis are cut by the same fraction, so the average entry
 * price of the remainder is unchanged. Cost is split in cents and the two halves always add
 * back to the original cost. Fail closed on anything not finite and positive.
 */
export function splitPosition(qty: number, costUsd: number, fraction: number): PositionSplit | { ok: false; error: string } {
  if (!(qty > 0) || !Number.isFinite(qty)) return { ok: false, error: "Position quantity is not usable." };
  if (!(costUsd >= 0) || !Number.isFinite(costUsd)) return { ok: false, error: "Position cost is not usable." };
  if (!(fraction > 0) || !Number.isFinite(fraction) || fraction > 1) return { ok: false, error: "Sell fraction must be above 0 and at most 1." };
  if (fraction === 1) return { ok: true, fraction, sellQty: qty, soldCostUsd: costUsd, remainQty: 0, remainCostUsd: 0 };
  const sellQty = qty * fraction;
  const remainQty = qty - sellQty;
  const soldCostUsd = roundUsd(costUsd * fraction);
  const remainCostUsd = roundUsd(costUsd - soldCostUsd);
  if (!(sellQty > 0) || !(remainQty > 0)) return { ok: false, error: "Sell fraction rounds to nothing." };
  return { ok: true, fraction, sellQty, soldCostUsd, remainQty, remainCostUsd };
}
