import { ChainMarkReader, EXACT_KINDS, type ChainRead, type PoolKind } from "./chain-marks.js";
import { HeldQuoteBook, mergeResults, type DexQuote, type QuoteSource } from "./dex-prices.js";

/**
 * v13.2: held mints are priced on their own fast clock (default 1.5s, the "Position price
 * refresh" setting). The cycle runs at that pace, but each API only gets its own slice:
 * DexScreener every 3s (its CDN caches 30s anyway), Jupiter every 5s (its keyless
 * bucket is shared with the Scout). A pool read starts on its own gate and does not
 * hold those quotes: on the public RPC it can sit in the 9/min queue.
 */
export const HELD_MARK_POLL_MS = 1_500;
export const POLL_FLOOR_MS = 1_000;
/** A forced confirmation still waits this long between two calls to the same source. */
export const CONFIRM_MIN_MS = 1_500;
/** Skipping DexScreener's CDN cache for a stop confirmation: at most once per 10s. */
export const BUST_MIN_MS = 10_000;
/** Calibration: samples kept, minimum, max spread, max age. */
export const CAL_KEEP = 5;
export const CAL_MIN = 2;
export const CAL_SPREAD = 0.08;
export const CAL_MAX_AGE_MS = 5 * 60_000;
/** SOL/USD used for a bonding curve must be this fresh. */
export const SOL_USD_MAX_AGE_MS = 120_000;

type FetchLike = typeof fetch;

export interface LiveOrigin {
  feed: "chain";
  pairAddress: string;
  kind: PoolKind;
  at: number;
  /** Latest Dex and Jupiter prints, when this fresh, so the desk can reject a chain mark both disagree with. */
  dexUsd?: number;
  jupUsd?: number;
}

export interface PositionPricerOptions {
  heldMints: () => string[];
  tick: (mint: string, priceUsd: number, quote?: DexQuote) => void;
  /** v13.2: a calibrated on-chain mark. Display and stop-confirmation only. */
  live?: (mint: string, priceUsd: number, origin: LiveOrigin) => void;
  /** The pool a held mint is anchored to, so the chain read uses that exact pool. */
  pairFor?: (mint: string) => string | undefined;
  /** v13.6 last resort when no pool is known yet: the pump.fun bonding-curve PDA of a brand-new coin. */
  fallbackPair?: (mint: string) => string | undefined;
  /** Liquidity of the pool that supplied the price. Optional. */
  onQuote?: (mint: string, liquidityUsd: number) => void;
  onStale: (mint: string, silentMs: number) => void;
  onRecovered?: (mint: string) => void;
  onError?: (message: string) => void;
  onOk?: () => void;
  /** Cycle length in ms. A function so the setting applies without a restart. */
  pollMs?: number | (() => number);
  staleMs?: number;
  now?: () => number;
  fetchImpl?: FetchLike;
  chain?: ChainMarkReader;
  /** v13.8 websocket account stream on held pools (the poll stays as fallback). */
  stream?: { setKeys(keys: Iterable<string>): void; connected(): boolean };
}

/** v13.8 a websocket copy this fresh replaces the poll's RPC read for that pool. */
export const STREAM_FRESH_MS = 3_000;
/** v13.8 at most one streamed mark per mint this often (pump coins can change many times a second). */
export const STREAM_EMIT_MS = 150;

interface CalSample {
  ratio: number;
  at: number;
  feed: QuoteSource;
}

export interface PricerStats {
  pollMs: number;
  lastCycleAt: number | null;
  sources: Record<string, { lastOkAt: number | null; coolUntil: number; lastError: string | null; count429: number }>;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Re-prices open positions. A mint that is not listed stays unpriced.
 * Silence is reported once. A later print clears it. No price is invented.
 */
export class PositionPricer {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private readonly lastPriced = new Map<string, number>();
  private readonly warned = new Set<string>();
  readonly quotes = new HeldQuoteBook();
  private running = false;
  private readonly now: () => number;
  private readonly confirmWanted = new Set<string>();
  private readonly lastPair = new Map<string, string>();
  private readonly cal = new Map<string, CalSample[]>();
  private lastBustAt = Number.NEGATIVE_INFINITY;
  private lastCycleAt: number | null = null;
  private subKey = new Map<string, string>();
  private heldNow = new Set<string>();
  private readonly lastStreamEmit = new Map<string, number>();
  /** Latest independent quotes, so a stream mark can be checked without waiting for the next poll. */
  private readonly indep = new Map<string, { dex?: { price: number; at: number }; jup?: { price: number; at: number } }>();
  /** A public-RPC pool read can sit in the rate-limit queue. It must not hold Dex/Jupiter marks. */
  private chainBusy = false;

