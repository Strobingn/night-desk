import type { Position } from "../types.js";

/** Recent marks kept per mint for the position sparkline. */
export const MARK_SERIES_CAP = 64;
/** Identical prints inside this window refresh the last point instead of growing the buffer. */
const SERIES_MIN_GAP_MS = 2_000;

export interface MarkPoint {
  t: number;
  priceUsd: number;
}

export class PaperBook {
  positions = new Map<string, Position>();
  lastPrice = new Map<string, number>();
  /** Wall time of the last live print. Absent until a tick stamps it. */
  markAt = new Map<string, number>();
  series = new Map<string, MarkPoint[]>();

  constructor(public cashUsd: number) {}

  /**
   * Record a price. `at` is set only for a live print. A restore passes no time so a
   * restarted book cannot look freshly marked.
   */
  mark(mint: string, priceUsd: number, at?: number): void {
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return;
    this.lastPrice.set(mint, priceUsd);
    if (at == null || !Number.isFinite(at)) return;
    this.markAt.set(mint, at);
    if (!this.positions.has(mint)) return;
    const row = this.series.get(mint) ?? [];
    const last = row[row.length - 1];
    if (last && last.priceUsd === priceUsd && at - last.t < SERIES_MIN_GAP_MS) {
      last.t = at;
    } else {
      row.push({ t: at, priceUsd });
      if (row.length > MARK_SERIES_CAP) row.splice(0, row.length - MARK_SERIES_CAP);
    }
    this.series.set(mint, row);
  }

  /** Reload a saved sparkline. The last point's time is the mark stamp, which may already be stale. */
  restoreSeries(mint: string, points: MarkPoint[]): void {
    const clean = points
      .filter((point) => point != null && point.priceUsd > 0 && Number.isFinite(point.priceUsd) && Number.isFinite(point.t))
      .slice(-MARK_SERIES_CAP);
    if (clean.length === 0) return;
    this.series.set(mint, clean);
    const last = clean[clean.length - 1]!;
    this.lastPrice.set(mint, last.priceUsd);
    this.markAt.set(mint, last.t);
  }

  seriesFor(mint: string): MarkPoint[] {
    return [...(this.series.get(mint) ?? [])];
  }

  forgetMarks(mint: string): void {
    this.lastPrice.delete(mint);
    this.markAt.delete(mint);
    this.series.delete(mint);
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
}
