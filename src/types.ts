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
  | "MANUAL_BUY"
  | "MAX_OPEN_POSITIONS"
  | "ENTRY_SLIPPAGE"
  | "EXIT_IMPACT"
  | "LIVE_SWAP_FAILED"
  | "TOKEN_TOO_NEW"
  | "TOKEN_TOO_OLD"
  | "HOLDER_COUNT"
  | "DEV_HOLDING"
  | "AUTO_BUY_OFF"
  | "TRADE_RATE"
  | "DAILY_LOSS"
  | "EXPOSURE_CAP"
  | "PARTIAL_SELL"
  | "HARD_KILL"
  | "LOOKUP_FAILED"
  /** v13.3: a stop exit that filled materially below the stop line (price gapped or the pool was pulled). */
  | "GAP_RUG"
  /** v13.3 pre-buy guard: price fell hard in the last ~60s. */
  | "PRICE_CRASH"
  /** v13.3 pre-buy guard: pool liquidity is being pulled. */
  | "LIQUIDITY_PULL"
  /** v13.5 live: the optional live daily spend cap is used up. */
  | "LIVE_DAILY_CAP"
  /** v13.5 live: wallet balance unknown, or not enough USDC / SOL for the trade and fees. */
  | "LIVE_WALLET";

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
  /** Feed that actually priced this candidate. A later mark from another feed is ignored. */
  priceFeed?: "dexscreener" | "jupiter" | "gecko" | "scout" | "replay" | "listing";
  priceUsd: number;
  liquidityUsd: number;
  volume1hUsd: number;
  /** v13.1 tape: DexScreener 5m volume and 1h price change (percent, e.g. 12.5). Display only. */
  volume5mUsd?: number;
  priceChange1hPct?: number;
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
  /** Fraction of supply the dev wallet holds. null = not verified. */
  devHoldingPct?: number | null;
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
  /** Set when a soft flag passed the coin through. It is not a kill code. */
  flags?: Array<"LP_UNLOCKED">;
}

export interface ScoreFactor {
  key: "liquidity" | "holders" | "volume" | "age" | "social" | "boost";
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
  /** Who opened the position. Analyst trades stay unlabeled; manual buys say so. */
  entry?: "manual" | "analyst";
  /** True when the only filter miss was an unlocked LP and the desk allowed it. */
  lpUnlocked?: boolean;
  liquidityUsd: number;
  decimals?: number | null;
  /** Feed that priced the entry. Stops ignore every other feed. */
  priceFeed?: "dexscreener" | "jupiter" | "gecko" | "scout" | "replay" | "listing";
  /** Pool that priced the entry. A different pair cannot mark or stop the position. */
  pairAddress?: string;
  dex?: string;
  tradeId: string;
  closing?: boolean;
  /** v12: "manual" plus the platform the coin was added from, e.g. "manual · DexScreener". */
  tag?: string;
  /** v13.5: opened with a real on-chain swap. */
  live?: boolean;
  /** v13.5 live trail anchor: the mark the buy was sized against. */
  entryMark?: number;
  /** v13.5 live trail: highest accepted risk mark since entry. */
  markPeak?: number;
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
  entryPrice?: number;
  /** The true fill price. */
  exitPrice?: number;
  /** v13.3 the stop line in force (entry × (1 − stop)). */
  stopPrice?: number;
  /** v13.3 the mark that triggered the exit (may already be past the stop). */
  triggerPrice?: number;
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
  entry?: "manual" | "analyst";
  lpUnlocked?: boolean;
  /** Milliseconds since the mark shown on the card was taken. */
  markAgeMs?: number;
  /** v13.2 wall time of the mark shown (server clock; compare with snapshot.now). */
  markAt?: number;
  /** v13.2 feed of the mark shown: "chain" (pool reserves), "dexscreener", "jupiter", … */
  markFeed?: string;
  /** v13.2 age of the mark the hard stop uses. */
  riskMarkAgeMs?: number;
  /** v13.2 client only: local wall time the shown mark was taken (receive time − markAgeMs). */
  markLocalAt?: number;
  openedAt: number;
  /** v12 tag shown on the card, e.g. "manual · pump.fun". */
  tag?: string;
}

