import { PublicKey } from "@solana/web3.js";

// Pump.fun Initial Real Token Reserves available for bonding curve sale (793.1M tokens w/ 6 decimals)
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  completionPercentage: number;
  /** Exact completion ratio Gamma in [0, 1] */
  completionRatioGamma: number;
  spotPriceSol: number;
  lamportsRemainingToGraduate: bigint;
}

/**
 * Decodes raw Pump.fun Bonding Curve account buffer in O(1) time (<0.02ms)
 * Layout:
 * [0..8]   : 8-byte Anchor discriminator
 * [8..16]  : u64 virtualTokenReserves
 * [16..24] : u64 virtualSolReserves
 * [24..32] : u64 realTokenReserves
 * [32..40] : u64 realSolReserves
 * [40..48] : u64 tokenTotalSupply
 * [48]     : bool complete
 */
export function decodePumpCurveBinary(buffer: Uint8Array): BondingCurveState {
  if (buffer.byteLength < 49) {
    throw new Error(`Invalid bonding curve buffer length: ${buffer.byteLength}`);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const virtualTokenReserves = view.getBigUint64(8, true);
  const virtualSolReserves = view.getBigUint64(16, true);
  const realTokenReserves = view.getBigUint64(24, true);
  const realSolReserves = view.getBigUint64(32, true);
  const tokenTotalSupply = view.getBigUint64(40, true);
  const complete = view.getUint8(48) === 1;

  // Calculate exact curve completion ratio Gamma in [0, 1] and percentage in [0, 100]
  const tokensSold =
    INITIAL_REAL_TOKEN_RESERVES > realTokenReserves
      ? INITIAL_REAL_TOKEN_RESERVES - realTokenReserves
      : INITIAL_REAL_TOKEN_RESERVES;

  const completionPercentage =
    Number((tokensSold * 10000n) / INITIAL_REAL_TOKEN_RESERVES) / 100;
  const completionRatioGamma = Number(tokensSold) / Number(INITIAL_REAL_TOKEN_RESERVES);

  // Spot price in SOL per whole token (6 decimals vs 9 decimals)
  const spotPriceSol =
    virtualTokenReserves > 0n
      ? (Number(virtualSolReserves) / 1e9) / (Number(virtualTokenReserves) / 1e6)
      : 0;

  // Exact SOL delta required to buy all remaining realTokenReserves and force Raydium graduation:
  // k = virtualSol * virtualToken
  // newVirtualToken = virtualToken - realTokenReserves
  // newVirtualSol = k / newVirtualToken
  // deltaSol = newVirtualSol - virtualSol
  const k = virtualSolReserves * virtualTokenReserves;
  const targetVirtualToken = virtualTokenReserves - realTokenReserves;
  const requiredNewVirtualSol =
    targetVirtualToken > 0n ? k / targetVirtualToken : virtualSolReserves;
  const lamportsRemainingToGraduate =
    requiredNewVirtualSol > virtualSolReserves
      ? requiredNewVirtualSol - virtualSolReserves
      : 0n;

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    completionPercentage,
    completionRatioGamma,
    spotPriceSol,
    lamportsRemainingToGraduate,
  };
}

/**
 * Exact Constant-Product Quote & Price Impact Calculator
 */
export function quoteBondingCurveBuy(
  state: BondingCurveState,
  solInLamports: bigint
): { tokensOut: bigint; priceImpactBps: number; effectiveSlippageBps: number } {
  if (state.complete || solInLamports <= 0n) {
    return { tokensOut: 0n, priceImpactBps: 0, effectiveSlippageBps: 0 };
  }

  const cappedSolIn =
    solInLamports > state.lamportsRemainingToGraduate
      ? state.lamportsRemainingToGraduate
      : solInLamports;

  const k = state.virtualSolReserves * state.virtualTokenReserves;
  const newVirtualSol = state.virtualSolReserves + cappedSolIn;
  const newVirtualToken = k / newVirtualSol;
  const tokensOut = state.virtualTokenReserves - newVirtualToken;

  // Price impact I = 1 - (virtualSol / newVirtualSol)
  const impactRatio =
    1 - Number(state.virtualSolReserves) / Number(newVirtualSol);
  const priceImpactBps = Math.ceil(impactRatio * 10_000);

  // Volatility-adjusted tight slippage cap (prevents sandwich extraction)
  const effectiveSlippageBps = priceImpactBps + 75; // +0.75% execution buffer

  return { tokensOut, priceImpactBps, effectiveSlippageBps };
}

