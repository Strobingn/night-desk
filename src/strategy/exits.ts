import { STRATEGY, type SignalKind, type StrategyConfig } from "./config.js";

/** Saved on a position the engine opened. */
export interface StrategyMeta {
  variant: string;
  signal: SignalKind;
  stopPct: number;
  targetNetUsd: number;
  timeLimitMs: number;
  breakevenArmed?: boolean;
}

export type StrategyExitCode = "TAKE_PROFIT" | "STRATEGY_STOP" | "BREAKEVEN_STOP" | "TIME_LIMIT";

export interface StrategyExitInput {
  entryPrice: number;
  openedAt: number;
  mark: number;
  /** False when the mark is too old to act on for anything but the stop. */
  markFresh: boolean;
  /** What a full sell would net right now, after modeled costs. Null when it cannot be measured. */
  netPnlUsd: number | null;
  now: number;
  meta: StrategyMeta;
}

export interface StrategyExit {
  action: "hold" | "exit";
  code?: StrategyExitCode;
  message: string;
  /** True the first time the trade reaches half its target. The caller saves it on the position. */
  armBreakeven: boolean;
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

/**
 * The engine's own exits, checked after the desk's hard stop. Order: stop, take-profit,
 * breakeven, time limit. Only the stop may act on a mark that is not fresh.
 */
export function assessStrategyExit(input: StrategyExitInput, cfg: StrategyConfig = STRATEGY): StrategyExit {
  const { entryPrice, openedAt, mark, markFresh, netPnlUsd, now, meta } = input;
  const hold = (armBreakeven = false): StrategyExit => ({ action: "hold", message: "Holding.", armBreakeven });
  if (!(mark > 0) || !Number.isFinite(mark) || !(entryPrice > 0) || !Number.isFinite(entryPrice)) return hold();

  const stopPrice = entryPrice * (1 - meta.stopPct);
  if (mark <= stopPrice * (1 + 1e-9)) {
    return {
      action: "exit",
      code: "STRATEGY_STOP",
      message: `${(meta.stopPct * 100).toFixed(0)}% stop: mark is ${((mark / entryPrice - 1) * 100).toFixed(2)}% from the fill.`,
      armBreakeven: false
    };
  }

  const net = markFresh && netPnlUsd != null && Number.isFinite(netPnlUsd) ? netPnlUsd : null;
  if (net != null && net + 1e-9 >= meta.targetNetUsd) {
    return { action: "exit", code: "TAKE_PROFIT", message: `Take-profit: a sell nets ${usd(net)}, target ${usd(meta.targetNetUsd)}.`, armBreakeven: false };
  }

  const armNow = !meta.breakevenArmed && net != null && net + 1e-9 >= meta.targetNetUsd * cfg.breakevenAt;
  if (meta.breakevenArmed && net != null && net <= 1e-9) {
    return { action: "exit", code: "BREAKEVEN_STOP", message: `Breakeven: the trade was halfway to target and is back to ${usd(net)} net.`, armBreakeven: false };
  }

  if (markFresh && now - openedAt >= meta.timeLimitMs) {
    return {
      action: "exit",
      code: "TIME_LIMIT",
      message: `Time limit: open ${Math.round((now - openedAt) / 60_000)} min without reaching target${net != null ? ` (${usd(net)} net)` : ""}.`,
      armBreakeven: false
    };
  }
  return hold(armNow);
}
