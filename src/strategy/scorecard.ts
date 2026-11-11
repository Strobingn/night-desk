import { STRATEGY, type SignalKind, type StrategyConfig, type Variant } from "./config.js";
import type { ShadowTrade } from "./shadow-book.js";

export interface VariantScore {
  variant: string;
  signal: SignalKind;
  stopPct: number;
  trades: number;
  wins: number;
  /** 0–1. */
  winRate: number;
  avgWinUsd: number;
  /** Negative or 0. */
  avgLossUsd: number;
  /** After modeled fees and slippage. */
  netUsd: number;
  avgNetUsd: number;
  /** Largest fall from a running high in cumulative net, as a positive number. */
  maxDrawdownUsd: number;
  /** Starting balance plus closed net. Open positions are not counted. */
  equityUsd: number;
  /** Enough trades and a net profit. Information only: it arms nothing. */
  ready: boolean;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function scoreVariant(variant: Variant, trades: ShadowTrade[], cfg: StrategyConfig = STRATEGY): VariantScore {
  const own = trades.filter((t) => t.variant === variant.id).sort((a, b) => a.closedAt - b.closedAt);
  const wins = own.filter((t) => t.pnlUsd > 0);
  const losses = own.filter((t) => t.pnlUsd < 0);
  let run = 0;
  let high = 0;
  let drawdown = 0;
  for (const t of own) {
    run += t.pnlUsd;
    if (run > high) high = run;
    if (high - run > drawdown) drawdown = high - run;
  }
  return {
    variant: variant.id,
    signal: variant.signal,
    stopPct: variant.stopPct,
    trades: own.length,
    wins: wins.length,
    winRate: own.length ? wins.length / own.length : 0,
    avgWinUsd: mean(wins.map((t) => t.pnlUsd)),
    avgLossUsd: mean(losses.map((t) => t.pnlUsd)),
    netUsd: run,
    avgNetUsd: own.length ? run / own.length : 0,
    maxDrawdownUsd: drawdown,
    equityUsd: cfg.startingUsd + run,
    ready: own.length >= cfg.readyTrades && run > 0
  };
}
