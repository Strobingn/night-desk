import { fetchDexQuotes } from "./dex-prices.js";

type FetchLike = typeof fetch;

export interface PositionPricerOptions {
  heldMints: () => string[];
  tick: (mint: string, priceUsd: number) => void;
  /** Liquidity of the pool that supplied the price. Optional. */
  onQuote?: (mint: string, liquidityUsd: number) => void;
  onStale: (mint: string, silentMs: number) => void;
  onRecovered?: (mint: string) => void;
  onError?: (message: string) => void;
  onOk?: () => void;
  pollMs?: number;
  staleMs?: number;
  now?: () => number;
  fetchImpl?: FetchLike;
}

/**
 * Re-prices open positions from DexScreener. A mint that is not listed stays unpriced.
 * Silence is reported once. A later print clears it. No price is invented.
 */
export class PositionPricer {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastPriced = new Map<string, number>();
  private readonly warned = new Set<string>();
  private running = false;
  private readonly now: () => number;

  constructor(private readonly opts: PositionPricerOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.poll()
        .catch((err) => this.opts.onError?.(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          this.running = false;
        });
    }, this.opts.pollMs ?? 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A tick from any other source counts as a price, so only truly silent mints go stale. */
  noteTick(mint: string, at: number = this.now()): void {
    if (this.lastPriced.has(mint)) this.lastPriced.set(mint, at);
  }

  async poll(): Promise<void> {
    const held = this.opts.heldMints();
    const now = this.now();
    for (const mint of [...this.lastPriced.keys()]) {
      if (!held.includes(mint)) {
        this.lastPriced.delete(mint);
        this.warned.delete(mint);
      }
    }
    for (const mint of held) if (!this.lastPriced.has(mint)) this.lastPriced.set(mint, now);
    if (held.length === 0) return;

    let prices = new Map<string, { priceUsd: number; liquidityUsd: number }>();
    try {
      prices = await fetchDexQuotes(held, this.opts.fetchImpl);
      this.opts.onOk?.();
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
    }

    const staleMs = this.opts.staleMs ?? 5 * 60_000;
    for (const mint of held) {
      const quote = prices.get(mint);
      if (quote) {
        this.lastPriced.set(mint, this.now());
        if (this.warned.delete(mint)) this.opts.onRecovered?.(mint);
        this.opts.onQuote?.(mint, quote.liquidityUsd);
        this.opts.tick(mint, quote.priceUsd);
      } else if (!this.warned.has(mint)) {
        const silent = this.now() - (this.lastPriced.get(mint) ?? now);
        if (silent >= staleMs) {
          this.warned.add(mint);
          this.opts.onStale(mint, silent);
        }
      }
    }
  }
}
