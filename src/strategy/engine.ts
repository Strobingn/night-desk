import type { CandidateToken } from "../types.js";
import { DEFAULT_ACTIVE, STRATEGY, VARIANTS, timeLimitFor, variantById, type SignalKind, type StrategyConfig } from "./config.js";
import type { StrategyMeta } from "./exits.js";
import { MarkTracker, type TrackedMark } from "./mark-tracker.js";
import { scoreVariant, type VariantScore } from "./scorecard.js";
import { ShadowBook, type ShadowTrade } from "./shadow-book.js";
import { evaluateSignal, type Signal } from "./signals.js";
import type { ShadowStore } from "./store.js";

export interface EngineSettings {
  enabled: boolean;
  targetNetUsd: number;
  tradeUsd: number;
  maxOpen: number;
  /** The main paper book's variant per signal. */
  active: Record<SignalKind, string>;
}

export const SETTINGS_BAND = {
  targetNetUsd: { min: 0.25, max: 50 },
  tradeUsd: { min: 5, max: 500 },
  maxOpen: { min: 1, max: 6 }
} as const;

export function defaultSettings(cfg: StrategyConfig = STRATEGY): EngineSettings {
  return { enabled: false, targetNetUsd: cfg.targetNetUsd, tradeUsd: cfg.tradeUsd, maxOpen: cfg.maxOpen, active: { ...DEFAULT_ACTIVE } };
}

const clamp = (n: number, band: { min: number; max: number }) => Math.min(band.max, Math.max(band.min, n));

/** Apply a settings patch. Unknown keys are ignored. A bad value is an error and changes nothing. */
export function patchSettings(current: EngineSettings, patch: unknown): { ok: true; settings: EngineSettings } | { ok: false; error: string } {
  if (patch == null || typeof patch !== "object") return { ok: false, error: "Strategy settings must be an object." };
  const p = patch as Record<string, unknown>;
  const next: EngineSettings = { ...current, active: { ...current.active } };
  if ("enabled" in p) {
    if (typeof p.enabled !== "boolean") return { ok: false, error: "Trading engine on/off must be true or false." };
    next.enabled = p.enabled;
  }
  for (const key of ["targetNetUsd", "tradeUsd", "maxOpen"] as const) {
    if (!(key in p)) continue;
    const raw = p[key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || !(raw > 0)) return { ok: false, error: `${key} must be a number above 0.` };
    next[key] = key === "maxOpen" ? Math.round(clamp(raw, SETTINGS_BAND.maxOpen)) : Math.round(clamp(raw, SETTINGS_BAND[key]) * 100) / 100;
  }
  if ("active" in p) {
    if (p.active == null || typeof p.active !== "object") return { ok: false, error: "Active variants must be an object." };
    for (const signal of ["launch", "momentum"] as const) {
      const id = (p.active as Record<string, unknown>)[signal];
      if (id === undefined) continue;
      const variant = typeof id === "string" ? variantById(id) : undefined;
      if (!variant || variant.signal !== signal) return { ok: false, error: `Unknown ${signal} variant.` };
      next.active[signal] = variant.id;
    }
  }
  return { ok: true, settings: next };
}

export interface EngineQuote extends TrackedMark {
  liquidityUsd?: number | null;
}

export interface FiredSignal {
  signal: Signal;
  /** The watched coin with the price (and liquidity, when known) that fired the signal. */
  token: CandidateToken;
  score: number;
  /** Exit rules for the main paper book's active variant. */
  meta: StrategyMeta;
}

export interface EngineStats {
  watched: number;
  signals: Record<SignalKind, number>;
  shadowOpens: number;
  shadowCloses: number;
  errors: number;
  lastError: string | null;
}

export interface ScorecardView {
  enabled: boolean;
  targetNetUsd: number;
  tradeUsd: number;
  maxOpen: number;
  active: Record<SignalKind, string>;
  readyTrades: number;
  watching: number;
  variants: Array<VariantScore & { open: number; active: boolean }>;
  stats: EngineStats;
  /** Plain-words caveat shown with the numbers. */
  note: string;
}

export const SCORECARD_NOTE =
  "Paper results. Fills are modeled, and shadow books see a price about every 10 to 16 seconds, so a real 1% stop would trigger more often than shown. Treat these numbers as a best case.";

