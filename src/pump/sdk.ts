/**
 * The pump packages' ESM builds import a named `BN` from Anchor's CJS entry,
 * which Node rejects. The CJS builds are the ones their own tests run.
 * Types still come from the packages; only the runtime load goes through require.
 */
import { createRequire } from "node:module";
import type {
  BondingCurve,
  Global,
  PumpSdk
} from "@pump-fun/pump-sdk";
import type { Pool, PumpAmmSdk, SwapSolanaState } from "@pump-fun/pump-swap-sdk";

const require = createRequire(import.meta.url);
const pump = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const swap = require("@pump-fun/pump-swap-sdk") as typeof import("@pump-fun/pump-swap-sdk");

export const PUMP_SDK: PumpSdk = pump.PUMP_SDK;
export const PUMP_PROGRAM_ID = pump.PUMP_PROGRAM_ID;
export const PUMP_AMM_PROGRAM_ID = pump.PUMP_AMM_PROGRAM_ID;
export const PUMP_FEE_PROGRAM_ID = pump.PUMP_FEE_PROGRAM_ID;
export const PUMP_FEE_CONFIG_PDA = pump.PUMP_FEE_CONFIG_PDA;
export const GLOBAL_PDA = pump.GLOBAL_PDA;
export const bondingCurvePda = pump.bondingCurvePda;
export const canonicalPumpPoolPda = pump.canonicalPumpPoolPda;
export const getFeeRecipient = pump.getFeeRecipient;
export const computeFeesBps = pump.computeFeesBps;
export const bondingCurveMarketCap = pump.bondingCurveMarketCap;
export const getBuyTokenAmountFromSolAmount = pump.getBuyTokenAmountFromSolAmount;
export const pumpIdl = pump.pumpIdl;

export const PUMP_AMM_SDK: PumpAmmSdk = swap.PUMP_AMM_SDK;
export const PUMP_AMM_FEE_CONFIG_PDA = swap.PUMP_AMM_FEE_CONFIG_PDA;
export const GLOBAL_CONFIG_PDA = swap.GLOBAL_CONFIG_PDA;
export const poolMarketCap = swap.poolMarketCap;
export const buyQuoteInput = swap.buyQuoteInput;
export const poolFeesBps = swap.computeFeesBps;

export type { BondingCurve, Global, Pool, SwapSolanaState };
