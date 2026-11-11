/** Rolling timing samples per pipeline step. Measurement only: nothing reads these to make a decision. */
export interface LatencySummary {
  count: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
}

const KEEP = 200;
const MAX_SANE_MS = 60 * 60_000;

export class LatencyStats {
  private readonly samples = new Map<string, number[]>();
  private readonly counts = new Map<string, number>();

  record(step: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > MAX_SANE_MS) return;
    const row = this.samples.get(step) ?? [];
    row.push(ms);
    if (row.length > KEEP) row.shift();
    this.samples.set(step, row);
    this.counts.set(step, (this.counts.get(step) ?? 0) + 1);
  }

  view(): Record<string, LatencySummary> {
    const out: Record<string, LatencySummary> = {};
    for (const [step, row] of this.samples) {
      const sorted = [...row].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      out[step] = { count: this.counts.get(step) ?? row.length, p50Ms: Math.round(at(0.5)), p90Ms: Math.round(at(0.9)), maxMs: Math.round(sorted[sorted.length - 1] ?? 0) };
    }
    return out;
  }
}

/** A Map that forgets its oldest entry past a cap. */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly cap: number) {
    super();
  }
  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.cap) {
      const oldest = this.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    return this;
  }
}