/**
 * Watches Filter-passing coins, fires Launch and Momentum signals, and runs the shadow books.
 * It never places an order: the desk decides what to do with a fired signal.
 */
export class StrategyEngine {
  readonly tracker: MarkTracker;
  readonly books = new Map<string, ShadowBook>();
  settings: EngineSettings;
  readonly stats: EngineStats = { watched: 0, signals: { launch: 0, momentum: 0 }, shadowOpens: 0, shadowCloses: 0, errors: 0, lastError: null };
  private readonly cfg: StrategyConfig;
  private readonly store: ShadowStore | null;
  private readonly coins = new Map<string, { token: CandidateToken; score: number }>();
  private readonly signalled = new Map<string, number>();
  /** Scores are recomputed only when a book's closed-trade count changes. The snapshot asks for them often. */
  private readonly scoreCache = new Map<string, { trades: number; score: VariantScore }>();
  private readonly onError: (where: string, err: unknown) => void;

  constructor(opts: { store?: ShadowStore | null; cfg?: StrategyConfig; settings?: EngineSettings; onError?: (where: string, err: unknown) => void } = {}) {
    this.cfg = opts.cfg ?? STRATEGY;
    this.store = opts.store ?? null;
    this.settings = opts.settings ?? defaultSettings(this.cfg);
    this.onError = opts.onError ?? (() => undefined);
    this.tracker = new MarkTracker(this.cfg);
    this.loadBooks();
  }

  private loadBooks(): void {
    let trades: ShadowTrade[] = [];
    try {
      trades = this.store?.all() ?? [];
    } catch (err) {
      this.fail("load", err);
    }
    this.books.clear();
    this.scoreCache.clear();
    for (const variant of VARIANTS) {
      this.books.set(
        variant.id,
        new ShadowBook(variant, {
          trades,
          cfg: this.cfg,
          sizing: () => ({ targetNetUsd: this.settings.targetNetUsd, tradeUsd: this.settings.tradeUsd, maxOpen: this.settings.maxOpen })
        })
      );
    }
  }

  private fail(where: string, err: unknown): void {
    this.stats.errors += 1;
    this.stats.lastError = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    try {
      this.onError(where, err);
    } catch {
      /* a broken error hook must not break the engine */
    }
  }

  /** Start watching a coin the Filter and the analyst passed. False when off, cooling down, or already watched. */
  watch(token: CandidateToken, score: number, now: number): boolean {
    if (!this.settings.enabled) return false;
    const last = this.signalled.get(token.mint);
    if (last != null && now - last < this.cfg.reentryMs) return false;
    if (this.tracker.has(token.mint)) {
      this.coins.set(token.mint, { token, score });
      return false;
    }
    this.tracker.watch(token.mint, now);
    this.coins.set(token.mint, { token, score });
    this.stats.watched += 1;
    this.prune();
    // The sighting itself is the first mark.
    this.tracker.note(token.mint, {
      at: now,
      priceUsd: token.priceUsd,
      vol5mUsd: token.volume5mUsd ?? null,
      vol1hUsd: token.volume1hUsd > 0 ? token.volume1hUsd : null,
      change1hPct: token.priceChange1hPct ?? null
    });
    return true;
  }

  private prune(): void {
    for (const mint of [...this.coins.keys()]) if (!this.tracker.has(mint)) this.coins.delete(mint);
  }

  /** Coins that need a quote: everything watched, plus every coin a shadow book holds. */
  pinned(): string[] {
    const out = new Set(this.tracker.mints());
    for (const book of this.books.values()) for (const mint of book.positions.keys()) out.add(mint);
    return [...out];
  }