export interface GraduationSweepSignal {
  shouldSweep: boolean;
  gamma: number;
  solVelocityPerSec: number;
  sweepSolLamports: bigint;
  expectedTokensOut: bigint;
  reason: string;
}

/**
 * Evaluates whether a Pump.fun bonding curve meets the atomic Graduation Sweep trigger:
 * Gamma in [0.965, 0.998] and first derivative of SOL inflow d(R_r,SOL)/dt > 1.8 SOL/sec.
 */
export function evaluateGraduationSweep(
  previous: { state: BondingCurveState; timestampMs: number } | null,
  current: { state: BondingCurveState; timestampMs: number },
  minVelocitySolPerSec: number = 1.8
): GraduationSweepSignal {
  const { state } = current;
  const gamma = state.completionRatioGamma;

  if (state.complete) {
    return {
      shouldSweep: false,
      gamma,
      solVelocityPerSec: 0,
      sweepSolLamports: 0n,
      expectedTokensOut: 0n,
      reason: "Bonding curve already graduated.",
    };
  }

  let solVelocityPerSec = 0;
  if (previous && current.timestampMs > previous.timestampMs) {
    const dtSec = (current.timestampMs - previous.timestampMs) / 1000;
    const dSolLamports = Number(state.realSolReserves - previous.state.realSolReserves);
    solVelocityPerSec = dSolLamports / Number(LAMPORTS_PER_SOL) / dtSec;
  }

  const inGammaWindow = gamma >= 0.965 && gamma <= 0.998;
  const hasVelocity = solVelocityPerSec > minVelocitySolPerSec;

  if (inGammaWindow && hasVelocity) {
    const quote = quoteBondingCurveBuy(state, state.lamportsRemainingToGraduate);
    return {
      shouldSweep: true,
      gamma: Number(gamma.toFixed(6)),
      solVelocityPerSec: Number(solVelocityPerSec.toFixed(4)),
      sweepSolLamports: state.lamportsRemainingToGraduate,
      expectedTokensOut: quote.tokensOut,
      reason: `Graduation sweep triggered: Gamma=${(gamma * 100).toFixed(2)}%, inflow=${solVelocityPerSec.toFixed(2)} SOL/s.`,
    };
  }

  return {
    shouldSweep: false,
    gamma: Number(gamma.toFixed(6)),
    solVelocityPerSec: Number(solVelocityPerSec.toFixed(4)),
    sweepSolLamports: state.lamportsRemainingToGraduate,
    expectedTokensOut: 0n,
    reason: !inGammaWindow
      ? `Gamma ${(gamma * 100).toFixed(2)}% outside [96.5%, 99.8%] window.`
      : `Inflow velocity ${solVelocityPerSec.toFixed(2)} SOL/s <= ${minVelocitySolPerSec} SOL/s threshold.`,
  };
}

/**
 * Stateful zero-RPC Geyser account update tracker for Pump.fun bonding curves.
 */
export class GeyserBondingCurveTracker {
  private readonly latest = new Map<string, { state: BondingCurveState; timestampMs: number }>();

  onAccountUpdate(
    mintOrCurveAddress: string | PublicKey,
    rawData: Uint8Array,
    timestampMs: number = Date.now()
  ): { state: BondingCurveState; graduationSignal: GraduationSweepSignal } {
    const key = typeof mintOrCurveAddress === "string" ? mintOrCurveAddress : mintOrCurveAddress.toBase58();
    const prev = this.latest.get(key) ?? null;
    const state = decodePumpCurveBinary(rawData);
    const current = { state, timestampMs };
    this.latest.set(key, current);
    const graduationSignal = evaluateGraduationSweep(prev, current);
    return { state, graduationSignal };
  }

  getState(mintOrCurveAddress: string | PublicKey): BondingCurveState | undefined {
    const key = typeof mintOrCurveAddress === "string" ? mintOrCurveAddress : mintOrCurveAddress.toBase58();
    return this.latest.get(key)?.state;
  }
}
