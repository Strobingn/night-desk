import type { ReasonCode, Rejection } from "../types.js";

/** Auto buys only. Manual buys never consult this. */
export function autoBuyBlock(input: {
  autoBuy: boolean;
  maxTradesPerHour: number;
  buysLastHour: number;
  dailyMaxLossUsd: number;
  lossSoFarUsd: number;
}): { ok: true } | { ok: false; reason: Rejection } {
  if (!input.autoBuy) {
    return {
      ok: false,
      reason: {
        code: "AUTO_BUY_OFF" satisfies ReasonCode,
        message: "Auto-buy is off. A manual buy still works."
      }
    };
  }
  if (input.maxTradesPerHour > 0 && input.buysLastHour >= input.maxTradesPerHour) {
    return {
      ok: false,
      reason: {
        code: "TRADE_RATE" satisfies ReasonCode,
        message: `Already ${input.buysLastHour} buy(s) in the last hour. The desk allows ${input.maxTradesPerHour}.`
      }
    };
  }
  if (input.dailyMaxLossUsd > 0 && input.lossSoFarUsd >= input.dailyMaxLossUsd) {
    return {
      ok: false,
      reason: {
        code: "DAILY_LOSS" satisfies ReasonCode,
        message: `Daily loss is $${input.lossSoFarUsd.toFixed(2)}, past the $${input.dailyMaxLossUsd.toFixed(2)} pause. Auto-buys wait until the next UTC day.`
      }
    };
  }
  return { ok: true };
}