export interface FeedStatus {
  mode: "auto" | "replay" | "live";
  demo: boolean;
  pumpConnected: boolean;
  dexLastPollAt: number | null;
  geckoLastPollAt?: number | null;
  jupiterLastPollAt?: number | null;
  bitqueryLastPollAt?: number | null;
  /** v12.1: only set once a source has failed for 2+ minutes straight (old clients show it as the banner). */
  lastError?: string;
  sightings: number;
  enriched: number;
  dropped: number;
  /** v12.1 per-source Scout status. */
  sources?: FeedSourceStatus[];
  /** v12.1 shared request budget per rate-limit bucket. */
  budgets?: FeedBudgetStatus[];
}

/** v13.3 "stale": connected but silent past the watchdog window (Pump stream). */
export type FeedSourceState = "live" | "stale" | "backoff" | "down" | "off";

export interface FeedSourceStatus {
  id: "pump" | "dexscreener" | "gecko" | "jupiter" | "dexpaprika" | "bitquery" | "pumpapi" | "launchlab";
  label: string;
  enabled: boolean;
  state: FeedSourceState;
  detail?: string;
  /** Backing off until this time (ms). */
  retryAt: number | null;
  failingSince: number | null;
  lastOkAt: number | null;
  reqPerMin: number;
  budgetPerMin: number | null;
  limitPerMin: number | null;
  count429: number;
  sightingsPerMin: number;
}

export interface FeedBudgetStatus {
  id: string;
  source: string;
  limitPerMin: number;
  budgetPerMin: number;
  reqLastMin: number;
  cacheHitsLastMin: number;
  count429: number;
  sent: number;
  rateFactor: number;
  pausedUntil: number | null;
  queued: number;
  note: string;
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
  /** v13.3 stop exits that filled past the stop line (gap/rug). */
  gapExits?: number;
}

export interface AdviceNote {
  id: string;
  ts: number;
  stance: "sell" | "skip" | "hold" | "watch" | "near-miss";
  symbol?: string;
  mint?: string;
  text: string;
  code?: string;
  score?: number;
}

/**
 * Host checklist for real-money mode. Nothing here writes LIVE_TRADING or a secret.
 * The desk stays paper until Austin sets LIVE_TRADING=true and WALLET_KEYPAIR_PATH and restarts.
 */
export interface LiveReadiness {
  mode: "paper" | "live";
  /** Exact env LIVE_TRADING=true. The phone cannot set this. */
  liveTradingFlag: boolean;
  /** Keypair file exists on the desk host. The path and secret are not included. */
  keypairPresent: boolean;
  /** Public address derived on the desk host. Null when the file is missing. */
  walletPublicKey: string | null;
  /** SOLANA_RPC_URL is non-empty. The URL itself is not sent (it may contain an API key). */
  rpcPresent: boolean;
  /** Operator note. Does not change mode and does not store a wallet. */
  operatorReady: boolean;
  lines: string[];
}

export interface ManualBuyResult {
  ok: true;
  mint: string;
  symbol: string;
  /** Dollars actually filled. Never above the position cap. */
  sizeUsd: number;
  mode: "paper" | "live";
  /** Present when the request was larger than the cap and cut down to sizeUsd. */
  clampedFrom?: number;
  /** v13.3 the booked fill price (for the one-tap toast). */
  fillPriceUsd?: number;
}

export interface ManualBuyRefusal {
  ok: false;
  error: string;
  code: string;
}

