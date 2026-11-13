import { isNoRoutesBody, isNoSellRouteMessage } from "./live-submit.js";

/** A holding worth less than this, with the mark already 99% under entry, is dead on the card. */
export const DEAD_VALUE_USD = 0.01;
/** A drop of this much from entry, held across several prints, is dead even if a few cents remain. */
export const DEAD_DROP = 0.99;
/** How many collapsed observations a 99% drop has to last before the card moves. */
export const DEAD_MARKS = 3;
/** Observations closer than this are the same print. The chart series dedupes those. */
export const DEAD_MARK_GAP_MS = 1_500;

export interface CollapseStreak {
  n: number;
  at: number;
}

/**
 * Count a collapsed mark even when the chart keeps only one point.
 * Identical prints inside the gap do not add another count. A recovered mark clears it.
 */
export function noteCollapsedSample(prev: CollapseStreak | undefined, collapsed: boolean, at: number, gapMs = DEAD_MARK_GAP_MS): CollapseStreak | undefined {
  if (!collapsed || !(at > 0) || !Number.isFinite(at)) return undefined;
  if (!prev) return { n: 1, at };
  if (at - prev.at < gapMs) return prev;
  return { n: prev.n + 1, at };
}

export function markCollapsed(entryPrice: number, markPrice: number): boolean {
  return entryPrice > 0 && markPrice > 0 && Number.isFinite(entryPrice) && Number.isFinite(markPrice) && markPrice <= entryPrice * (1 - DEAD_DROP);
}

/**
 * Display-only. A collapsed mark is dead when the position is worth under a cent,
 * or when a 99% drop has already held for several prints. One wick is not enough
 * unless the value is already gone.
 */
export function deadFromMarks(input: {
  entryPrice: number;
  qty: number;
  markPrice: number;
  marks: readonly number[];
}): "value" | "drop" | null {
  const { entryPrice, qty, markPrice, marks } = input;
  const value = qty > 0 && markPrice > 0 && Number.isFinite(qty) && Number.isFinite(markPrice) ? qty * markPrice : Number.POSITIVE_INFINITY;
  if (Number.isFinite(value) && value < DEAD_VALUE_USD && markCollapsed(entryPrice, markPrice)) return "value";
  const recent = marks.filter((px) => px > 0 && Number.isFinite(px)).slice(-DEAD_MARKS);
  if (recent.length >= DEAD_MARKS && recent.every((px) => markCollapsed(entryPrice, px))) return "drop";
  return null;
}

/**
 * Read-only Jupiter quote. GET only. A missing route is "no_route".
 * Anything else, including a timeout, is not treated as a dead pool.
 */
export async function readSellRoute(input: {
  quoteUrl: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  fetchImpl?: typeof fetch;
}): Promise<"route" | "no_route" | "unknown"> {
  if (!input.quoteUrl || !input.inputMint || !input.outputMint || !(Number(input.amount) > 0)) return "unknown";
  let url: URL;
  try {
    url = new URL(input.quoteUrl);
  } catch {
    return "unknown";
  }
  url.searchParams.set("inputMint", input.inputMint);
  url.searchParams.set("outputMint", input.outputMint);
  url.searchParams.set("amount", input.amount);
  url.searchParams.set("slippageBps", "50");
  const fetchImpl = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(4_000) });
  } catch {
    return "unknown";
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (isNoRoutesBody(res.status, body)) return "no_route";
  const text = body && typeof body === "object" ? JSON.stringify(body) : "";
  if (isNoSellRouteMessage(text)) return "no_route";
  if (res.ok && body && typeof body === "object" && typeof (body as { outAmount?: unknown }).outAmount === "string" && (body as { outAmount: string }).outAmount.length > 0) {
    return "route";
  }
  return "unknown";
}
