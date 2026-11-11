/** A live desk buy the server held for Buy anyway. Bound to that mint. */
export interface DeskHold {
  mint: string;
  reason: string;
}

/**
 * Apply a desk live-buy reply to the Pump Watch hold.
 * A reply for a mint the operator is no longer watching is ignored, so Buy anyway
 * cannot confirm a different coin. A confirm, or any other result on the watched mint, clears the hold.
 */
export function nextDeskHold(
  current: DeskHold | null,
  reply: {
    requestedMint: string;
    watchedMint: string | null;
    confirm: boolean;
    ok: boolean;
    code?: string;
    error?: string;
  }
): DeskHold | null {
  if (!reply.watchedMint || reply.watchedMint !== reply.requestedMint) return current;
  if (reply.confirm || reply.ok || reply.code !== "HARD_KILL") return null;
  const reason = reply.error?.trim() ? reply.error.trim() : "Hard kill.";
  return { mint: reply.requestedMint, reason };
}
