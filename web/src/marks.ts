import type { DeskSnapshot, PositionView } from "./types";
import type { MarksDelta } from "../../src/types";

/** v13.2: amber past 10 s, red past 30 s. */
export const MARK_AMBER_MS = 10_000;
export const MARK_RED_MS = 30_000;

export type MarkFreshness = "fresh" | "amber" | "red";

export function markFreshness(ageMs: number): MarkFreshness {
  if (!Number.isFinite(ageMs) || ageMs > MARK_RED_MS) return "red";
  if (ageMs > MARK_AMBER_MS) return "amber";
  return "fresh";
}

export function updatedLabel(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "no mark yet";
  const ms = Math.max(0, ageMs);
  if (ms < 1_000) return "updated just now";
  if (ms < 60_000) return `updated ${Math.floor(ms / 1_000)}s ago`;
  if (ms < 3_600_000) return `updated ${Math.floor(ms / 60_000)}m ago`;
  return `updated ${Math.floor(ms / 3_600_000)}h ago`;
}

export function feedLabel(feed: string | undefined): string {
  switch (feed) {
    case "chain":
      return "pool";
    case "dexscreener":
      return "DexScreener";
    case "jupiter":
      return "Jupiter";
    case "pumpfun":
    case "scout":
      return "Pump";
    case undefined:
    case "":
      return "";
    default:
      return feed;
  }
}

/** Age right now, from the local time the mark was taken. No server clock is needed. */
export function liveAgeMs(pos: PositionView, nowMs: number): number {
  if (typeof pos.markLocalAt === "number" && pos.markLocalAt > 0) return Math.max(0, nowMs - pos.markLocalAt);
  return pos.markAgeMs ?? Number.POSITIVE_INFINITY;
}

/** Stamps each position with the local time its mark was taken. */
export function stampSnapshot(snap: DeskSnapshot, receivedAt: number): DeskSnapshot {
  if (!snap.positions?.length) return snap;
  return {
    ...snap,
    positions: snap.positions.map((pos) => ({ ...pos, markLocalAt: receivedAt - Math.max(0, pos.markAgeMs ?? 0) }))
  };
}

const usable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Merges a {"type":"marks"} delta into the last snapshot. Unknown mints are ignored, nothing is
 * removed, and a row without a usable mark (0, NaN) leaves the card on its last good mark.
 */
export function mergeMarks(snap: DeskSnapshot | null, delta: MarksDelta, receivedAt: number): DeskSnapshot | null {
  if (!snap || !delta || !Array.isArray(delta.positions)) return snap;
  const byMint = new Map(delta.positions.filter((row) => usable(row.markPrice) && row.markPrice > 0).map((row) => [row.mint, row]));
  let touched = false;
  const positions = snap.positions.map((pos) => {
    const row = byMint.get(pos.mint);
    if (!row) return pos;
    touched = true;
    return {
      ...pos,
      markPrice: row.markPrice,
      marketValueUsd: usable(row.marketValueUsd) ? row.marketValueUsd : pos.marketValueUsd,
      pnlUsd: usable(row.pnlUsd) ? row.pnlUsd : pos.pnlUsd,
      pnlPct: usable(row.pnlPct) ? row.pnlPct : pos.pnlPct,
      stopPrice: usable(row.stopPrice) ? row.stopPrice : pos.stopPrice,
      peakPrice: usable(row.peakPrice) ? row.peakPrice : pos.peakPrice,
      trailArmed: typeof row.trailArmed === "boolean" ? row.trailArmed : pos.trailArmed,
      trailHintPrice: row.trailHintPrice === null || usable(row.trailHintPrice) ? row.trailHintPrice : pos.trailHintPrice,
      markAgeMs: usable(row.markAgeMs) ? row.markAgeMs : pos.markAgeMs,
      markAt: usable(row.markAt) ? row.markAt : pos.markAt,
      markFeed: row.markFeed || pos.markFeed,
      markLocalAt: receivedAt - Math.max(0, usable(row.markAgeMs) ? row.markAgeMs : 0)
    };
  });
  if (!touched) return snap;
  return {
    ...snap,
    positions,
    cashUsd: usable(delta.cashUsd) ? delta.cashUsd : snap.cashUsd,
    equityUsd: usable(delta.equityUsd) ? delta.equityUsd : snap.equityUsd
  };
}