  constructor(private readonly opts: PositionPricerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  pollMs(): number {
    const raw = typeof this.opts.pollMs === "function" ? this.opts.pollMs() : this.opts.pollMs ?? HELD_MARK_POLL_MS;
    return Number.isFinite(raw) ? Math.max(POLL_FLOOR_MS, raw) : HELD_MARK_POLL_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        if (!this.running) {
          this.running = true;
          void this.cycle(false)
            .catch((err) => this.opts.onError?.(err instanceof Error ? err.message : String(err)))
            .finally(() => {
              this.running = false;
            });
        }
        loop();
      }, this.pollMs());
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A tick from any other source counts as a price, so only truly silent mints go stale. */
  noteTick(mint: string, at: number = this.now()): void {
    if (this.lastPriced.has(mint)) this.lastPriced.set(mint, at);
  }

  /** v13.2: a live mark crossed the stop or ran away from the risk mark. Ask the entry feed now. */
  confirm(mint: string): void {
    this.confirmWanted.add(mint);
  }

  stats(): PricerStats {
    const sources: PricerStats["sources"] = {};
    for (const [id, gate] of Object.entries(this.quotes.gates)) {
      sources[id] = { lastOkAt: gate.lastOkAt, coolUntil: gate.coolUntil, lastError: gate.lastError, count429: gate.count429 };
    }
    if (this.opts.chain) {
      const g = this.opts.chain.gate;
      sources.chain = { lastOkAt: g.lastOkAt, coolUntil: g.coolUntil, lastError: g.lastError, count429: g.count429 };
    }
    return { pollMs: this.pollMs(), lastCycleAt: this.lastCycleAt, sources };
  }

  /** Every ready source right now (tests, manual reprice). Cool-offs still apply. */
  async poll(): Promise<void> {
    await this.cycle(true);
  }

  async cycle(force: boolean): Promise<void> {
    const held = this.opts.heldMints();
    const now = this.now();
    this.lastCycleAt = now;
    for (const mint of [...this.lastPriced.keys()]) {
      if (!held.includes(mint)) {
        this.lastPriced.delete(mint);
        this.warned.delete(mint);
        this.cal.delete(mint);
        this.indep.delete(mint);
        this.lastPair.delete(mint);
        this.confirmWanted.delete(mint);
      }
    }
    for (const mint of held) if (!this.lastPriced.has(mint)) this.lastPriced.set(mint, now);
    if (held.length === 0) return;

    const confirming = [...this.confirmWanted].filter((mint) => held.includes(mint));
    this.confirmWanted.clear();
    const sources: QuoteSource[] = [];
    for (const source of ["dexscreener", "jupiter"] as const) {
      const gate = this.quotes.gates[source];
      const urgent = confirming.length > 0 && now - gate.lastRunAt >= CONFIRM_MIN_MS;
      if (gate.due(now, force || urgent)) sources.push(source);
    }
    let bust: number | undefined;
    if (confirming.length && sources.includes("dexscreener") && !force && now - this.lastBustAt >= BUST_MIN_MS) {
      bust = now;
      this.lastBustAt = now;
    }

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const chain = this.opts.chain;
    const wanted = chain
      ? held.map((mint) => ({ mint, pair: this.opts.pairFor?.(mint) ?? this.lastPair.get(mint) ?? this.opts.fallbackPair?.(mint) ?? "" })).filter((w) => w.pair)
      : [];
    this.heldNow = new Set(held);
    const chainDue = chain && wanted.length > 0 && chain.gate.due(now, force) && !this.chainBusy;
    if (chainDue) chain!.gate.started(now);
    const skipFresh = this.opts.stream?.connected() ? STREAM_FRESH_MS : 0;

    // Quotes and the pool read start together. The read is applied when it returns.
    // A public Solana read can wait in the 9/min queue while Dex itself is healthy
    // (measured 8 Nov 2026: Dex 429 count 0, both held coins still moved only when the cycle ended).
    const quoteTask = sources.length
      ? this.quotes.fetchSources(held, sources, fetchImpl, now, bust ? { bust } : {})
      : Promise.resolve([]);
    const chainTask = chainDue
      ? chain!.read(wanted, now, skipFresh, () => this.now()).then(
          (reads) => {
            chain!.gate.ok(this.now());
            return { reads } as { reads?: Map<string, ChainRead>; error?: string };
          },
          (err: unknown) => {
            const message = `chain ${err instanceof Error ? err.message : String(err)}`;
            chain!.gate.fail(message, this.now());
            return { error: message } as { reads?: Map<string, ChainRead>; error?: string };
          }
        )
      : null;
    if (chainTask) {
      this.chainBusy = true;
      void chainTask.finally(() => {
        this.chainBusy = false;
      });
    }

    let results: Awaited<ReturnType<HeldQuoteBook["fetchSources"]>> = [];
    try {
      results = await quoteTask;
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
    }

    let prices = new Map<string, DexQuote[]>();
    if (results.length) {
      try {
        prices = mergeResults(results);
        this.opts.onOk?.();
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err.message : String(err));
      }
    }

