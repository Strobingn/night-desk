import type { MarketFlow, StrategyMeta } from "./exits.js";
import { STRATEGY } from "./config.js";

/**
 * Slippage ceiling for an engine live rug exit only.
 * Ordinary engine and automatic exits keep the saved exit cap (entry + 3%, 6% today).
 * Same 50% ceiling a manual Sell anyway may use on that one send.
 */
export const RUG_EXIT_SLIPPAGE = 0.5;
/** Pool depth down by this share from the buy, during the watch, sells at once. */
export const RUG_LIQUIDITY_DROP = 0.35;
/** Dev holding down by this many points (0.10 = 10 points) is a dump. */
export const RUG_DEV_DROP = 0.1;
/** Top-10 holding down by this many points is a dump. */
export const RUG_TOP10_DROP = 0.15;
/** Engine live positions are watched for a rug only this long after the fill. */
export const RUG_WATCH_MS = 3 * 60_000;

export interface RugExitInput {
  now: number;
  openedAt: number;
  entryLiquidityUsd?: number | null;
  liquidityUsd?: number | null;
  entryDevHoldingPct?: number | null;
  devHoldingPct?: number | null;
  entryTop10Pct?: number | null;
  top10Pct?: number | null;
  flow?: MarketFlow | null;
}

export interface RugExit {
  code: "RUG_EXIT";
  message: string;
}

const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
const usd = (n: number) => `$${n.toFixed(0)}`;

/** A young engine live position whose pool or holders are leaving. Null when nothing is wrong. */
export function assessRugExit(input: RugExitInput): RugExit | null {
  const age = input.now - input.openedAt;
  if (!(age >= 0) || age > RUG_WATCH_MS) return null;
  const entryLiq = input.entryLiquidityUsd;
  const liq = input.liquidityUsd;
  if (finite(entryLiq) && entryLiq > 0 && finite(liq) && liq >= 0 && liq <= entryLiq * (1 - RUG_LIQUIDITY_DROP)) {
    return {
      code: "RUG_EXIT",
      message: `Pool depth fell to ${usd(liq)} from ${usd(entryLiq)} at the buy (${Math.round(RUG_LIQUIDITY_DROP * 100)}% line). Selling before the pool is gone.`
    };
  }
  if (finite(input.entryDevHoldingPct) && finite(input.devHoldingPct) && input.entryDevHoldingPct - input.devHoldingPct >= RUG_DEV_DROP) {
    return {
      code: "RUG_EXIT",
      message: `Dev holding fell from ${(input.entryDevHoldingPct * 100).toFixed(0)}% to ${(input.devHoldingPct * 100).toFixed(0)}%. Selling before the pool is gone.`
    };
  }
  if (finite(input.entryTop10Pct) && finite(input.top10Pct) && input.entryTop10Pct - input.top10Pct >= RUG_TOP10_DROP) {
    return {
      code: "RUG_EXIT",
      message: `Top 10 holding fell from ${(input.entryTop10Pct * 100).toFixed(0)}% to ${(input.top10Pct * 100).toFixed(0)}%. Selling before the pool is gone.`
    };
  }
  const flow = input.flow;
  if (flow && input.now - flow.at <= STRATEGY.fade.freshMs && finite(entryLiq) && entryLiq > 0 && finite(liq) && liq <= entryLiq * 0.8) {
    const buys = flow.buys5m ?? 0;
    const sells = flow.sells5m ?? 0;
    if (sells >= 20 && sells >= Math.max(1, buys) * 3) {
      return {
        code: "RUG_EXIT",
        message: `Sellers lead ${sells} to ${buys} while the pool is down to ${usd(liq)} from ${usd(entryLiq)}. Selling before the pool is gone.`
      };
    }
  }
  return null;
}

/** True when this live engine exit, inside the watch, may use the rug slippage ceiling. */
export function rugSlippageApplies(pos: { strategy?: StrategyMeta | null; openedAt: number }, code: string, now: number): boolean {
  if (!pos.strategy) return false;
  if (now - pos.openedAt > RUG_WATCH_MS || now < pos.openedAt) return false;
  return code === "RUG_EXIT" || code === "STRATEGY_STOP" || code === "STOP_LOSS" || code === "GAP_RUG" || code === "LIQUIDITY_DROP";
}
