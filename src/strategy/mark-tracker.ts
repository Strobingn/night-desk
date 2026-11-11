import { STRATEGY, type StrategyConfig } from "./config.js";

export interface TrackedMark {
  at: number;
  priceUsd: number;
  vol5mUsd: number | null;
  vol1hUsd: number | null;
  change1hPct: number | null;
}

/** Recent marks for the few coins the engine is watching. Holds nothing for any other coin. */
export class MarkTracker {
  private readonly watched = new Map<string, { since: number; marks: TrackedMark[] }>();

  constructor(private readonly cfg: StrategyConfig = STRATEGY) {}

  /** Start (or keep) watching a coin. When full, the coin watched longest is dropped. */
  watch(mint: string, now: number): void {
    if (!mint || this.watched.has(mint)) return;
    this.watched.set(mint, { since: now, marks: [] });
    while (this.watched.size > this.cfg.watch.maxCoins) {
      const oldest = this.watched.keys().next().value;
      if (oldest == null) break;
      this.watched.delete(oldest);
    }
  }

  has(mint: string): boolean {
    return this.watched.has(mint);
  }

  mints(): string[] {
    return [...this.watched.keys()];
  }

  drop(mint: string): void {
    this.watched.delete(mint);
  }

  /** Record a print for a watched coin. A bad price or a repeat of the last print is ignored. */
  note(mint: string, mark: TrackedMark): boolean {
    const row = this.watched.get(mint);
    if (!row) return false;
    if (!(mark.priceUsd > 0) || !Number.isFinite(mark.priceUsd) || !Number.isFinite(mark.at)) return false;
    const last = row.marks[row.marks.length - 1];
    if (last && mark.at <= last.at) return false;
    row.marks.push({ ...mark });
    if (row.marks.length > this.cfg.watch.maxMarks) row.marks.splice(0, row.marks.length - this.cfg.watch.maxMarks);
    return true;
  }

  marks(mint: string): TrackedMark[] {
    return this.watched.get(mint)?.marks ?? [];
  }

  /** Stop watching coins past the watch window. Returns the mints dropped. */
  expire(now: number): string[] {
    const gone: string[] = [];
    for (const [mint, row] of this.watched) {
      if (now - row.since >= this.cfg.watch.maxWatchMs) gone.push(mint);
    }
    for (const mint of gone) this.watched.delete(mint);
    return gone;
  }
}
