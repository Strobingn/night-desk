/**
 * Pump.fun bonding-curve account decoder and constant-product quote.
 *
 * Layout of the account prefix (Anchor):
 *   [0..8)   discriminator
 *   [8..16)  u64 virtualTokenReserves
 *   [16..24) u64 virtualSolReserves
 *   [24..32) u64 realTokenReserves
 *   [32..40) u64 realSolReserves
 *   [40..48) u64 tokenTotalSupply
 *   [48]     bool complete
 * Newer accounts append more fields (creator, etc.) after byte 49; only the prefix is read.
 *
 * Pure math, no network. Quotes ignore Pump's trade fee; add it at the call site.
 * Not wired into the desk yet: main reads curve state through DexScreener and RugCheck,
 * not raw account data. This is here for when a curve-account stream is added.
 */

/** Tokens offered on the curve before migration: 793.1M at 6 decimals. */
export const PUMP_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
export const PUMP_CURVE_MIN_BYTES = 49;

export interface PumpCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  /** 0–1 share of the curve sold. */
  progress: number;
  /** SOL per whole token, assuming 6 token decimals. */
  spotPriceSol: number;
  /** Lamports needed to buy every remaining curve token (fee excluded). */
  lamportsToComplete: bigint;
}

export function decodePumpCurve(buffer: Uint8Array): PumpCurveState {
  if (buffer.byteLength < PUMP_CURVE_MIN_BYTES) {
    throw new Error(`Bonding curve account too short: ${buffer.byteLength} bytes`);
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const virtualTokenReserves = view.getBigUint64(8, true);
  const virtualSolReserves = view.getBigUint64(16, true);
  const realTokenReserves = view.getBigUint64(24, true);
  const realSolReserves = view.getBigUint64(32, true);
  const tokenTotalSupply = view.getBigUint64(40, true);
  const complete = view.getUint8(48) === 1;

  const remaining =
    realTokenReserves > PUMP_INITIAL_REAL_TOKEN_RESERVES ? PUMP_INITIAL_REAL_TOKEN_RESERVES : realTokenReserves;
  const sold = PUMP_INITIAL_REAL_TOKEN_RESERVES - remaining;
  const progress = Number((sold * 1_000_000n) / PUMP_INITIAL_REAL_TOKEN_RESERVES) / 1_000_000;

  const spotPriceSol =
    virtualTokenReserves > 0n ? Number(virtualSolReserves) / 1e9 / (Number(virtualTokenReserves) / 1e6) : 0;

  // Buying all of realTokenReserves leaves virtualToken − realToken on the curve.
  // Round the SOL side up so the figure is never short.
  let lamportsToComplete = 0n;
  const targetVirtualToken = virtualTokenReserves - realTokenReserves;
  if (!complete && targetVirtualToken > 0n && realTokenReserves > 0n) {
    const k = virtualSolReserves * virtualTokenReserves;
    const needed = ceilDiv(k, targetVirtualToken);
    lamportsToComplete = needed > virtualSolReserves ? needed - virtualSolReserves : 0n;
  }

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    progress,
    spotPriceSol,
    lamportsToComplete
  };
}

export interface CurveBuyQuote {
  /** Lamports actually spent (clipped at what completes the curve). */
  lamportsIn: bigint;
  tokensOut: bigint;
  /** Average fill vs spot, in bps. */
  priceImpactBps: number;
}

/** Exact constant-product buy against the virtual reserves. */
export function quoteCurveBuy(state: PumpCurveState, lamportsIn: bigint): CurveBuyQuote {
  if (state.complete || lamportsIn <= 0n || state.virtualSolReserves <= 0n) {
    return { lamportsIn: 0n, tokensOut: 0n, priceImpactBps: 0 };
  }
  const spend =
    state.lamportsToComplete > 0n && lamportsIn > state.lamportsToComplete ? state.lamportsToComplete : lamportsIn;
  const k = state.virtualSolReserves * state.virtualTokenReserves;
  const newVirtualSol = state.virtualSolReserves + spend;
  const newVirtualToken = ceilDiv(k, newVirtualSol);
  let tokensOut = state.virtualTokenReserves - newVirtualToken;
  if (tokensOut > state.realTokenReserves) tokensOut = state.realTokenReserves;
  if (tokensOut <= 0n) return { lamportsIn: spend, tokensOut: 0n, priceImpactBps: 0 };
  // Average price / spot − 1 = (spend / tokensOut) / (vSol / vToken) − 1.
  const avgOverSpot =
    (Number(spend) * Number(state.virtualTokenReserves)) / (Number(tokensOut) * Number(state.virtualSolReserves));
  const priceImpactBps = Math.max(0, Math.ceil((avgOverSpot - 1) * 10_000));
  return { lamportsIn: spend, tokensOut, priceImpactBps };
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
