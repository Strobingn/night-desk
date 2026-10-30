/**
 * v12.1: enrichment used to call DexScreener /latest/dex/tokens/{mint} once per sighting.
 * This batches those lookups into /tokens/v1/solana/{up to 30 mints}, the same 300/min
 * bucket, so a DexScreener list poll of 30 coins costs one request instead of 30.
 */
export const DEX_BATCH_MAX = 30;
export const DEX_BATCH_WINDOW_MS = 600;

interface Pending {
  resolve: (value: { pairs: unknown[] } | null) => void;
}

export class DexTokenBatcher {
  private pending = new Map<string, Pending[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  calls = 0;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly opts: { windowMs?: number; max?: number; timeoutMs?: number } = {}
  ) {}

  /** Resolves to a /latest/dex/tokens-shaped body ({ pairs }) for this mint, or null when DexScreener did not answer. */
  get(mint: string): Promise<{ pairs: unknown[] } | null> {
    return new Promise((resolve) => {
      const list = this.pending.get(mint);
      if (list) list.push({ resolve });
      else this.pending.set(mint, [{ resolve }]);
      const max = this.opts.max ?? DEX_BATCH_MAX;
      if (this.pending.size >= max) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.opts.windowMs ?? DEX_BATCH_WINDOW_MS);
      }
    });
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const max = this.opts.max ?? DEX_BATCH_MAX;
    const batch = [...this.pending.entries()].slice(0, max);
    for (const [mint] of batch) this.pending.delete(mint);
    if (this.pending.size) this.timer = setTimeout(() => this.flush(), 0);
    if (batch.length) void this.run(batch);
  }

  private async run(batch: Array<[string, Pending[]]>): Promise<void> {
    this.calls += 1;
    const mints = batch.map(([mint]) => mint);
    let rows: unknown[] | null = null;
    try {
      const res = await this.fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000)
      });
      if (res.ok) {
        const body = (await res.json()) as unknown;
        rows = Array.isArray(body) ? body : [];
      }
    } catch {
      rows = null;
    }
    for (const [mint, waiters] of batch) {
      const pairs = rows
        ? rows.filter((row) => {
            const base = (row as { baseToken?: { address?: string } } | null)?.baseToken;
            return base?.address === mint;
          })
        : null;
      for (const w of waiters) w.resolve(pairs ? { pairs } : null);
    }
  }
}