  /** A price for a coin the engine cares about. Returns a signal for the desk when one fires. */
  onQuote(mint: string, quote: EngineQuote, now: number): FiredSignal | null {
    this.markShadows(mint, quote.priceUsd, now, quote.liquidityUsd ?? undefined);
    if (!this.settings.enabled || !this.tracker.has(mint)) return null;
    if (!this.tracker.note(mint, quote)) return null;
    const coin = this.coins.get(mint);
    if (!coin) return null;
    const ageMs = coin.token.ageSeconds * 1000 + Math.max(0, now - coin.token.discoveredAt);
    let signal: Signal | null = null;
    try {
      signal = evaluateSignal({ ageMs, marks: this.tracker.marks(mint), now }, this.cfg);
    } catch (err) {
      this.fail("signal", err);
    }
    if (!signal) return null;
    this.signalled.set(mint, now);
    this.tracker.drop(mint);
    this.coins.delete(mint);
    this.stats.signals[signal.signal] += 1;
    const liquidityUsd = quote.liquidityUsd != null && quote.liquidityUsd > 0 && Number.isFinite(quote.liquidityUsd) ? quote.liquidityUsd : coin.token.liquidityUsd;
    const token: CandidateToken = {
      ...coin.token,
      priceUsd: signal.priceUsd,
      liquidityUsd,
      ...(quote.vol1hUsd != null && quote.vol1hUsd > 0 ? { volume1hUsd: quote.vol1hUsd } : {}),
      ageSeconds: Math.round(ageMs / 1000),
      discoveredAt: now
    };
    for (const book of this.books.values()) {
      if (book.variant.signal !== signal.signal) continue;
      try {
        if (book.open({ mint, symbol: token.symbol, priceUsd: token.priceUsd, liquidityUsd }, now).ok) this.stats.shadowOpens += 1;
      } catch (err) {
        this.fail(`open ${book.variant.id}`, err);
      }
    }
    return { signal, token, score: coin.score, meta: this.metaFor(signal.signal) };
  }

  /** A faster mark for a coin a shadow book holds (the desk's own position ticks). Never fires a signal. */
  onTick(mint: string, priceUsd: number, now: number, liquidityUsd?: number): void {
    this.markShadows(mint, priceUsd, now, liquidityUsd);
  }

  private markShadows(mint: string, priceUsd: number, now: number, liquidityUsd?: number): void {
    for (const book of this.books.values()) {
      if (!book.positions.has(mint)) continue;
      try {
        this.closed(book.onMark(mint, priceUsd, now, liquidityUsd));
      } catch (err) {
        this.fail(`mark ${book.variant.id}`, err);
      }
    }
  }

  /** Time limits and watch expiry. Safe to call on a timer. */
  tick(now: number): void {
    for (const book of this.books.values()) {
      try {
        for (const trade of book.tick(now)) this.closed(trade);
      } catch (err) {
        this.fail(`tick ${book.variant.id}`, err);
      }
    }
    this.tracker.expire(now);
    this.prune();
    for (const [mint, at] of this.signalled) if (now - at >= this.cfg.reentryMs) this.signalled.delete(mint);
  }

  private closed(trade: ShadowTrade | null): void {
    if (!trade) return;
    this.stats.shadowCloses += 1;
    try {
      this.store?.save(trade);
    } catch (err) {
      this.fail("save", err);
    }
  }

  /** Exit rules for a main-book position opened on this signal. */
  metaFor(signal: SignalKind): StrategyMeta {
    const variant = variantById(this.settings.active[signal]) ?? variantById(DEFAULT_ACTIVE[signal])!;
    return {
      variant: variant.id,
      signal,
      stopPct: variant.stopPct,
      targetNetUsd: this.settings.targetNetUsd,
      timeLimitMs: timeLimitFor(signal, this.cfg)
    };
  }

  scorecard(): ScorecardView {
    const variants = VARIANTS.map((variant) => {
      const book = this.books.get(variant.id);
      const trades = book?.trades ?? [];
      let cached = this.scoreCache.get(variant.id);
      if (!cached || cached.trades !== trades.length) {
        cached = { trades: trades.length, score: scoreVariant(variant, trades, this.cfg) };
        this.scoreCache.set(variant.id, cached);
      }
      return {
        ...cached.score,
        open: book?.positions.size ?? 0,
        active: this.settings.active[variant.signal] === variant.id
      };
    });
    return {
      enabled: this.settings.enabled,
      targetNetUsd: this.settings.targetNetUsd,
      tradeUsd: this.settings.tradeUsd,
      maxOpen: this.settings.maxOpen,
      active: { ...this.settings.active },
      readyTrades: this.cfg.readyTrades,
      watching: this.tracker.mints().length,
      variants,
      stats: { ...this.stats, signals: { ...this.stats.signals } },
      note: SCORECARD_NOTE
    };
  }

  /** Wipe every shadow book and its saved trades. The watch list is kept. */
  reset(): void {
    try {
      this.store?.clear();
    } catch (err) {
      this.fail("clear", err);
    }
    this.loadBooks();
  }
}