    const staleMs = this.opts.staleMs ?? 5 * 60_000;
    for (const mint of held) {
      const quotes = prices.get(mint) ?? [];
      for (const quote of quotes) if (quote.feed === "dexscreener" && quote.pairAddress) this.lastPair.set(mint, quote.pairAddress);
      this.rememberQuotes(mint, quotes, this.now());
      if (quotes.length) {
        this.lastPriced.set(mint, this.now());
        if (this.warned.delete(mint)) this.opts.onRecovered?.(mint);
        for (const quote of quotes) this.opts.tick(mint, quote.priceUsd, quote);
      } else if (!this.warned.has(mint)) {
        const silent = this.now() - (this.lastPriced.get(mint) ?? now);
        if (silent >= staleMs) {
          this.warned.add(mint);
          this.opts.onStale(mint, silent);
        }
      }
    }

    if (chain && this.opts.stream) {
      this.subKey = chain.subscriptions(wanted.map((w) => w.pair));
      this.opts.stream.setKeys(this.subKey.keys());
    }
    if (!chainTask) return;
    // A forced poll (tests, manual reprice) still waits so calibration sees this cycle's read.
    // The 1.5s loop does not: the next Dex pass starts while this read is still queued.
    const applyChain = async () => {
      const chainResult = await chainTask;
      const reads = chainResult?.reads;
      if (!reads || !this.opts.live) return;
      for (const [mint, read] of reads) {
        // read.at is the RPC decode time, or the websocket notification time for a cache hit.
        // Do not replace it with this.now(): that would present a stale cached copy as fresh.
        this.sample(mint, read, prices.get(mint) ?? [], read.at);
        const factor = this.factor(mint, read.kind, this.now());
        if (factor == null) continue;
        const usd = read.native * factor;
        if (usd > 0 && Number.isFinite(usd)) this.opts.live(mint, usd, { feed: "chain", pairAddress: read.pair, kind: read.kind, at: read.at, ...this.quoteOrigin(mint, this.now()) });
      }
    };
    if (force) await applyChain();
    else void applyChain().catch((err) => this.opts.onError?.(err instanceof Error ? err.message : String(err)));
  }

