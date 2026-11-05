/** A print this far through the entry, inside the entry window, has to be seen twice. */
export const SHOCK_WINDOW_MS = 10_000;
export const SHOCK_MOVE = 0.3;

export type PriceFeed = "dexscreener" | "jupiter" | "gecko" | "scout" | "replay" | "listing" | "chain";

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

/** v13.2: any accepted mark that moves more than this from the last one has to be seen twice. */
export function isJump(last: number | undefined, mark: number): boolean {
  if (last == null || markUnusable(last) || markUnusable(mark)) return false;
  return Math.abs(mark / last - 1) > SHOCK_MOVE;
}

/** v13.2 re-anchor: the entry feed has been silent this long before another feed is considered. */
export const REANCHOR_SILENT_MS = 20_000;
/** Two prints from the candidate feed and pool, at least this far apart. */
export const REANCHOR_GAP_MS = 2_000;
/** …within this of each other. */
export const REANCHOR_AGREE = 0.25;
/** …and not dust: at least this fraction of the last good mark. */
export const REANCHOR_DUST = 0.01;
/** One PRICE_SOURCE / PRICE_UNUSABLE line per mint per window. */
export const LOG_THROTTLE_MS = 5 * 60_000;
/** A live (on-chain) mark this young wins the display over an older risk mark. */
export const LIVE_FRESH_MS = 5_000;

export interface ReanchorCandidate {
  key: string;
  feed: string;
  pairAddress?: string;
  dex?: string;
  price: number;
  at: number;
}

/**
 * Feeds a print from a non-entry source into the re-anchor check.
 * Returns "adopt" when this print confirms the pending candidate, "wait" when it starts
 * or keeps a candidate, "refuse" when it can never qualify (dust, unusable, chain).
 */
export function reanchorCandidate(
  pending: ReanchorCandidate | undefined,
  origin: MarkOrigin,
  price: number,
  lastGood: number,
  now: number
): { verdict: "adopt" | "wait" | "refuse"; next?: ReanchorCandidate } {
  const feed = origin.feed;
  if (!feed || feed === "chain" || markUnusable(price)) return { verdict: "refuse" };
  if (!markUnusable(lastGood) && price < lastGood * REANCHOR_DUST) return { verdict: "refuse" };
  const key = `${feed}|${origin.pairAddress ?? ""}`;
  const fresh: ReanchorCandidate = { key, feed, pairAddress: origin.pairAddress, dex: origin.dex, price, at: now };
  if (!pending || pending.key !== key) return { verdict: "wait", next: fresh };
  if (Math.abs(price / pending.price - 1) > REANCHOR_AGREE) return { verdict: "wait", next: fresh };
  if (now - pending.at < REANCHOR_GAP_MS) return { verdict: "wait", next: pending };
  return { verdict: "adopt" };
}
