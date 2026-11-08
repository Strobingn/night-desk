/** How far a live swap got. A timeout is not the same as a rejected quote. */
export type LiveSubmitState = "not_submitted" | "submitted_unknown" | "rejected";

export const QUOTE_TIMEOUT_MS = 8_000;
export const SWAP_TIMEOUT_MS = 8_000;
/** Confirmation used to wait until the blockhash expired. Bound it so the desk can answer. */
export const CONFIRM_TIMEOUT_MS = 20_000;

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