/** Operator preferences saved with the volume floor. The hard stop is not one of these. */
export interface DeskPrefs {
  /** Null means a blank manual buy uses the position cap. */
  defaultBuyUsd: number | null;
  maxOpenPositions: number;
  /** Default on. A lone unlocked LP can pass and be bought. */
  allowUnlockedLp: boolean;
  autoBuy: boolean;
  minLiquidityUsd: number;
  minTokenAgeMin: number;
  maxTokenAgeMin: number;
  minHolderCount: number;
  maxDevHoldingPct: number;
  maxTradesPerHour: number;
  dailyMaxLossUsd: number;
  cooldownHours: number;
  trailTakeProfit: boolean;
  notifyNearMiss: boolean;
  notifyFills: boolean;
  notifyStops: boolean;
  pnlAlertPct: number;
  scoutDexscreener: boolean;
  scoutGecko: boolean;
  scoutJupiter: boolean;
  scoutDexpaprika: boolean;
  scoutBitquery: boolean;
  /** v13.3 keyless Pump.fun API and Raydium LaunchLab (Bonk.fun) listings. */
  scoutPumpApi: boolean;
  scoutLaunchLab: boolean;
  /** v12. Fixed $ per position; null = size from the % cap. */
  positionSizeUsd: number | null;
  /** v12. Total open exposure as a share of equity (0.1–1). 1 = no extra limit. */
  maxExposurePct: number;
  /** v12. Amount the paper book resets to ($100–$10,000). */
  paperResetUsd: number;
  /** v13.2 held-position price loop, ms (1000–10000, default 1500). */
  positionRefreshMs?: number;
  /** v13.3 full-exit impact tolerance checked before a buy. null = entry cap + 3%. */
  maxExitSlippage?: number | null;
  /** v13.5 live per-trade USD (default $5). */
  liveTradeUsd?: number;
  /** v13.5 live daily spend cap USD; null = off. */
  liveDailyCapUsd?: number | null;
  /** v13.5 live trailing stop, fraction (0.01 = 1%). */
  liveTrailPct?: number;
}

/** v12 GET /api/lookup result. */
export interface CoinLookup {
  ok: true;
  mint: string;
  symbol: string;
  name: string;
  platform: string;
  tag: string;
  priceUsd: number;
  liquidityUsd: number;
  volume1hUsd: number;
  marketCapUsd: number | null;
  ageSeconds: number;
  pairAddress: string | null;
  dex: string | null;
  dexscreenerUrl: string;
  /** Where the price came from. Pump curve coins price off Jupiter (cross-checked with DexScreener). */
  priceSource: "dexscreener" | "jupiter";
  checks: Array<{ code: string; pass: boolean; message: string }>;
  filterPass: boolean;
  hardKills: Array<{ code: string; message: string }>;
  analyst: { score: number; line: number; pass: boolean };
  /** Biggest size the pool takes under the entry slippage cap and the exit-depth check. */
  poolMaxUsd: number;
  positionCapUsd: number;
  manualMaxUsd: number;
  cashUsd: number;
  maxEntrySlippage: number;
  held: boolean;
  watching: boolean;
  canBuy: boolean;
  buyBlockedReason: string | null;
}

export interface CoinLookupError {
  ok: false;
  error: string;
  code: "LOOKUP_FAILED" | "PRICE_UNAVAILABLE";
  platform?: string;
  mint?: string;
}

/** v12 watchlist row. Persisted in the desk store under data/. */
export interface WatchItem {
  mint: string;
  symbol: string;
  name: string;
  platform: string;
  addedAt: number;
  addedPriceUsd: number;
  lastPriceUsd: number | null;
  lastAt: number | null;
  /** (last - added) / added. null when no live price yet. */
  changePct: number | null;
  dexscreenerUrl: string;
}

export interface MintCooldown {
  mint: string;
  until: number;
  /** Whole minutes left, rounded up. Matches the revenge refusal text. */
  minutesLeft: number;
}