  /** v13.8 a websocket account update: decode that pool now and push a live mark. */
  onStreamAccount(key: string, data: Uint8Array, at: number): void {
    const chain = this.opts.chain;
    if (!chain) return;
    chain.noteAccount(key, data, at);
    const pair = this.subKey.get(key);
    if (!pair || !this.opts.live) return;
    const cached = chain.decodeCached(pair);
    if (!cached) return;
    const { read } = cached;
    if (!this.heldNow.has(read.mint)) return;
    const now = this.now();
    if (now - (this.lastStreamEmit.get(read.mint) ?? Number.NEGATIVE_INFINITY) < STREAM_EMIT_MS) return;
    const factor = this.factor(read.mint, read.kind, now);
    if (factor == null) return;
    const usd = read.native * factor;
    if (!(usd > 0) || !Number.isFinite(usd)) return;
    this.lastStreamEmit.set(read.mint, now);
    this.opts.live(read.mint, usd, { feed: "chain", pairAddress: read.pair, kind: read.kind, at: read.at, ...this.quoteOrigin(read.mint, now) });
  }

  private rememberQuotes(mint: string, quotes: DexQuote[], now: number): void {
    const row = this.indep.get(mint) ?? {};
    for (const quote of quotes) {
      if (!(quote.priceUsd > 0)) continue;
      if (quote.feed === "dexscreener") row.dex = { price: quote.priceUsd, at: now };
      else if (quote.feed === "jupiter") row.jup = { price: quote.priceUsd, at: now };
    }
    this.indep.set(mint, row);
  }

  private quoteOrigin(mint: string, now: number): { dexUsd?: number; jupUsd?: number } {
    const row = this.indep.get(mint);
    const fresh = (q: { price: number; at: number } | undefined) => (q && now - q.at <= 60_000 && q.price > 0 ? q.price : undefined);
    return { dexUsd: fresh(row?.dex), jupUsd: fresh(row?.jup) };
  }

  /** USD per SOL-native unit for this pool, learned from the same cycle's quotes. */
  private sample(mint: string, read: ChainRead, quotes: DexQuote[], now: number): void {
    const list = (this.cal.get(mint) ?? []).filter((s) => now - s.at <= CAL_MAX_AGE_MS);
    const jup = quotes.find((q) => q.feed === "jupiter");
    const dex = quotes.find((q) => q.feed === "dexscreener" && q.pairAddress === read.pair);
    const recentJup = list.some((s) => s.feed === "jupiter" && now - s.at <= 30_000);
    // A Jupiter print dozens of times the pool quote is the Pepetide failure mode. Do not
    // calibrate the chain mark from it; the pool quote is the one that matches reserves.
    const jupSane = jup && (!dex || !(dex.priceUsd > 0) || jup.priceUsd <= dex.priceUsd * 25);
    const pick = (jupSane ? jup : undefined) ?? (!recentJup ? dex : undefined);
    if (pick && pick.priceUsd > 0 && read.native > 0) {
      const ratio = pick.priceUsd / read.native;
      if (Number.isFinite(ratio) && ratio > 0) list.push({ ratio, at: now, feed: pick.feed === "jupiter" ? "jupiter" : "dexscreener" });
    }
    this.cal.set(mint, list.slice(-CAL_KEEP));
  }

  /**
   * Null means "do not show a chain mark": too few or disagreeing samples.
   * A bonding curve and a PumpSwap vault ratio are exact in SOL, so a fresh SOL/USD is
   * enough once one Dex or Jupiter sample agrees within 15%. A quote that is 25× off
   * never becomes the chain mark.
   */
  factor(mint: string, kind: PoolKind, now: number): number | null {
    const list = (this.cal.get(mint) ?? []).filter((s) => now - s.at <= CAL_MAX_AGE_MS);
    const sol = this.quotes.solUsd;
    const exact = EXACT_KINDS.has(kind);
    if ((kind === "curve" || exact) && sol && now - sol.at <= SOL_USD_MAX_AGE_MS && sol.value > 0) {
      const last = list[list.length - 1];
      // v13.8 sqrt / bin / vault-share pools are exact in SOL too, but need one agreeing feed sample first.
      if (exact && !last) return null;
      if (last && Math.abs(last.ratio / sol.value - 1) > 0.15) return null;
      return sol.value;
    }
    if (list.length < CAL_MIN) return null;
    const ratios = list.map((s) => s.ratio);
    const lo = Math.min(...ratios);
    const hi = Math.max(...ratios);
    if (!(lo > 0) || hi / lo - 1 > CAL_SPREAD) return null;
    return median(ratios);
  }
}
