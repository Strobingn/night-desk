/**
 * v13.3 one-tap idempotency. A one-tap Buy or Sell carries an `idemKey`. The first request
 * with a key runs; a repeat of the same key within IDEM_TTL_MS (double tap, retry after a
 * dropped response) gets the first request's result back instead of placing a second order.
 */
export const IDEM_TTL_MS = 60_000;
const MAX_KEYS = 500;

export interface IdemResult {
  status: number;
  body: Record<string, unknown>;
}

interface Entry {
  at: number;
  done: Promise<IdemResult>;
}

export class IdempotencyCache {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(scope: string, raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const k = raw.trim();
    if (!k || k.length > 120) return null;
    return `${scope}:${k}`;
  }

  private prune(): void {
    const cutoff = this.now() - IDEM_TTL_MS;
    for (const [k, e] of this.map) {
      if (e.at < cutoff || this.map.size > MAX_KEYS) this.map.delete(k);
      else break;
    }
  }

  /** The first request's result for this key, or null when the key is new (or absent). */
  lookup(scope: string, raw: unknown): Promise<IdemResult> | null {
    const k = this.key(scope, raw);
    if (!k) return null;
    this.prune();
    return this.map.get(k)?.done ?? null;
  }

  remember<T extends object>(scope: string, raw: unknown, job: Promise<T>, statusOf: (r: T) => number): void {
    const k = this.key(scope, raw);
    if (!k) return;
    const done = job.then(
      (r) => ({ status: statusOf(r), body: r as unknown as Record<string, unknown> }),
      (err) => ({ status: 500, body: { ok: false, error: err instanceof Error ? err.message : String(err) } })
    );
    this.map.set(k, { at: this.now(), done });
  }
}
