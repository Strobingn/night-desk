/**
 * Trading engine settings. Every threshold the engine uses lives here.
 *
 * These are starting values, not tuned ones. The shadow books exist to show which hold up.
 */
export type SignalKind = "launch" | "momentum";

export interface Variant {
  /** e.g. "launch-1": the Launch signal with a 1% stop. */
  id: string;
  signal: SignalKind;
  /** Fraction below the entry mark, e.g. 0.01. Never looser than the desk's hard stop. */
  stopPct: number;
  /**
   * Set on a trailing variant. At the target the trade is not sold: the stop follows the highest
   * mark seen from then on, this fraction below it.
   */
  trailPct?: number;
  /** A trailing variant that also sells when the run is fading (see STRATEGY.fade). */
  fade?: boolean;
}

const MIN = 60_000;

export const STRATEGY = {
  /** Take-profit: net of modeled fees and slippage. */
  targetNetUsd: 3,
  tradeUsd: 50,
  maxOpen: 2,
  /** New entries pause once the day's net result is this far down. */
  dailyMaxLossUsd: 10,
  /** Each shadow book starts here. */
  startingUsd: 100,
  /** A shadow book with less cash than this stops opening trades. */
  minTradeUsd: 5,
  /** Breakeven arms at this share of the target. */
  breakevenAt: 0.5,
  /** The same coin is not signalled again for this long. */
  reentryMs: 30 * MIN,
  launch: {
    /** Under this age the Launch rule applies, from it the Momentum rule. */
    maxAgeMs: 30 * MIN,
    minMarks: 3,
    minSpanMs: 20_000,
    minRisePct: 0.02,
    /** 5-minute volume against the hourly pace (1h volume / 12). */
    volPace: 1.5,
    timeLimitMs: 10 * MIN
  },
  momentum: {
    windowMs: 5 * MIN,
    minSpanMs: 90_000,
    minRisePct: 0.03,
    volPace: 1.5,
    timeLimitMs: 30 * MIN
  },
  watch: {
    /** Coins tracked at once. Each one is a pinned slot on the Tape quoter. */
    maxCoins: 12,
    maxWatchMs: 30 * MIN,
    maxMarks: 60,
    /** A mark older than this cannot fire a signal or a profit, breakeven or time exit. */
    markFreshMs: 30_000
  },
  stops: [0.01, 0.03, 0.06],
  trail: {
    /** Trailing variants use this stop until the target is reached. */
    stopPct: 0.03,
    /** Distance under the highest mark once the target is reached. */
    pcts: [0.04, 0.08, 0.12],
    /** Once trailing, a sell is forced if the net result falls back to this share of the target. */
    lockShare: 0.5,
    /** A trailing trade is closed at this multiple of the signal's time limit whatever it is doing. */
    maxTimeX: 4
  },
  fade: {
    /** No new high for this long while trailing. */
    stallMs: { launch: 90_000, momentum: 180_000 },
    /** 5-minute volume under this share of what it was at the buy. */
    volShare: 0.5,
    /** 5-minute sells at least this many times the buys, with at least minTxns trades. */
    sellRatio: 1.5,
    minTxns: 10,
    /** Pool depth down by this share since the buy. Checked before the target too. */
    liquidityDrop: 0.25,
    /** Volume, trade counts and depth older than this are not acted on. */
    freshMs: 60_000
  },
  live: {
    /** New live engine buys pause once the day's closed live result is this far down. */
    dailyMaxLossUsd: 5
  },
  /** Closed trades a variant needs, with a net profit, before the scorecard calls it ready. */
  readyTrades: 200
} as const;

export type StrategyConfig = typeof STRATEGY;

export const SIGNALS: SignalKind[] = ["launch", "momentum"];

const pctId = (fraction: number) => Math.round(fraction * 100);

/** The fixed-target books first (ids unchanged), then the trailing ones: `launch-3-t8`, `launch-3-t8f` (with fade exits). */
export const VARIANTS: Variant[] = [
  ...SIGNALS.flatMap((signal) => STRATEGY.stops.map((stopPct): Variant => ({ id: `${signal}-${pctId(stopPct)}`, signal, stopPct }))),
  ...SIGNALS.flatMap((signal) =>
    STRATEGY.trail.pcts.flatMap((trailPct): Variant[] => {
      const base = `${signal}-${pctId(STRATEGY.trail.stopPct)}-t${pctId(trailPct)}`;
      return [
        { id: base, signal, stopPct: STRATEGY.trail.stopPct, trailPct },
        { id: `${base}f`, signal, stopPct: STRATEGY.trail.stopPct, trailPct, fade: true }
      ];
    })
  )
];

export function variantById(id: string): Variant | undefined {
  return VARIANTS.find((v) => v.id === id);
}

export function timeLimitFor(signal: SignalKind, cfg: StrategyConfig = STRATEGY): number {
  return signal === "launch" ? cfg.launch.timeLimitMs : cfg.momentum.timeLimitMs;
}

/** The main paper book's variant per signal. Default: the 1% stop, as asked. */
export const DEFAULT_ACTIVE: Record<SignalKind, string> = { launch: "launch-1", momentum: "momentum-1" };
