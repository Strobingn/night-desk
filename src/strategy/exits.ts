import { pctText } from "../rules.js";
import { STRATEGY, type SignalKind, type StrategyConfig } from "./config.js";

/** Saved on a position the engine opened. */
export interface StrategyMeta {
  variant: string;
  signal: SignalKind;
  stopPct: number;
  targetNetUsd: number;
  timeLimitMs: number;
  breakevenArmed?: boolean;
  /** Trailing variant: distance under the highest mark once the target is reached. */
  trailPct?: number;
  /** Trailing variant that also sells on a fading run. */
  fade?: boolean;
  /** True once the target was reached and the trade is trailing. */
  trailArmed?: boolean;
  /** Highest mark since trailing began, and when it was set. */
  peakMark?: number;
  peakAt?: number;
  /** 5-minute volume and pool depth at the buy, for the fade exits. */
  entryVol5mUsd?: number;
  entryLiquidityUsd?: number;
}

export type StrategyExitCode =
  | "TAKE_PROFIT"
  | "STRATEGY_STOP"
  | "BREAKEVEN_STOP"
  | "TIME_LIMIT"
  | "ENGINE_TRAIL"
  | "PROFIT_LOCK"
  | "FADE_EXIT"
  | "LIQUIDITY_DROP";

/** What the market is doing around a held coin. Every field is optional: a missing one fires nothing. */
export interface MarketFlow {
  at: number;
  vol5mUsd?: number | null;
  buys5m?: number | null;
  sells5m?: number | null;
  liquidityUsd?: number | null;
}

export interface StrategyExitInput {
  entryPrice: number;
  /** The mark the buy was sized against. The stop is measured from it; the fill when it is missing. */
  entryMark?: number;
  openedAt: number;
  mark: number;
  /** False when the mark is too old to act on for anything but the stop. */
  markFresh: boolean;
  /** What a full sell would net right now, after modeled costs. Null when it cannot be measured. */
  netPnlUsd: number | null;
  now: number;
  meta: StrategyMeta;
  flow?: MarketFlow | null;
  /**
   * v13.54 sell when the pool is draining, whatever the variant. The desk sets this for real money:
   * a coin that has lost a quarter of its depth since the buy is sold while there is still a pool to
   * sell into. Without it only the fade variants act on depth.
   */
  depthGuard?: boolean;
}

