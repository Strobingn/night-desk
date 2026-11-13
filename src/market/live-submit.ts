/** How far a live swap got. A timeout is not the same as a rejected quote. */
export type LiveSubmitState = "not_submitted" | "submitted_unknown" | "rejected";

export const QUOTE_TIMEOUT_MS = 8_000;
export const SWAP_TIMEOUT_MS = 8_000;
/** Confirmation used to wait until the blockhash expired. Bound it so the desk can answer. */
export const CONFIRM_TIMEOUT_MS = 20_000;
/**
 * v13.39: a live *sell* must answer in a few seconds — no route, liquidity gone, or
 * exit impact — so the phone's live client can show the reason instead of "timeout".
 * Live buys keep the 8s quote budget. This cap covers decimals, token-account, and quote
 * before a transaction exists. A send already in flight is not aborted.
 */
export const SELL_PRE_SEND_MS = 4_000;
/** A sell of a just-filled position waits this long for the token account, then uses the booked qty. */
export const RECENT_FILL_TOKEN_MS = 750;
/** Shown when a sell has no quote at all. The card note stays "Liquidity gone, no sell route". */
export const POOL_DRAINED_MESSAGE = "No sell route, pool drained. Nothing was sent.";
export const NO_SELL_ROUTE_MESSAGE = POOL_DRAINED_MESSAGE;
export const SELL_QUOTE_TIMEOUT_MESSAGE = "Live sell quote timed out. Nothing was sent.";
export const SELL_EXIT_IMPACT_MESSAGE = (slippage: number, cap: number): string =>
  `Live exit would cost ${(slippage * 100).toFixed(2)}%, more than your ${(cap * 100).toFixed(2)}% exit slippage setting. Nothing was sent.`;

/**
 * A live swap that did not become a booked fill.
 * `submitted_unknown` means a signature may already be on the network. Do not send another one.
 */
export class LiveSubmitError extends Error {
  readonly submitState: LiveSubmitState;
  readonly signature: string | null;
  readonly code: "LIVE_NOT_SUBMITTED" | "LIVE_UNCONFIRMED" | "LIVE_SWAP_FAILED";

  constructor(message: string, submitState: LiveSubmitState, signature: string | null) {
    super(message);
    this.name = "LiveSubmitError";
    this.submitState = submitState;
    this.signature = signature;
    this.code = submitState === "not_submitted" ? "LIVE_NOT_SUBMITTED" : submitState === "submitted_unknown" ? "LIVE_UNCONFIRMED" : "LIVE_SWAP_FAILED";
  }
}

export function isAmbiguousSendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|429|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|aborted|network error|already been processed|was not confirmed/i.test(message);
}

/** Quote and swap-build failures happen before a transaction exists. */
export function preSendFailure(stage: "quote" | "swap", status: number | "timeout"): LiveSubmitError {
  const where = stage === "quote" ? "quote" : "swap build";
  const budget = stage === "quote" ? QUOTE_TIMEOUT_MS : SWAP_TIMEOUT_MS;
  const why = status === "timeout" ? `timed out after ${budget / 1000}s` : `refused with HTTP ${status}`;
  return new LiveSubmitError(`Live ${where} ${why}. Nothing was sent.`, "not_submitted", null);
}

export function unconfirmedSend(signature: string | null, side: "buy" | "sell"): LiveSubmitError {
  if (signature) {
    return new LiveSubmitError(
      `Live ${side} was submitted. Confirmation is unknown, so it was not booked and nothing new was sent. Signature ${signature}.`,
      "submitted_unknown",
      signature
    );
  }
  return new LiveSubmitError(
    `The live ${side} send did not return a signature. It may already be on the network. Nothing new was sent.`,
    "submitted_unknown",
    null
  );
}

export function rejectedSend(signature: string, side: "buy" | "sell"): LiveSubmitError {
  return new LiveSubmitError(`Live ${side} transaction ${signature} failed on chain. Nothing was filled.`, "rejected", signature);
}

/** Jupiter lite-api returns HTTP 400 `{ errorCode: "NO_ROUTES_FOUND" }` when the pool cannot be sold. */
export function isNoRoutesBody(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 404) return false;
  const text =
    typeof body === "string"
      ? body
      : body && typeof body === "object"
        ? `${(body as { errorCode?: unknown; error?: unknown }).errorCode ?? ""} ${(body as { error?: unknown }).error ?? ""} ${JSON.stringify(body)}`
        : "";
  return /NO_ROUTES_FOUND|No routes found/i.test(text);
}

export function isNoSellRouteMessage(message: string): boolean {
  return /liquidity gone, no sell route|no sell route, pool drained|NO_ROUTES_FOUND|No routes found/i.test(message);
}

/** A manual sell may be confirmed past the exit cap. A missing route cannot. */
export function offersSellAnyway(error: string): boolean {
  if (isNoSellRouteMessage(error)) return false;
  return /would cost/i.test(error);
}

export function noSellRouteError(): LiveSubmitError {
  return new LiveSubmitError(NO_SELL_ROUTE_MESSAGE, "not_submitted", null);
}

export function sellQuoteTimeoutError(): LiveSubmitError {
  return new LiveSubmitError(SELL_QUOTE_TIMEOUT_MESSAGE, "not_submitted", null);
}

export function sellExitImpactError(slippage: number, cap: number): LiveSubmitError {
  return new LiveSubmitError(SELL_EXIT_IMPACT_MESSAGE(slippage, cap), "not_submitted", null);
}

export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
