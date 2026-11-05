import type { MarkPoint, Position } from "../types.js";

export const MARK_SERIES_CAP = 64;
const MARK_SERIES_GAP_MS = 2_000;

export class PaperBook {
  positions = new Map<string, Position>();
  lastPrice = new Map<string, number>();
  /** Wall time of the last fresh mark per mint. */
  lastMarkAt = new Map<string, number>();
  /** Compact price history for held coins. Fed only while the mint is open. */
  series = new Map<string, MarkPoint[]>();

  constructor(public cashUsd: number) {}

  mark(mint: string, priceUsd: number, at = Date.now()): void {
    if (priceUsd > 0) {
      this.lastPrice.set(mint, priceUsd);
      this.lastMarkAt.set(mint, at);
    }
  }

  markedAt(mint: string): number | undefined {
    return this.lastMarkAt.get(mint);
  }

  price(mint: string, fallback?: number): number {
    return this.lastPrice.get(mint) ?? fallback ?? 0;
  }

  equity(): number {
    let marked = 0;
    for (const pos of this.positions.values()) {
      const px = this.price(pos.mint, pos.entryPrice);
      marked += pos.qty * px;
    }
    return this.cashUsd + marked;
  }

  get(mint: string): Position | undefined {
    return this.positions.get(mint);
  }

  /** Record a print for a coin that is actually held. Identical prints inside 2s refresh the last point. */
  noteMark(mint: string, priceUsd: number, at: number): void {
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd) || !Number.isFinite(at)) return;
    if (!this.positions.has(mint)) return;
    const row = this.series.get(mint) ?? [];
    const last = row[row.length - 1];
    if (last && last.priceUsd === priceUsd && at - last.t < MARK_SERIES_GAP_MS) last.t = at;
    else {
      row.push({ t: at, priceUsd });
      if (row.length > MARK_SERIES_CAP) row.splice(0, row.length - MARK_SERIES_CAP);
    }
    this.series.set(mint, row);
  }

  points(mint: string): MarkPoint[] {
    return this.series.get(mint) ?? [];
  }

  dropSeries(mint: string): void {
    this.series.delete(mint);
  }

  restoreSeries(mint: string, points: MarkPoint[]): void {
    const clean = points.filter((p) => p && p.priceUsd > 0 && Number.isFinite(p.priceUsd) && Number.isFinite(p.t)).slice(-MARK_SERIES_CAP);
    if (clean.length) this.series.set(mint, clean.map((p) => ({ t: p.t, priceUsd: p.priceUsd })));
  }
}
