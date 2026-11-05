/**
 * Fee rates come from the pump-fees accounts, decoded with the SDK.
 * Nothing here hardcodes 95 / 30 / 125 or the PumpSwap tiers.
 */
import { AccountInfo, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { GLOBAL_CONFIG_PDA, GLOBAL_PDA, PUMP_AMM_SDK, PUMP_SDK, computeFeesBps, poolFeesBps, type BondingCurve, type Global, type Pool } from "./sdk.js";
import { CURVE_FEE_CONFIG, PUMP_FEE_PROGRAM, PUMP_PROGRAM, SWAP_FEE_CONFIG } from "./constants.js";
import type { FeeBps } from "./curve.js";
import type { PumpConnection } from "./rpc.js";

function info(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 0, owner } as AccountInfo<Buffer>;
}

export async function readCurveFees(
  connection: PumpConnection,
  curve: Pick<BondingCurve, "virtualQuoteReserves" | "virtualTokenReserves" | "quoteMint" | "creatorFeeBps" | "isMayhemMode" | "tokenTotalSupply">
): Promise<FeeBps | null> {
  const [globalRaw, feeRaw] = await Promise.all([
    connection.getAccountInfo(GLOBAL_PDA.toBase58()),
    connection.getAccountInfo(CURVE_FEE_CONFIG.toBase58())
  ]);
  if (!globalRaw) return null;
  let global: Global;
  try {
    global = PUMP_SDK.decodeGlobal(info(globalRaw.data, PUMP_PROGRAM));
  } catch {
    return null;
  }
  let feeConfig = null;
  if (feeRaw) {
    try {
      feeConfig = PUMP_SDK.decodeFeeConfig(info(feeRaw.data, PUMP_FEE_PROGRAM));
    } catch {
      feeConfig = null;
    }
  }
  const rates = computeFeesBps({
    global,
    feeConfig,
    mintSupply: curve.isMayhemMode ? curve.tokenTotalSupply : curve.tokenTotalSupply,
    virtualQuoteReserves: curve.virtualQuoteReserves,
    virtualTokenReserves: curve.virtualTokenReserves,
    quoteMint: curve.quoteMint ?? PublicKey.default,
    creatorFeeBps: curve.creatorFeeBps ?? new BN(0)
  });
  return { protocolFeeBps: BigInt(rates.protocolFeeBps.toString(10)), creatorFeeBps: BigInt(rates.creatorFeeBps.toString(10)) };
}

export async function readPoolFees(
  connection: PumpConnection,
  pool: Pool,
  baseReserve: bigint,
  effectiveQuote: bigint,
  baseSupply: bigint
): Promise<{ lpFeeBps: bigint; protocolFeeBps: bigint; creatorFeeBps: bigint } | null> {
  const [globalRaw, feeRaw] = await Promise.all([
    connection.getAccountInfo(GLOBAL_CONFIG_PDA.toBase58()),
    connection.getAccountInfo(SWAP_FEE_CONFIG.toBase58())
  ]);
  if (!globalRaw) return null;
  let globalConfig;
  try {
    globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(info(globalRaw.data, pool.quoteMint));
  } catch {
    try {
      globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(info(globalRaw.data, PublicKey.default));
    } catch {
      return null;
    }
  }
  let feeConfig = null;
  if (feeRaw) {
    try {
      feeConfig = PUMP_AMM_SDK.decodeFeeConfig(info(feeRaw.data, PUMP_FEE_PROGRAM));
    } catch {
      feeConfig = null;
    }
  }
  const rates = poolFeesBps({
    globalConfig,
    feeConfig,
    creator: pool.creator,
    baseMintSupply: new BN(baseSupply.toString(10)),
    baseMint: pool.baseMint,
    baseReserve: new BN(baseReserve.toString(10)),
    quoteReserve: new BN(effectiveQuote.toString(10)),
    quoteMint: pool.quoteMint,
    isMayhemMode: pool.isMayhemMode,
    creatorFeeBps: pool.creatorFeeBps
  });
  return {
    lpFeeBps: BigInt(rates.lpFeeBps.toString(10)),
    protocolFeeBps: BigInt(rates.protocolFeeBps.toString(10)),
    creatorFeeBps: BigInt(rates.creatorFeeBps.toString(10))
  };
}
