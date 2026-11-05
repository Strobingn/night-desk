import type { ResolvedRules } from "./rules.js";

export type { ResolvedRules };

export type StageName = "scout" | "filter" | "analyst" | "executor" | "risk" | "logger" | "system";

export type TokenSource = "pumpfun" | "raydium" | "replay";

export type ReasonCode =
  | "MINT_AUTHORITY_ACTIVE"
  | "LP_NOT_LOCKED"
  | "HOLDER_CONCENTRATION"
  | "VOLUME_TOO_LOW"
  | "DEV_RUG_HISTORY"
  | "SCORE_BELOW_THRESHOLD"
  | "NO_AVERAGE_DOWN"
  | "REVENGE_COOLDOWN"
  | "INSUFFICIENT_CASH"
  | "LIQUIDITY_TOO_THIN"
  | "PRICE_UNAVAILABLE"
  | "POSITION_CAP"
  | "LIVE_NOT_ARMED"
  | "STOP_LOSS"
  | "TRAIL_STOP"
  | "MANUAL_CLOSE"
  | "LIVE_SWAP_FAILED";

export interface Rejection {
  code: ReasonCode;
  message: string;
}

export interface SocialProxy {
  mentions1h: number;
  hasWebsite: boolean;
  hasTelegram: boolean;
  hasTwitter: boolean;
}

/**
 * Scout → Filter payload.
 * Null safety fields mean "not verified". Filter fails closed on those.
 */
export interface CandidateToken {
  mint: string;
  symbol: string;
  name: string;
  source: TokenSource;
  discoveredAt: number;
  pairAddress?: string;
  dex?: string;
  priceUsd: number;
  liquidityUsd: number;
  volume1hUsd: number;
  marketCapUsd?: number;
  ageSeconds: number;
  /** null = could not verify. Treated as not revoked. */
  mintAuthorityRevoked: boolean | null;
  /**
   * null = could not verify.
   * Fail closed, except while `onBondingCurve` is true (no pool LP exists yet).
   * `false` is always a hard reject.
   */
  lpLockedOrBurned: boolean | null;
  /** Pump mint still on the bonding curve, with no AMM pool LP to lock. */
  onBondingCurve?: boolean;
  lpLockPct?: number | null;
  /** Fraction of supply, 0–1. null = could not verify. */
  top10HolderPct: number | null;
  holderCount: number | null;
  devWallet?: string | null;
  /** Populated when an upstream report already links the deployer to rugs. */
  devRug?: { rugged: boolean; evidence?: string } | null;
  social: SocialProxy;
  decimals?: number | null;
}

export interface FilterCheck {
  code: ReasonCode;
  pass: boolean;
  message: string;
}

/** Filter → Analyst (pass) or Filter → Logger (reject). */
export interface FilterResult {
  token: CandidateToken;
  decision: "pass" | "reject";
  checks: FilterCheck[];
  reasons: Rejection[];
}

export interface ScoreFactor {
  key: "liquidity" | "holders" | "volume" | "age" | "social";
  label: string;
  weight: number;
  /** Unweighted 0–1 factor. */
  raw: number;
  contribution: number;
  note: string;
}

/** Analyst → Executor (trade) or Analyst → Logger (reject). */
export interface AnalystReport {
  token: CandidateToken;
  score: number;
  breakdown: ScoreFactor[];
  decision: "trade" | "reject";
  reason?: Rejection;
}

export interface Fill {
  id: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  priceUsd: number;
  markUsd: number;
  slippage: number;
  notionalUsd: number;
  feeUsd: number;
  mode: "paper" | "live";
  txSignature?: string;
  at: number;
  reason: string;
  code?: ReasonCode;
  score?: number;
}

/** Risk → Executor. The only sell path. */
export interface ExitOrder {
  mint: string;
  symbol: string;
  qty: number;
  markPrice: number;
  liquidityUsd: number;
  reason: Rejection;
  pnlPct: number;
  score: number;
}

export interface Position {
  mint: string;
  symbol: string;
  name: string;
  qty: number;
  entryPrice: number;
  costUsd: number;
  openedAt: number;
  peakPrice: number;
  trailArmed: boolean;
  score: number;
  source: TokenSource;
  liquidityUsd: number;
  decimals?: number | null;
  tradeId: string;
  closing?: boolean;
}

export interface ClosedTrade {
  id: string;
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  costUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  pnlPct: number;
  exitCode: ReasonCode;
  score: number;
  mode: "paper" | "live";
}

export interface FeedEvent {
  id: string;
  ts: number;
  stage: StageName;
  kind: "info" | "pass" | "reject" | "fill" | "exit";
  symbol?: string;
  mint?: string;
  code?: ReasonCode | string;
  message: string;
  detail?: string;
}

export interface EquityPoint {
  t: number;
  equity: number;
  cash: number;
}

export interface PositionView {
  mint: string;
  symbol: string;
  name: string;
  qty: number;
  entryPrice: number;
  markPrice: number;
  costUsd: number;
  marketValueUsd: number;
  pnlUsd: number;
  pnlPct: number;
  peakPrice: number;
  trailArmed: boolean;
  /** Hard stop. The only automatic exit. */
  stopPrice: number;
  /** Peak minus the trail gap, once the hint is armed. Not an order. */
  trailHintPrice: number | null;
  score: number;
  source: TokenSource;
  openedAt: number;
}

export interface FeedStatus {
  mode: "auto" | "replay" | "live";
  demo: boolean;
  pumpConnected: boolean;
  dexLastPollAt: number | null;
  lastError?: string;
  sightings: number;
  enriched: number;
  dropped: number;
}

export interface PipelineCounts {
  scouted: number;
  filteredPass: number;
  filteredKill: number;
  analystTrade: number;
  analystReject: number;
  fills: number;
  riskExits: number;
  executorSkips: number;
}

export interface AdviceNote {
  id: string;
  ts: number;
  stance: "sell" | "skip" | "hold" | "watch";
  symbol?: string;
  mint?: string;
  text: string;
}

export interface DeskSnapshot {
  mode: "paper" | "live";
  liveRequested: boolean;
  armError?: string;
  startedAt: number;
  now: number;
  startingBalanceUsd: number;
  cashUsd: number;
  equityUsd: number;
  sessionPnlUsd: number;
  sessionPnlPct: number;
  rules: ResolvedRules;
  feed: FeedStatus;
  pipeline: PipelineCounts;
  killReasons: Record<string, number>;
  positions: PositionView[];
  closed: ClosedTrade[];
  equity: EquityPoint[];
  events: FeedEvent[];
  /** Latest advisory lines. Display only. */
  advice: AdviceNote[];
}

export type DeskEvents = {
  "scout.candidate": CandidateToken;
  "market.tick": { mint: string; priceUsd: number; at: number };
  "filter.result": FilterResult;
  "analyst.report": AnalystReport;
  "executor.fill": Fill;
  "executor.skip": { token: CandidateToken; reason: Rejection; score?: number };
  "risk.exit": ExitOrder;
  "log.event": FeedEvent;
};

export interface RawSighting {
  mint: string;
  symbol?: string;
  name?: string;
  source: "pumpfun" | "raydium";
  devWallet?: string;
  observedAt: number;
}

export type RugLookup =
  | { status: "clean"; evidence?: string }
  | { status: "unknown"; evidence?: string }
  | { status: "rugged"; evidence: string };

export interface RugRegistry {
  lookup(wallet?: string | null): Promise<RugLookup>;
}
