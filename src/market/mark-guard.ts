/** A print this far through the entry, inside the entry window, has to be seen twice. */
export const SHOCK_WINDOW_MS = 10_000;
export const SHOCK_MOVE = 0.3;

export type PriceFeed = "dexscreener" | "jupiter" | "gecko" | "scout" | "replay" | "listing" | "chain";

export interface MarkOrigin {
  feed?: string;
  pairAddress?: string;
  dex?: string;
  liquidityUsd?: number;
  /** v13.39: quote-token liquidity in USD, when the pair printed it. */
  quoteUsd?: number;
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
/**
 * v13.20 one print this many times the last good mark is not a price.
 * A real move can still arrive in smaller steps. A drop is never rejected here:
 * a genuine rug has to reach the stop.
 */
export const ABSURD_RISE = 25;

/**
 * Upward unit/decimal or SOL-vs-USD confusion, or an implausible jump vs the last good mark.
 * Null means the print may update equity. A crash is never an outlier.
 */
/** How long a Dex or Jupiter print may confirm a chain mark or a large rise. */
export const QUOTE_CONFIRM_MS = 60_000;

/**
 * The anchor for an upward sanity check. A saved mark already dozens of times entry
 * is not "last good" — the first chain read can poison it and then agree with itself.
 */
export function entryAnchor(entry: number, lastGood: number): number {
  if (!(entry > 0) || !Number.isFinite(entry)) return lastGood;
  if (!(lastGood > 0) || !Number.isFinite(lastGood) || lastGood / entry >= ABSURD_RISE) return entry;
  return lastGood;
}

/** True when some other feed's price is within ABSURD_RISE of this print. */
export function quoteConfirms(next: number, quotes: Array<number | undefined>): boolean {
  if (!(next > 0) || !Number.isFinite(next)) return false;
  return quotes.some((q) => q != null && q > 0 && Number.isFinite(q) && next / q < ABSURD_RISE && q / next < ABSURD_RISE);
}

export function outlierReason(lastGood: number, next: number): "unit" | "spike" | null {
  if (!(lastGood > 0) || !(next > 0) || !Number.isFinite(next)) return null;
  const ratio = next / lastGood;
  if (!(ratio > 1)) return null;
  if (unitScale(ratio)) return "unit";
  if (ratio >= ABSURD_RISE) return "spike";
  return null;
}

/**
 * How many times apart the entry and the mark are.
 * A first print this far from entry is not a usable stop. A second agreeing print still is.
 */
export function absurdScale(entry: number, mark: number): number {
  if (!(entry > 0) || !(mark > 0) || !Number.isFinite(entry) || !Number.isFinite(mark)) return 1;
  return Math.max(mark / entry, entry / mark);
}

/** True when the ratio sits on ×1e3, ×1e6 or ×1e9 (a decimals or SOL/USD mix-up, either direction). */
export function unitScale(ratio: number): boolean {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return false;
  const scale = ratio >= 1 ? ratio : 1 / ratio;
  for (const step of [1e3, 1e6, 1e9]) {
    if (Math.abs(scale / step - 1) < 0.08) return true;
  }
  return false;
}

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
  // A silent entry feed must not adopt a Jupiter print that is dozens of times the last good mark.
  if (!markUnusable(lastGood) && outlierReason(lastGood, price)) return { verdict: "refuse" };
  const key = `${feed}|${origin.pairAddress ?? ""}`;
  const fresh: ReanchorCandidate = { key, feed, pairAddress: origin.pairAddress, dex: origin.dex, price, at: now };
  if (!pending || pending.key !== key) return { verdict: "wait", next: fresh };
  if (Math.abs(price / pending.price - 1) > REANCHOR_AGREE) return { verdict: "wait", next: fresh };
  if (now - pending.at < REANCHOR_GAP_MS) return { verdict: "wait", next: pending };
  return { verdict: "adopt" };
}

/**
 * v13.39: quote-side USD below this, while a mid still looks valuable, is a drained
 * pool — not a sellable price. Real rugs (a mid that actually crashed) still pass.
 */
export const QUOTE_SIDE_GONE_USD = 0.05;

/** A mark the book can store when residual USD is 0, so applyMark and stops still run. */
export const DUST_MARK_USD = 1e-18;

export function quoteSideDrained(input: {
  quoteUsd?: number | null;
  midValueUsd?: number | null;
  liquidityUsd?: number | null;
}): boolean {
  const quote = input.quoteUsd;
  if (quote == null || !Number.isFinite(quote) || quote < 0) return false;
  if (quote > QUOTE_SIDE_GONE_USD) return false;
  const mid = input.midValueUsd ?? 0;
  const liq = input.liquidityUsd ?? 0;
  // Empty quote side, or a mid/token-side that still prints dollars on a drained pool.
  return quote <= 0.01 || mid > 1 || liq > 1;
}

/** Honest residual a seller could take from the quote side. Never the stale mid. */
export function residualExitUsd(input: { quoteUsd?: number | null; midValueUsd?: number | null }): number {
  const quote = input.quoteUsd;
  if (quote != null && Number.isFinite(quote) && quote >= 0) {
    const mid = input.midValueUsd;
    if (mid != null && Number.isFinite(mid) && mid >= 0) return Math.min(quote, mid);
    return quote;
  }
  return 0;
}

export function residualMarkPrice(residualUsd: number, qty: number): number {
  if (!(qty > 0)) return DUST_MARK_USD;
  const px = Math.max(0, residualUsd) / qty;
  return px > 0 && Number.isFinite(px) ? px : DUST_MARK_USD;
}

