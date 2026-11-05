/**
 * Desk score, 0–100, from hold time and volume only.
 *
 * score = round(100 * (0.5 * holdFactor + 0.5 * volumeFactor))
 *
 * holdFactor = min(1, volumeWeightedHoldMs / 24h)
 *   Fills match FIFO per wallet and mint. Each token that is sold contributes
 *   (sell time − buy time). Each token still open contributes (now − buy time).
 *   The average is weighted by raw token amount. Tokens with no buy do not
 *   enter the hold average. No tokens → holdFactor 0.
 *
 * volumeFactor = min(1, tradedLamports / 10 SOL)
 *   tradedLamports is the sum of quote lamports on buys and sells. Fees are
 *   not added on top of that size.
 *
 * The two factors weigh equally. A book that holds a full day on a
 * volume-weighted basis and trades 10 SOL scores 100. An empty book scores 0.
 */
import type { JournalEntry } from "../journal/journal.js";

export const HOLD_TARGET_MS = 24 * 60 * 60 * 1000;
export const VOLUME_TARGET_LAMPORTS = 10_000_000_000n;

export const DESK_SCORE_FORMULA =
  "score = round(100 * (0.5 * holdFactor + 0.5 * volumeFactor)). " +
  "holdFactor = min(1, volumeWeightedHoldMs / 24h), where hold is the FIFO token-weighted time from buy to sell, or from buy to now if the tokens are still open. " +
  "volumeFactor = min(1, tradedLamports / 10 SOL), where tradedLamports sums quote size on buys and sells and does not add fees. " +
  "The factors weigh equally. A 24 hour weighted hold and 10 SOL of volume score 100. An empty book scores 0.";

export interface DeskScore {
  score: number;
  holdFactor: number;
  volumeFactor: number;
  holdMs: number;
  volumeLamports: string;
  formula: string;
}

interface Lot {
  tokens: bigint;
  ts: number;
}

export function deskScore(entries: readonly JournalEntry[], now: number): DeskScore {
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp || (a.signature < b.signature ? -1 : 1));
  const books = new Map<string, Lot[]>();
  let weighted = 0n;
  let weight = 0n;
  let volume = 0n;
  for (const entry of sorted) {
    volume += BigInt(entry.solLamports);
    const key = `${entry.wallet}\u0000${entry.mint}`;
    const lots = books.get(key) ?? [];
    books.set(key, lots);
    if (entry.side === "buy") {
      lots.push({ tokens: BigInt(entry.tokenAmount), ts: entry.timestamp });
      continue;
    }
    let need = BigInt(entry.tokenAmount);
    while (need > 0n && lots.length > 0) {
      const lot = lots[0]!;
      const take = need < lot.tokens ? need : lot.tokens;
      weighted += BigInt(Math.max(0, entry.timestamp - lot.ts)) * take;
      weight += take;
      lot.tokens -= take;
      need -= take;
      if (lot.tokens === 0n) lots.shift();
    }
  }
  for (const lots of books.values()) {
    for (const lot of lots) {
      if (lot.tokens <= 0n) continue;
      weighted += BigInt(Math.max(0, now - lot.ts)) * lot.tokens;
      weight += lot.tokens;
    }
  }
  const holdMs = weight === 0n ? 0 : Number(weighted / weight);
  const holdFactor = Math.min(1, holdMs / HOLD_TARGET_MS);
  const volumeFactor = Math.min(1, Number(volume) / Number(VOLUME_TARGET_LAMPORTS));
  const score = Math.round(100 * (0.5 * holdFactor + 0.5 * volumeFactor));
  return {
    score,
    holdFactor,
    volumeFactor,
    holdMs,
    volumeLamports: volume.toString(),
    formula: DESK_SCORE_FORMULA
  };
}
