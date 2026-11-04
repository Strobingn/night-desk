/**
 * Stable shapes the later pump chunks build on:
 * terminal + wallet signer, alerts + hot-coin scanner, journal + portfolio,
 * graduation sniper + migration tracker.
 * Integer amounts are base-10 strings (lamports or raw token units).
 */

/** Lamports, or raw token units, as a base-10 integer string. Signed when noted. */
export type RawAmount = string;

export interface CurveState {
  mint: string;
  virtualTokenReserves: RawAmount;
  virtualQuoteReserves: RawAmount;
  realTokenReserves: RawAmount;
  realQuoteReserves: RawAmount;
  tokenTotalSupply: RawAmount;
  complete: boolean;
  /** Base58. The all-1s system program id means "no creator". */
  creator: string;
  isMayhemMode: boolean;
  /** Null on a legacy SOL curve (the account stores the zero pubkey). */
  quoteMint: string | null;
  /** `virtualQuote * supply / virtualToken`, lamports. */
  marketCapLamports: RawAmount;
  /** 0–100. Token progress toward `realTokenReserves = 0` on the canonical SOL curve. */
  progressPct: number;
  /** Real quote sitting in the curve, lamports. */
  solInCurveLamports: RawAmount;
  /**
   * Additional quote the curve must receive to buy out `realTokenReserves`
   * (SDK floor-div + 1, fees not included). Lamports.
   */
  solRemainingLamports: RawAmount;
  /** Market cap once `realTokenReserves` hits 0, lamports. */
  graduationMarketCapLamports: RawAmount;
}

export interface TradeEvent {
  mint: string;
  signature?: string;
  slot?: number;
  isBuy: boolean;
  user: string;
  /** Quote that moved on the curve, lamports. PumpPortal SOL is converted. */
  solAmountLamports: RawAmount;
  tokenAmount: RawAmount;
  virtualQuoteReserves: RawAmount;
  virtualTokenReserves: RawAmount;
  realQuoteReserves: RawAmount;
  realTokenReserves: RawAmount;
  feeLamports: RawAmount;
  creator: string;
  /** Unix milliseconds. */
  timestamp: number;
  ixName?: string;
  quoteMint: string | null;
  source: "account" | "pumpportal" | "log";
}

export interface PumpCoin {
  mint: string;
  name?: string;
  symbol?: string;
  creator?: string;
  createdAt?: number;
  complete: boolean;
  /** "legacy" = Tokenkeg (`create`). "token2022" = Token-2022 (`create_v2`). */
  tokenProgram?: "legacy" | "token2022";
  curve: CurveState | null;
  pool: PoolState | null;
  lastTradeAt?: number;
  updatedAt: number;
}

export interface PoolState {
  address: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  /** Base-token vault balance, raw. */
  baseReserve: RawAmount;
  /** Quote vault balance, raw (lamports when the quote is WSOL). */
  quoteReserve: RawAmount;
  /**
   * Signed i128 from the pool account. Usually `-(protocolFees + creatorFees)`.
   * Price uses `quoteReserve + virtualQuoteReserves`.
   */
  virtualQuoteReserves: RawAmount;
  /** `quoteReserve + virtualQuoteReserves`. */
  effectiveQuoteReserve: RawAmount;
  lpSupply: RawAmount;
  coinCreator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  creatorFeeBps: RawAmount;
  /** Quote raw units per one raw base unit, decimal string. */
  priceQuotePerBase: string;
  /** Market cap in quote raw units (lamports for SOL pools). */
  marketCapLamports: RawAmount;
}

export interface TradeQuote {
  venue: "curve" | "pumpswap";
  side: "buy" | "sell";
  solLamports: RawAmount;
  tokenAmount: RawAmount;
  /** Sum of protocol + creator (+ lp on a pool) basis points, when a fee account was read. */
  feeBps: number | null;
  feeLamports: RawAmount;
  /** "chain" when the bps came from a decoded fee config. "none" when no config was supplied. */
  feeSource: "chain" | "none";
}

export interface ReverseQuote {
  targetMarketCapLamports: RawAmount;
  solNeededLamports: RawAmount;
  /** False when the target sits past graduation. `solNeededLamports` is then the remaining curve quote. */
  reachable: boolean;
  marketCapLamports: RawAmount;
}

export interface SimResult {
  ok: boolean;
  err?: string;
  units?: number | null;
  logs?: string[];
}

export interface TradeIntent {
  id: string;
  mint: string;
  side: "buy" | "sell";
  venue: "curve" | "pumpswap";
  /** Fee payer. Signing happens in this wallet, never on the server. */
  wallet: string;
  solLamports: RawAmount;
  tokenAmount: RawAmount;
  mode: "simulate" | "live";
  /**
   * True unless this process has an armed session and the client asked for live.
   * A restart clears the arm, so this returns to true.
   */
  simulateOnly: boolean;
  /** Base64 legacy transaction. Null when the build failed before serialize. */
  unsignedTx: string | null;
  feePayer: string;
  simulation: SimResult | null;
  createdAt: number;
  status: "reserved" | "rejected";
}

export interface ArmSession {
  armed: boolean;
  armedAt: number | null;
  /** Set when the operator armed for one wallet. Null means any fee payer, still unsigned. */
  wallet: string | null;
}

export interface Caps {
  tradeLamports: RawAmount;
  dayLamports: RawAmount;
  tradeCeilingLamports: RawAmount;
  dayCeilingLamports: RawAmount;
  tradeDefaultLamports: RawAmount;
  dayDefaultLamports: RawAmount;
  /** Reserved unsigned intents in the rolling 24h window count here. */
  dayUsedLamports: RawAmount;
  windowMs: number;
}

export type AlertKind = "trade" | "progress" | "graduation" | "cap" | "custom";

/** Hook for the alerts + scanner chunk. Core emits these; it does not page anyone. */
export interface AlertEvent {
  id: string;
  kind: AlertKind;
  mint?: string;
  at: number;
  message: string;
  data?: Record<string, unknown>;
}
