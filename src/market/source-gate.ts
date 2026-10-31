/**
 * v13.2 per-source pacing for the fast held-position loop.
 * A source runs at most once per `minIntervalMs`. A 429 cools it 5s, doubling to 60s.
 * A 5xx, timeout, or network error cools it 2s, doubling to 30s. One success resets both.
 * The Scout shares the same APIs, so the fast loop never spends more than its own slice.
 */
export interface GateSpec {
  minIntervalMs: number;
}

export const RATE_LIMIT_BACKOFF = { baseMs: 5_000, capMs: 60_000 } as const;
export const ERROR_BACKOFF = { baseMs: 2_000, capMs: 30_000 } as const;

export function isRateLimit(message: string): boolean {
  return /\b429\b|rate.?limit|too many requests|-32429|\b1015\b/i.test(message);
}

export class SourceGate {
  lastRunAt = Number.NEGATIVE_INFINITY;
  coolUntil = 0;
  lastOkAt: number | null = null;
  lastError: string | null = null;
  count429 = 0;
  private rateBackoff: number = RATE_LIMIT_BACKOFF.baseMs;
  private errorBackoff: number = ERROR_BACKOFF.baseMs;

  constructor(public minIntervalMs: number) {}

  cooling(now: number): boolean {
    return now < this.coolUntil;
  }

  /** Due on its own clock. `force` skips the interval but never a cool-off. */
  due(now: number, force = false): boolean {
    if (this.cooling(now)) return false;
    return force || now - this.lastRunAt >= this.minIntervalMs;
  }

  started(now: number): void {
    this.lastRunAt = now;
  }

  ok(now: number): void {
    this.lastOkAt = now;
    this.lastError = null;
    this.rateBackoff = RATE_LIMIT_BACKOFF.baseMs;
    this.errorBackoff = ERROR_BACKOFF.baseMs;
  }

  /** Returns the cool-off applied, in ms. */
  fail(message: string, now: number): number {
    this.lastError = message;
    if (isRateLimit(message)) {
      this.count429 += 1;
      const wait = this.rateBackoff;
      this.coolUntil = now + wait;
      this.rateBackoff = Math.min(RATE_LIMIT_BACKOFF.capMs, wait * 2);
      return wait;
    }
    const wait = this.errorBackoff;
    this.coolUntil = now + wait;
    this.errorBackoff = Math.min(ERROR_BACKOFF.capMs, wait * 2);
    return wait;
  }
}
