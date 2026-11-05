/**
 * Bonding-curve math from virtual reserves.
 *
 * The canonical SOL-curve initials below are the long-standing pump `Global`
 * values (virtual token 1.073e15, virtual quote 30 SOL, real token 793.1e12,
 * supply 1e15). @pump-fun/pump-sdk does not hardcode them — they live on the
 * Global account — and `bondingCurveMarketCap` reproduces ~27.96 SOL at the
 * start, ~85.005 SOL of quote to finish the real tokens, and ~410.9 SOL
 * graduation market cap. Quotes use the same integer formulas as the SDK
 * (`getBuyTokenAmountFromSolAmount` / `getSellSolAmountFromTokenAmount`).
 * Fee bps are an input from a decoded fee config, never a baked-in 125.
 */
import { PublicKey } from "@solana/web3.js";
import type { CurveState, RawAmount, ReverseQuote, TradeQuote } from "./types.js";

export interface CurveReserves {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete?: boolean;
  creator?: string;
  isMayhemMode?: boolean;
  quoteMint?: string | null;
}

/** Pump Global initials for a SOL curve. See the file comment. */
export const CANONICAL_SOL_CURVE: CurveReserves = {
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualQuoteReserves: 30_000_000_000n,
  realTokenReserves: 793_100_000_000_000n,
  realQuoteReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
  creator: PublicKey.default.toBase58(),
  isMayhemMode: false,
  quoteMint: null
};

const CANONICAL_OFFSET = CANONICAL_SOL_CURVE.virtualTokenReserves - CANONICAL_SOL_CURVE.realTokenReserves;
const CANONICAL_REAL = CANONICAL_SOL_CURVE.realTokenReserves;

export function raw(n: bigint): RawAmount {
  return n.toString();
}

export function parseRaw(value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new Error(`Not an integer amount: ${value}`);
  return BigInt(value);
}

/** `virtualQuote * supply / virtualToken`. Matches `bondingCurveMarketCap`. */
export function marketCapLamports(reserves: CurveReserves): bigint {
  if (reserves.virtualTokenReserves <= 0n) throw new Error("virtual token reserves are zero");
  return (reserves.virtualQuoteReserves * reserves.tokenTotalSupply) / reserves.virtualTokenReserves;
}

/**
 * Quote the curve must receive to buy `tokens` (SDK `div` + 1).
 * This is the pre-fee curve number behind "85.005 SOL to graduate".
 */
export function solInForTokens(reserves: CurveReserves, tokens: bigint): bigint {
  if (tokens <= 0n) return 0n;
  if (tokens >= reserves.virtualTokenReserves) throw new Error("tokens exhaust the virtual reserves");
  return (tokens * reserves.virtualQuoteReserves) / (reserves.virtualTokenReserves - tokens) + 1n;
}

/** Constant-product tokens out for a quote amount that lands on the curve. */
export function tokensForCurveSol(reserves: CurveReserves, solIn: bigint): bigint {
  if (solIn <= 0n) return 0n;
  const out = (solIn * reserves.virtualTokenReserves) / (reserves.virtualQuoteReserves + solIn);
  return out < reserves.realTokenReserves ? out : reserves.realTokenReserves;
}

/** SDK sell: `tokens * virtualQuote / (virtualToken + tokens)`. */
export function solOutForTokens(reserves: CurveReserves, tokens: bigint): bigint {
  if (tokens <= 0n) return 0n;
  return (tokens * reserves.virtualQuoteReserves) / (reserves.virtualTokenReserves + tokens);
}

function ceilFee(amount: bigint, bps: bigint): bigint {
  if (bps <= 0n || amount <= 0n) return 0n;
  return (amount * bps + 9_999n) / 10_000n;
}