export interface StrategyExit {
  action: "hold" | "exit";
  code?: StrategyExitCode;
  message: string;
  /** True the first time the trade reaches half its target. The caller saves it on the position. */
  armBreakeven: boolean;
  /** Trailing state to save on the position (armed, new peak). */
  patch?: Partial<StrategyMeta>;
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const good = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0;
/** A reading that may be zero: no volume, or an emptied pool, is an observation and not a gap in the data. */
const seen = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n >= 0;

/**
 * The engine stop line. Measured from the mark the buy was priced at, like the desk's hard stop.
 * The fill sits above that mark by entry slippage, so a stop measured from the fill is closer than
 * its percent says, and in a thin pool it is already hit on the first unchanged mark.
 */
export function strategyStopPrice(entryPrice: number, entryMark: number | undefined, stopPct: number): number {
  const basis = entryMark != null && entryMark > 0 && Number.isFinite(entryMark) ? entryMark : entryPrice;
  return basis * (1 - stopPct);
}

/** The line that sells a trailing trade right now: the trail under the peak once armed, else the stop. */
export function strategyLinePrice(entryPrice: number, entryMark: number | undefined, meta: StrategyMeta): number {
  const stop = strategyStopPrice(entryPrice, entryMark, meta.stopPct);
  if (meta.trailPct && meta.trailArmed && good(meta.peakMark)) return Math.max(stop, meta.peakMark * (1 - meta.trailPct));
  return stop;
}

/** A reason the run is fading, or null. Uses only fresh flow data. */
export function fadeReason(meta: StrategyMeta, flow: MarketFlow | null | undefined, now: number, cfg: StrategyConfig = STRATEGY): string | null {
  if (!meta.fade || !flow || now - flow.at > cfg.fade.freshMs) return null;
  if (seen(flow.vol5mUsd) && good(meta.entryVol5mUsd) && flow.vol5mUsd < meta.entryVol5mUsd * cfg.fade.volShare) {
    return `5-minute volume is ${usd(flow.vol5mUsd)}, under ${Math.round(cfg.fade.volShare * 100)}% of the ${usd(meta.entryVol5mUsd)} at the buy.`;
  }
  const buys = flow.buys5m ?? null;
  const sells = flow.sells5m ?? null;
  if (buys != null && sells != null && buys + sells >= cfg.fade.minTxns && sells >= buys * cfg.fade.sellRatio) {
    return `sellers lead: ${sells} sells to ${buys} buys in 5 minutes.`;
  }
  return null;
}

/**
 * The engine's own exits, checked after the desk's hard stop. Only the stop may act on a mark
 * that is not fresh.
 *
 * Fixed-target variant: stop, take-profit, breakeven, time limit.
 * Trailing variant: stop, pool draining (fade variants), then at the target it starts trailing
 * instead of selling: trail under the peak, profit lock, fade, and a long time cap.
 */
export function assessStrategyExit(input: StrategyExitInput, cfg: StrategyConfig = STRATEGY): StrategyExit {
  const { entryPrice, openedAt, mark, markFresh, netPnlUsd, now, meta } = input;
  const hold = (armBreakeven = false, patch?: Partial<StrategyMeta>): StrategyExit => ({ action: "hold", message: "Holding.", armBreakeven, ...(patch ? { patch } : {}) });
  const exit = (code: StrategyExitCode, message: string): StrategyExit => ({ action: "exit", code, message, armBreakeven: false });
  if (!(mark > 0) || !Number.isFinite(mark) || !(entryPrice > 0) || !Number.isFinite(entryPrice)) return hold();

  const stopPrice = strategyStopPrice(entryPrice, input.entryMark, meta.stopPct);
  if (mark <= stopPrice * (1 + 1e-9)) {
    const basis = stopPrice / (1 - meta.stopPct);
    return exit("STRATEGY_STOP", `${pctText(meta.stopPct)} stop: mark is ${((mark / basis - 1) * 100).toFixed(2)}% from the entry mark.`);
  }

  const net = markFresh && netPnlUsd != null && Number.isFinite(netPnlUsd) ? netPnlUsd : null;
  const trailing = meta.trailPct != null && meta.trailPct > 0;
  const flow = input.flow && now - input.flow.at <= cfg.fade.freshMs ? input.flow : null;

  if ((input.depthGuard || (trailing && meta.fade)) && markFresh && flow && seen(flow.liquidityUsd) && good(meta.entryLiquidityUsd)) {
    if (flow.liquidityUsd <= meta.entryLiquidityUsd * (1 - cfg.fade.liquidityDrop)) {
      return exit("LIQUIDITY_DROP", `Pool depth fell to ${usd(flow.liquidityUsd)} from ${usd(meta.entryLiquidityUsd)} at the buy.`);
    }
  }

  if (trailing && meta.trailArmed) {
    const oldPeak = good(meta.peakMark) ? meta.peakMark : mark;
    const rose = markFresh && mark > oldPeak;
    const peak = rose ? mark : oldPeak;
    const peakAt = rose || meta.peakAt == null ? now : meta.peakAt;
    const patch = rose || !good(meta.peakMark) || meta.peakAt == null ? { peakMark: peak, peakAt } : undefined;
    if (!markFresh) return hold(false, patch);
    if (mark <= peak * (1 - meta.trailPct!) * (1 + 1e-9)) {
      return exit("ENGINE_TRAIL", `Trail: mark is ${((1 - mark / peak) * 100).toFixed(2)}% under its high, limit ${pctText(meta.trailPct!)}${net != null ? ` (${usd(net)} net)` : ""}.`);
    }
    if (net != null && net <= meta.targetNetUsd * cfg.trail.lockShare + 1e-9) {
      return exit("PROFIT_LOCK", `Profit lock: the trade reached its target and is back to ${usd(net)} net.`);
    }
    if (meta.fade) {
      const stallMs = cfg.fade.stallMs[meta.signal];
      if (now - peakAt >= stallMs) return exit("FADE_EXIT", `Fade: no new high for ${Math.round((now - peakAt) / 1000)}s${net != null ? ` (${usd(net)} net)` : ""}.`);
      const why = fadeReason(meta, flow, now, cfg);
      if (why) return exit("FADE_EXIT", `Fade: ${why}`);
    }
    if (now - openedAt >= meta.timeLimitMs * cfg.trail.maxTimeX) {
      return exit("TIME_LIMIT", `Time limit: open ${Math.round((now - openedAt) / 60_000)} min${net != null ? ` (${usd(net)} net)` : ""}.`);
    }
    return hold(false, patch);
  }

  if (net != null && net + 1e-9 >= meta.targetNetUsd) {
    if (trailing) return hold(false, { trailArmed: true, peakMark: mark, peakAt: now });
    return exit("TAKE_PROFIT", `Take-profit: a sell nets ${usd(net)}, target ${usd(meta.targetNetUsd)}.`);
  }

  const armNow = !meta.breakevenArmed && net != null && net + 1e-9 >= meta.targetNetUsd * cfg.breakevenAt;
  if (meta.breakevenArmed && net != null && net <= 1e-9) {
    return exit("BREAKEVEN_STOP", `Breakeven: the trade was halfway to target and is back to ${usd(net)} net.`);
  }

  if (markFresh && now - openedAt >= meta.timeLimitMs) {
    return exit("TIME_LIMIT", `Time limit: open ${Math.round((now - openedAt) / 60_000)} min without reaching target${net != null ? ` (${usd(net)} net)` : ""}.`);
  }
  return hold(armNow);
}
