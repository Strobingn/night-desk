/** A print this far through the entry, inside the entry window, has to be seen twice. */
export const SHOCK_WINDOW_MS = 10_000;
export const SHOCK_MOVE = 0.3;

export type PriceFeed = "dexscreener" | "jupiter" | "gecko" | "scout" | "replay" | "listing";

export interface MarkOrigin {
  feed?: string;
  pairAddress?: string;
  dex?: string;
  liquidityUsd?: number;
}

export interface MarkAnchor {
  priceFeed?: string;
  pairAddress?: string;
  dex?: string;
  source?: string;
}

/** ≤0, NaN, and non-numbers are not prices. */
export function markUnusable(price: number): boolean {
  return typeof price !== "number" || !Number.isFinite(price) || !(price > 0);
}

/**
 * A held position only accepts a mark from the feed and pool that priced the entry.
 * A tick with no feed and no pool is an operator or replay mark and is allowed.
 */
export function sameMarkSource(anchor: MarkAnchor, origin?: MarkOrigin): boolean {
  if (!origin) return true;
  const feed = origin.feed;
  const pair = origin.pairAddress;
  if (!feed && !pair) return true;
  if (anchor.pairAddress && pair && anchor.pairAddress !== pair) return false;
  if (anchor.priceFeed && feed && anchor.priceFeed !== feed) return false;
  if (feed && !anchor.priceFeed && anchor.pairAddress && !pair) return false;
  if (feed && !anchor.priceFeed && !anchor.pairAddress && anchor.source === "pumpfun" && feed !== "scout" && feed !== anchor.priceFeed) {
    return false;
  }
  return true;
}

/**
 * True when this print is past −30% and still inside 10 seconds of the fill.
 * The −6% stop itself is not delayed. Only the unverified gap is.
 */
export function needsShockConfirm(entryPrice: number, mark: number, openedAt: number, now: number): boolean {
  if (!(entryPrice > 0) || markUnusable(mark)) return false;
  if (now - openedAt > SHOCK_WINDOW_MS) return false;
  return (mark - entryPrice) / entryPrice < -SHOCK_MOVE;
}
