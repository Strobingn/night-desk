import type { EquityPoint } from "../types.js";
import { visibleEquity } from "./equity-series.js";

export function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(rows[Math.round(i * step)]!);
  return out;
}

/** Recent raw points kept in memory. One point every 2 s, so this is about 22 hours. */
const RECENT_MAX = 40_000;
/** Older points are folded into this many so a weeks-old book does not grow without bound. */
const HEAD_MAX = 4_000;
/** The curve the clients draw. */
const VIEW_MAX = 240;

/**
 * The equity curve since the paper book started, kept in memory so a snapshot does not
 * re-read the whole equity table. Before 13.32 every push read every row since the last
 * paper reset (one row per 2 s, for as long as the book had been running) and downsampled
 * it again.
 */
export class EquityWindow {
  private head: EquityPoint[] = [];
  private recent: EquityPoint[] = [];
  private cached: EquityPoint[] | null = null;

  /** Replace the window with rows read once from the store. */
  load(rows: EquityPoint[]): void {
    this.head = [];
    this.recent = rows.slice();
    this.fold();
    this.cached = null;
  }

  push(point: EquityPoint): void {
    this.recent.push(point);
    if (this.recent.length > RECENT_MAX * 1.5) this.fold();
    this.cached = null;
  }

  clear(): void {
    this.head = [];
    this.recent = [];
    this.cached = null;
  }

  size(): number {
    return this.head.length + this.recent.length;
  }

  /** Downsampled, display-filtered curve. Recomputed only after a new point. */
  view(): EquityPoint[] {
    if (this.cached) return this.cached;
    const all = this.head.length ? this.head.concat(this.recent) : this.recent;
    this.cached = downsample(visibleEquity(all), VIEW_MAX);
    return this.cached;
  }

  private fold(): void {
    if (this.recent.length <= RECENT_MAX) return;
    const older = this.recent.slice(0, this.recent.length - RECENT_MAX);
    this.recent = this.recent.slice(this.recent.length - RECENT_MAX);
    this.head = downsample(this.head.concat(older), HEAD_MAX);
  }
}

/** A value that is recomputed only after `invalidate()`, so a hot query runs once per change. */
export class Cached<T> {
  private value: T | undefined;
  private valid = false;
  constructor(private readonly compute: () => T) {}

  get(): T {
    if (!this.valid) {
      this.value = this.compute();
      this.valid = true;
    }
    return this.value as T;
  }

  invalidate(): void {
    this.valid = false;
    this.value = undefined;
  }
}
