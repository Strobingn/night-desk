import type { RawSighting } from "../types.js";

/**
 * v13.52 fast sweep.
 *
 * A Pump stream create carries no volume, so the free pre-filter parks it until some list feed
 * happens to print the coin again. Most never get that second print. The sweep goes and asks:
 * every parked coin is looked up on DexScreener's batched /tokens/v1 call (30 coins a request)
 * at the ages below, and promoted to enrich the moment its volume clears the desk's own floor.
 *
 * It spends no RPC read. A coin still costs its three enrich reads only after it passes.
 */

/** Seconds after a coin is first parked at which it is looked up again. */
export const SWEEP_LOOKS_MS = [10_000, 25_000, 45_000, 75_000, 120_000, 180_000, 300_000, 480_000, 720_000] as const;
export const SWEEP_TICK_MS = 2_000;
/** DexScreener takes 30 token addresses per request. */
export const SWEEP_BATCH = 30;
/** Two requests a tick is 60 a minute, out of the 240 a minute the desk budgets for this endpoint. */
export const SWEEP_BATCHES_PER_TICK = 2;
export const SWEEP_TRACK_MAX = 2_000;
/** After DexScreener refuses a sweep request, leave it alone this long. The Tape and enrich share the endpoint. */
export const SWEEP_COOLOFF_MS = 15_000;

export interface SweepItem {
  raw: RawSighting;
  /** When the coin was first parked. Looks are measured from here. */
  firstAt: number;
  /** Index into SWEEP_LOOKS_MS of the next look. */
  look: number;
}

export interface SweepDue {
  item: SweepItem;
  /** No look is left after this one. */
  last: boolean;
}

export class SweepSchedule {
  private readonly items = new Map<string, SweepItem>();
  /** Promoted, killed for good, or out of looks. Never watched again. */
  private readonly finished = new Set<string>();
  stats = { watched: 0, looks: 0, calls: 0, promoted: 0, expired: 0, evicted: 0 };

  constructor(private readonly looks: readonly number[] = SWEEP_LOOKS_MS, private readonly max = SWEEP_TRACK_MAX) {}

  get size(): number {
    return this.items.size;
  }

  has(mint: string): boolean {
    return this.items.has(mint);
  }

  /** Park a coin. A coin already parked keeps its clock and takes the newer numbers. */
  watch(raw: RawSighting, now: number): boolean {
    const mint = raw.mint;
    if (!mint || this.finished.has(mint)) return false;
    const prev = this.items.get(mint);
    if (prev) {
      prev.raw = { ...prev.raw, ...defined(raw), observedAt: prev.raw.observedAt };
      return false;
    }
    while (this.items.size >= this.max) {
      const oldest = this.items.keys().next().value;
      if (!oldest) break;
      this.items.delete(oldest);
      this.stats.evicted += 1;
    }
    this.items.set(mint, { raw: { ...raw }, firstAt: now, look: 0 });
    this.stats.watched += 1;
    return true;
  }

  /** The coin left the sweep for good. */
  finish(mint: string): void {
    this.items.delete(mint);
    this.finished.add(mint);
    if (this.finished.size > 8_000) {
      const first = this.finished.values().next().value;
      if (first) this.finished.delete(first);
    }
  }

  /**
   * Coins whose next look is due, youngest first: a launch is worth the most in its first minute.
   * Each returned coin has that look spent. Looks that were missed while the desk was busy are skipped,
   * not replayed, so a late tick asks once and not three times.
   */
  due(now: number, max: number): SweepDue[] {
    const ready: SweepItem[] = [];
    for (const item of this.items.values()) {
      const at = this.looks[item.look];
      if (at != null && now - item.firstAt >= at) ready.push(item);
    }
    ready.sort((a, b) => b.firstAt - a.firstAt);
    const out: SweepDue[] = [];
    for (const item of ready.slice(0, Math.max(0, max))) {
      let next = item.look + 1;
      while (next < this.looks.length && now - item.firstAt >= this.looks[next]!) next += 1;
      item.look = next;
      this.stats.looks += 1;
      out.push({ item, last: next >= this.looks.length });
    }
    return out;
  }

  /** The request failed. Give the look back so the coin is asked about again on the next tick. */
  giveBack(mint: string): void {
    const item = this.items.get(mint);
    if (item && item.look > 0) item.look -= 1;
  }

  view(): { watching: number; watched: number; looks: number; calls: number; promoted: number; expired: number; evicted: number } {
    return { watching: this.items.size, ...this.stats };
  }
}

function defined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  return out;
}