export interface FeeBps {
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

function creatorCharged(reserves: CurveReserves, fees: FeeBps | null): bigint {
  if (!fees) return 0n;
  if (!reserves.creator || reserves.creator === PublicKey.default.toBase58()) return 0n;
  return fees.creatorFeeBps;
}

/**
 * Tokens a buy budget yields. Mirrors `getBuyTokenAmountFromSolAmount`:
 * one lamport is held back, then `bps` is taken, then the product runs.
 */
export function buyTokens(reserves: CurveReserves, budgetLamports: bigint, fees: FeeBps | null = null): { tokens: bigint; feeLamports: bigint; feeBps: bigint } {
  if (budgetLamports <= 1n || reserves.virtualTokenReserves <= 0n) return { tokens: 0n, feeLamports: 0n, feeBps: 0n };
  const creator = creatorCharged(reserves, fees);
  const bps = (fees?.protocolFeeBps ?? 0n) + creator;
  const net = ((budgetLamports - 1n) * 10_000n) / (bps + 10_000n);
  const tokens = tokensForCurveSol(reserves, net);
  return { tokens, feeLamports: budgetLamports - net, feeBps: bps };
}

/**
 * Wallet lamports to buy `tokens`, fees ceil'd on the curve quote the way
 * `getBuySolAmountFromTokenAmount` adds `getFee`.
 */
export function buyCost(reserves: CurveReserves, tokens: bigint, fees: FeeBps | null = null): { lamports: bigint; curveLamports: bigint; feeLamports: bigint; feeBps: bigint } {
  const capped = tokens > reserves.realTokenReserves ? reserves.realTokenReserves : tokens;
  const curveLamports = solInForTokens(reserves, capped);
  const creator = creatorCharged(reserves, fees);
  const bps = (fees?.protocolFeeBps ?? 0n) + creator;
  const feeLamports = ceilFee(curveLamports, fees?.protocolFeeBps ?? 0n) + ceilFee(curveLamports, creator);
  return { lamports: curveLamports + feeLamports, curveLamports, feeLamports, feeBps: bps };
}

export function sellProceeds(reserves: CurveReserves, tokens: bigint, fees: FeeBps | null = null): { lamports: bigint; curveLamports: bigint; feeLamports: bigint; feeBps: bigint } {
  const curveLamports = solOutForTokens(reserves, tokens);
  const creator = creatorCharged(reserves, fees);
  const bps = (fees?.protocolFeeBps ?? 0n) + creator;
  const feeLamports = ceilFee(curveLamports, fees?.protocolFeeBps ?? 0n) + ceilFee(curveLamports, creator);
  const lamports = curveLamports > feeLamports ? curveLamports - feeLamports : 0n;
  return { lamports, curveLamports, feeLamports, feeBps: bps };
}

export function solRemaining(reserves: CurveReserves): bigint {
  if (reserves.complete || reserves.realTokenReserves <= 0n) return 0n;
  return solInForTokens(reserves, reserves.realTokenReserves);
}

/** Reserves after the real tokens are bought, using the constant-product deposit (floor, no +1). */
export function graduationMarketCapLamports(reserves: CurveReserves): bigint {
  if (reserves.realTokenReserves <= 0n) return marketCapLamports(reserves);
  const endToken = reserves.virtualTokenReserves - reserves.realTokenReserves;
  if (endToken <= 0n) throw new Error("real token reserves pass the virtual reserves");
  const added = (reserves.realTokenReserves * reserves.virtualQuoteReserves) / endToken;
  return ((reserves.virtualQuoteReserves + added) * reserves.tokenTotalSupply) / endToken;
}

export function progressPct(reserves: CurveReserves): number {
  if (reserves.complete || reserves.realTokenReserves <= 0n) return 100;
  const offset = reserves.virtualTokenReserves - reserves.realTokenReserves;
  if (offset === CANONICAL_OFFSET && reserves.realTokenReserves <= CANONICAL_REAL) {
    const sold = CANONICAL_REAL - reserves.realTokenReserves;
    return Number((sold * 10_000n) / CANONICAL_REAL) / 100;
  }
  const left = solRemaining(reserves);
  const inn = reserves.realQuoteReserves;
  const denom = inn + left;
  if (denom <= 0n) return 0;
  return Number((inn * 10_000n) / denom) / 100;
}

export function curveState(mint: string, reserves: CurveReserves): CurveState {
  return {
    mint,
    virtualTokenReserves: raw(reserves.virtualTokenReserves),
    virtualQuoteReserves: raw(reserves.virtualQuoteReserves),
    realTokenReserves: raw(reserves.realTokenReserves),
    realQuoteReserves: raw(reserves.realQuoteReserves),
    tokenTotalSupply: raw(reserves.tokenTotalSupply),
    complete: Boolean(reserves.complete),
    creator: reserves.creator ?? PublicKey.default.toBase58(),
    isMayhemMode: Boolean(reserves.isMayhemMode),
    quoteMint: reserves.quoteMint ?? null,
    marketCapLamports: raw(marketCapLamports(reserves)),
    progressPct: progressPct(reserves),
    solInCurveLamports: raw(reserves.realQuoteReserves),
    solRemainingLamports: raw(solRemaining(reserves)),
    graduationMarketCapLamports: raw(graduationMarketCapLamports(reserves))
  };
}

export function reservesOf(state: CurveState): CurveReserves {
  return {
    virtualTokenReserves: parseRaw(state.virtualTokenReserves),
    virtualQuoteReserves: parseRaw(state.virtualQuoteReserves),
    realTokenReserves: parseRaw(state.realTokenReserves),
    realQuoteReserves: parseRaw(state.realQuoteReserves),
    tokenTotalSupply: parseRaw(state.tokenTotalSupply),
    complete: state.complete,
    creator: state.creator,
    isMayhemMode: state.isMayhemMode,
    quoteMint: state.quoteMint
  };
}

function mcapAfterBuy(reserves: CurveReserves, solIn: bigint): bigint {
  if (solIn <= 0n) return marketCapLamports(reserves);
  const tokens = tokensForCurveSol(reserves, solIn);
  const next: CurveReserves = {
    ...reserves,
    virtualTokenReserves: reserves.virtualTokenReserves - tokens,
    virtualQuoteReserves: reserves.virtualQuoteReserves + solIn,
    realTokenReserves: reserves.realTokenReserves - tokens,
    realQuoteReserves: reserves.realQuoteReserves + solIn
  };
  if (next.virtualTokenReserves <= 0n) return graduationMarketCapLamports(reserves);
  return marketCapLamports(next);
}

/** SOL (lamports) that lands on the curve to reach `target` market cap. */
export function solToReachMarketCap(reserves: CurveReserves, targetLamports: bigint): ReverseQuote {
  const current = marketCapLamports(reserves);
  if (targetLamports <= current) {
    return {
      targetMarketCapLamports: raw(targetLamports),
      solNeededLamports: "0",
      reachable: true,
      marketCapLamports: raw(current)
    };
  }
  const grad = graduationMarketCapLamports(reserves);
  const remaining = solRemaining(reserves);
  if (targetLamports > grad) {
    return {
      targetMarketCapLamports: raw(targetLamports),
      solNeededLamports: raw(remaining),
      reachable: false,
      marketCapLamports: raw(grad)
    };
  }
  let lo = 0n;
  let hi = remaining > 0n ? remaining : targetLamports;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (mcapAfterBuy(reserves, mid) >= targetLamports) hi = mid;
    else lo = mid + 1n;
  }
  return {
    targetMarketCapLamports: raw(targetLamports),
    solNeededLamports: raw(lo),
    reachable: true,
    marketCapLamports: raw(mcapAfterBuy(reserves, lo))
  };
}

export function quoteCurve(reserves: CurveReserves, side: "buy" | "sell", amount: bigint, fees: FeeBps | null): TradeQuote {
  if (side === "buy") {
    const bought = buyTokens(reserves, amount, fees);
    return {
      venue: "curve",
      side,
      solLamports: raw(amount),
      tokenAmount: raw(bought.tokens),
      feeBps: fees ? Number(bought.feeBps) : null,
      feeLamports: raw(bought.feeLamports),
      feeSource: fees ? "chain" : "none"
    };
  }
  const sold = sellProceeds(reserves, amount, fees);
  return {
    venue: "curve",
    side,
    solLamports: raw(sold.lamports),
    tokenAmount: raw(amount),
    feeBps: fees ? Number(sold.feeBps) : null,
    feeLamports: raw(sold.feeLamports),
    feeSource: fees ? "chain" : "none"
  };
}
