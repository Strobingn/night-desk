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

/** v13.8 card line: source first, then a precise age ("on-chain · 0.3s", "DexScreener · 12s"). */
export function sourceAgeLabel(feed: string | undefined, ageMs: number): string {
  const src = feed === "chain" ? "on-chain" : feedLabel(feed) || "mark";
  if (!Number.isFinite(ageMs)) return `${src} · no mark yet`;
  const ms = Math.max(0, ageMs);
  const age = ms < 10_000 ? `${(ms / 1_000).toFixed(1)}s` : ms < 60_000 ? `${Math.floor(ms / 1_000)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`;
  return `${src} · ${age}`;
}

/** Age right now, from the local time the mark was taken. No server clock is needed. */
export function liveAgeMs(pos: PositionView, nowMs: number): number {
  if (typeof pos.markLocalAt === "number" && pos.markLocalAt > 0) return Math.max(0, nowMs - pos.markLocalAt);
  return pos.markAgeMs ?? Number.POSITIVE_INFINITY;
}

/** Stamps each position with the local time its mark was taken. */
export function stampSnapshot(snap: DeskSnapshot, receivedAt: number): DeskSnapshot {
  const stamp = (rows: PositionView[]) => rows.map((pos) => ({ ...pos, markLocalAt: receivedAt - Math.max(0, pos.markAgeMs ?? 0) }));
  const live = snap.liveBook?.positions?.length ? { ...snap.liveBook, positions: stamp(snap.liveBook.positions) } : snap.liveBook;
  if (!snap.positions?.length && live === snap.liveBook) return snap;
  return { ...snap, positions: stamp(snap.positions ?? []), liveBook: live };
}

const usable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Merges a {"type":"marks"} delta into the last snapshot. Unknown mints are ignored, nothing is
 * removed, and a row without a usable mark (0, NaN) leaves the card on its last good mark.
 */
export function mergeMarks(snap: DeskSnapshot | null, delta: MarksDelta, receivedAt: number): DeskSnapshot | null {
  if (!snap || !delta || !Array.isArray(delta.positions)) return snap;
  const paper = mergeRows(snap.positions, delta.positions, receivedAt);
  // v13.7: the live book's cards ride in delta.live on an armed desk.
  const liveRows = delta.live && Array.isArray(delta.live.positions) ? delta.live.positions : null;
  const live = snap.liveBook && liveRows ? mergeRows(snap.liveBook.positions, liveRows, receivedAt) : null;
  if (!paper.touched && !live?.touched) return snap;
  return {
    ...snap,
    positions: paper.positions,
    cashUsd: paper.touched && usable(delta.cashUsd) ? delta.cashUsd : snap.cashUsd,
    equityUsd: paper.touched && usable(delta.equityUsd) ? delta.equityUsd : snap.equityUsd,
    ...(snap.liveBook && live?.touched
      ? {
          liveBook: {
            ...snap.liveBook,
            positions: live.positions,
            cashUsd: usable(delta.live?.cashUsd) ? delta.live!.cashUsd : snap.liveBook.cashUsd,
            cashKnown: typeof delta.live?.cashKnown === "boolean" ? delta.live.cashKnown : snap.liveBook.cashKnown,
            balanceError: delta.live && "balanceError" in delta.live ? delta.live.balanceError ?? null : snap.liveBook.balanceError,
            equityUsd: usable(delta.live?.equityUsd) ? delta.live!.equityUsd : snap.liveBook.equityUsd,
            openPnlUsd: live.positions.reduce((sum, p) => sum + p.pnlUsd, 0)
          }
        }
      : {})
  };
}

function mergeRows(rows: PositionView[], delta: MarksDelta["positions"], receivedAt: number): { positions: PositionView[]; touched: boolean } {
  const byMint = new Map(delta.filter((row) => usable(row.markPrice) && row.markPrice > 0).map((row) => [row.mint, row]));
  let touched = false;
  const positions = rows.map((pos) => {
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
      markLocalAt: receivedAt - Math.max(0, usable(row.markAgeMs) ? row.markAgeMs : 0),
      netPnlUsd: row.netPnlUsd === null || usable(row.netPnlUsd) ? row.netPnlUsd : pos.netPnlUsd,
      netPnlPct: row.netPnlPct === null || usable(row.netPnlPct) ? row.netPnlPct : pos.netPnlPct,
      exitSlippage: row.exitSlippage === null || usable(row.exitSlippage) ? row.exitSlippage : pos.exitSlippage,
      marks: Array.isArray(row.marks) ? row.marks : pos.marks
    };
  });
  return { positions, touched };
}