/** v13.5 read-only wallet card. Never carries the secret key or the RPC URL. */
export interface WalletView {
  /** A usable key is loaded on the desk host. */
  keyLoaded: boolean;
  /** "env" = WALLET_PRIVATE_KEY, "file" = WALLET_KEYPAIR_PATH. */
  keySource: "env" | "file" | null;
  /** WALLET_PRIVATE_KEY has a value that is not a Solana private key. */
  keyInvalid: boolean;
  publicKey: string | null;
  solBalance: number | null;
  usdcBalance: number | null;
  balanceAt: number | null;
  balanceError: string | null;
  /** Desk is placing real swaps (LIVE_TRADING=true and a usable key at boot). */
  live: boolean;
  liveRequested: boolean;
  /** true = the free public Solana RPC (rate limited). */
  rpcPublic: boolean;
  /** Live per-trade size, live cap, live trail (also in prefs). */
  liveTradeUsd: number;
  liveDailyCapUsd: number | null;
  liveTrailPct: number;
  liveSpentTodayUsd: number;
  minFeeSol: number;
}

export interface DeskSnapshot {
  /** v13.5 wallet card. */
  wallet?: WalletView;
  mode: "paper" | "live";
  liveRequested: boolean;
  armError?: string;
  readiness: LiveReadiness;
  startedAt: number;
  now: number;
  startingBalanceUsd: number;
  cashUsd: number;
  equityUsd: number;
  sessionPnlUsd: number;
  sessionPnlPct: number;
  rules: ResolvedRules;
  prefs: DeskPrefs;
  /** Dollars a blank or oversized manual buy will actually use. min(equity × position %, cash), floored. */
  positionCapUsd: number;
  /** Hard-stop bans still running. Auto buys stay blocked. A manual buy can override. */
  cooldowns: MintCooldown[];
  feed: FeedStatus;
  pipeline: PipelineCounts;
  killReasons: Record<string, number>;
  positions: PositionView[];
  closed: ClosedTrade[];
  equity: EquityPoint[];
  events: FeedEvent[];
  /** Latest advisory lines. Display only. */
  advice: AdviceNote[];
  /** v12. Coins Dirk is watching. */
  watchlist: WatchItem[];
  /** v12. Market value of open positions. */
  exposureUsd: number;
  /** v12. Largest single confirmed manual buy right now: min(equity × 100%, cash, exposure room). */
  manualMaxUsd: number;
  /** v13.2 held-position price loop: cycle length and each source's last success / cool-off. */
  markLoop?: {
    pollMs: number;
    lastCycleAt: number | null;
    sources: Record<string, { lastOkAt: number | null; coolUntil: number; lastError: string | null; count429: number }>;
  };
  /** v12. Last crash the phone reported (POST /api/client-crash). */
  lastClientCrash: { at: number; version: string; brief: string } | null;
}

/** v13.2 WS "marks" message: position cards only, a few hundred bytes. */
export interface MarksDelta {
  now: number;
  cashUsd: number;
  equityUsd: number;
  positions: Array<{
    mint: string;
    markPrice: number;
    marketValueUsd: number;
    pnlUsd: number;
    pnlPct: number;
    stopPrice: number;
    peakPrice: number;
    trailArmed: boolean;
    trailHintPrice: number | null;
    markAgeMs: number;
    markAt: number;
    markFeed: string;
  }>;
}

export type DeskEvents = {
  /** v13.2 an open position got a new accepted or live mark. */
  "position.mark": { mint: string; at: number };
  /** v12. Something the UI shows changed outside the log (watchlist prices). */
  "desk.changed": { reason: string; at: number };
  "scout.candidate": CandidateToken;
  "market.tick": {
    mint: string;
    priceUsd: number;
    at: number;
    feed?: string;
    pairAddress?: string;
    dex?: string;
    liquidityUsd?: number;
  };
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
  /** Carried from a listing that already printed 1h volume. DexScreener's pair read still wins when it has a number. */
  volume1hUsd?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  /** Which listing printed priceUsd. Dex pair prices use dexscreener instead. */
  priceFeed?: "jupiter" | "gecko";
}

export type RugLookup =
  | { status: "clean"; evidence?: string }
  | { status: "unknown"; evidence?: string }
  | { status: "rugged"; evidence: string };

export interface RugRegistry {
  lookup(wallet?: string | null): Promise<RugLookup>;
}
