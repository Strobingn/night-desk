import type { SourceId } from "./market/net.js";
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
  | "LIVE_WALLET"
  /** Quote or simulation failed before a transaction was sent. */
  | "LIVE_NOT_SUBMITTED"
  /** A signature was sent, or the send itself timed out. Not a fill, and not safe to send again. */
  | "LIVE_UNCONFIRMED"
  /** Armed desk received a buy that did not name paper or live. */
  | "BOOK_REQUIRED"
  /** Explicit live buy while the checklist is off. Nothing was sent. */
  | "OPERATOR_NOT_READY"
  /** Trading engine exits. The engine's stop only ever sits tighter than the hard stop. */
  | "TAKE_PROFIT"
  | "STRATEGY_STOP"
  | "BREAKEVEN_STOP"
  | "TIME_LIMIT";

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
  priceFeed?: "dexscreener" | "jupiter" | "gecko" | "scout" | "replay" | "listing" | "chain";
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
  /** null = could not verify. A known active freeze is a hard rug and is not rechecked. */
  freezeAuthorityRevoked?: boolean | null;
  /**
   * null = could not verify.
   * Fail closed, except while `onBondingCurve` is true (no pool LP exists yet).
   * `false` is always a hard reject.
   */
  lpLockedOrBurned: boolean | null;
  /** Pump mint still on the bonding curve, with no AMM pool LP to lock. */
  onBondingCurve?: boolean;
  lpLockPct?: number | null;
  /** Pool the LP lock was judged on (primary by liquidity). Display only. */
  lpLockPool?: string | null;
  /** Fraction of supply, 0–1. null = could not verify. A share above 100% is stored as null. */
  top10HolderPct: number | null;
  holderCount: number | null;
  /** True when holderCount is the top-20 cap: the real count is at least that. */
  holderCountAtLeast?: boolean;
  /** Fraction of supply the dev wallet holds. null = not verified. */
  devHoldingPct?: number | null;
  /** True when devHoldingPct is an upper bound (dev was not in the top 20). */
  devHoldingUpperBound?: boolean;
  /** DexScreener pair addresses for this mint. Their vaults are not holders. */
  poolAddresses?: string[];
  /** Top accounts kept so a creator learned from RugCheck can still bound dev share. */
  holderSample?: {
    supplyUi: number | null;
    rows: Array<{ address?: string; owner?: string | null; uiAmount?: number | null; amount?: string; decimals?: number }>;
  };
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
/** v13.7 which book a position or order belongs to. */
export type BookKind = "paper" | "live";

/** v13.7 armed desk: real-money positions, separate from the paper book the AI trades. */
export interface LiveBookView {
  /** "manual" = only Dirk's buys go live (AI on paper). "all" = the AI buys live too. */
  scope: "manual" | "all";
  line: string;
  /** Last known wallet USDC. Zero until a read succeeds. Not a balance when cashKnown is false. */
  cashUsd: number;
  /** False when the latest read failed or has not happened. A stale last figure stays in cashUsd. */
  cashKnown?: boolean;
  /** Set when the latest read failed or has not happened. */
  balanceError?: string | null;
  equityUsd: number;
  startingUsd: number;
  pnlUsd: number;
  openPnlUsd: number;
  positions: PositionView[];
  tradeUsd: number;
  trailPct: number;
  dailyCapUsd: number | null;
}

export interface ExitOrder {
  /** v13.7 absent = the paper book. */
  book?: "live";
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
  priceFeed?: "dexscreener" | "jupiter" | "gecko" | "scout" | "replay" | "listing" | "chain";
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
  /** Slippage booked on the buy fill. Display only. */
  entrySlippage?: number;
  /** v13.5 live trail: highest accepted risk mark since entry. */
  markPeak?: number;
  /** Set when the trading engine opened the position: its signal, stop, target and time limit. */
  strategy?: import("./strategy/exits.js").StrategyMeta;
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
  /** v13.7 present only on live-book positions. */
  book?: "live";
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
  /** After-slippage proceeds minus cost. Null when the mark is missing or stale. */
  netPnlUsd?: number | null;
  netPnlPct?: number | null;
  /** Exit haircut from the same pool model a paper sell uses. */
  exitSlippage?: number | null;
  /** Buy-fill slippage, when the position recorded one. */
  entrySlippage?: number | null;
  /** Recent marks for the card sparkline. Only points taken while the coin was held. */
  marks?: MarkPoint[];
  /** v13.23 "Safe", "Blocked: …", or "Unknown". */
  safetyChip?: string;
  /** v13.23 "Bundled 24%" when the creation slot is flagged. */
  bundleChip?: string | null;
}

export interface MarkPoint {
  t: number;
  priceUsd: number;
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
export type FeedSourceState = "live" | "stale" | "backoff" | "down" | "blocked" | "off";

export interface FeedSourceStatus {
  id: SourceId;
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
  /**
   * v13.35 filter kills whose message was "could not be verified", by reason code.
   * A real miss (mint still active, LP actually unlocked) is not counted here.
   */
  unverifiedKills?: Record<string, number>;
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
  /** v13.7 null when not armed. */
  liveScope?: "manual" | "all" | null;
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
  /**
   * v13.32 set when a manual buy went through a gate the engine, analyst, filter,
   * score, watch list, or ban would have used. The buy already filled.
   */
  warning?: string;
}

export interface ManualBuyRefusal {
  ok: false;
  error: string;
  code: string;
  /** Set when a transaction was signed or may already be on the network. */
  signature?: string;
  /** not_submitted: safe to try a new swap. submitted_unknown: do not send another. rejected: the chain failed it. */
  submitState?: "not_submitted" | "submitted_unknown" | "rejected";
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
  /** v13.7 AI auto-buys go live too (default false). */
  liveAutoBuy?: boolean;
  /** v13.23 Helius Sender tip in SOL. Default 0.000005. Paper trades do not tip. */
  senderTipSol?: number;
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
  priceSource: "dexscreener" | "jupiter" | "chain";
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
  /** v13.23 "Safe", "Blocked: …", or "Unknown". */
  safetyChip?: string;
  /** v13.23 "Bundled 24%" when flagged. Null when the coin is not a flagged bundle. */
  bundleChip?: string | null;
  /** v13.6 set when a ticker/name resolved to this coin, e.g. "QTFALCN · held / traded". */
  matchedBy?: string;
  /** v13.17 DexScreener search failed, was rate limited, or the list is cached (up to 60s). */
  providerNote?: string;
}

/** v13.6 which limit set the buy cap, in words, for the one-tap hint. */
export interface CapWhy {
  capUsd: number;
  binding: "position" | "cash" | "exposure";
  pctCapUsd: number;
  cashUsd: number;
  exposureRoomUsd: number | null;
  maxExposurePct: number;
  exposureUsd: number;
  equityUsd: number;
  line: string;
}

/** v13.6 one row of a ticker/name pick list. */
export interface CoinCandidate {
  mint: string;
  symbol: string;
  name: string;
  mintShort: string;
  liquidityUsd: number | null;
  volume1hUsd: number | null;
  held: boolean;
  origin: "position" | "trade" | "tape" | "dexscreener";
  exact: boolean;
}

export interface CoinLookupError {
  ok: false;
  error: string;
  /** AMBIGUOUS (v13.6): several coins match a ticker/name; pick one from candidates. */
  code: "LOOKUP_FAILED" | "PRICE_UNAVAILABLE" | "AMBIGUOUS";
  platform?: string;
  mint?: string;
  query?: string;
  candidates?: CoinCandidate[];
  /** v13.17 DexScreener search failed, was rate limited, or the list is cached (up to 60s). */
  providerNote?: string;
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
  /** SOL/USD already cached on the desk. Null when no print has arrived. Display only. */
  solPriceUsd?: number | null;
  /** When that SOL/USD print was cached. Display only. */
  solPriceAt?: number | null;
  balanceAt: number | null;
  /** v13.33 milliseconds since the cached balance was read. Null when no read has landed. */
  balanceAgeMs?: number | null;
  /** v13.33 true when the figure is missing, failed, or older than the live-check cache window. */
  balanceStale?: boolean;
  balanceError: string | null;
  /** Desk is placing real swaps (LIVE_TRADING=true and a usable key at boot). */
  live: boolean;
  /** v13.7 "manual" = only Dirk's buys are live, the AI stays on paper. null = not armed. */
  liveScope?: "manual" | "all" | null;
  liveScopeLine?: string;
  liveAutoBuy?: boolean;
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
  /**
   * v13.33 monotonic id. A cached snapshot keeps the id it was built with.
   * Clients ignore a snapshot whose seq is not newer than the one they already applied,
   * so a 1s cache cannot roll a position mark backwards.
   */
  seq?: number;
  /** Trading engine: settings, what it is watching, and the shadow-book scorecard. */
  strategy?: import("./strategy/engine.js").ScorecardView;
  /** Timing per pipeline step, in ms. Measurement only. */
  perf?: Record<string, import("./strategy/latency.js").LatencySummary>;
  /** v13.7 armed desk: who trades live. `mode` stays "live" when armed (old apps then show LIVE). */
  liveScope?: "manual" | "all" | null;
  /** v13.7 the live book. Top-level cash/equity/positions are the paper book on an armed desk. */
  liveBook?: LiveBookView | null;
  /** v13.9 why the LIVE BUY / LIVE SELL buttons do nothing yet ("Live not armed: wallet key missing"). Null when armed. */
  liveNotArmed?: string | null;
  /** v13.10 live price / 5m & 1h volume / 1h change per Tape coin (killed ones too). Missing value = null + `why`. */
  tapeQuotes?: Record<string, import("./market/tape-quotes.js").TapeQuote>;
  /**
   * v13.27 raw sightings already on the Tape, newest first. Display only.
   * Not a buy candidate and not an event-log line.
   */
  rawTape?: import("./desk/raw-tape.js").RawTapeRow[];
  /** v13.11 limit / take-profit / stop orders, open first. */
  orders?: Array<import("./desk/orders.js").DeskOrder & { markUsd: number | null; distancePct: number | null; waiting: string | null; text: string }>;
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
  /** v13.6 which limit set positionCapUsd. */
  capWhy?: CapWhy;
  /** v13.2 held-position price loop: cycle length and each source's last success / cool-off. */
  markLoop?: {
    pollMs: number;
    lastCycleAt: number | null;
    sources: Record<string, { lastOkAt: number | null; coolUntil: number; lastError: string | null; count429: number }>;
    /** v13.8 websocket account stream on held pools. Null when the RPC has no ws endpoint. */
    stream?: { connected: boolean; subscriptions: number; wanted: number; updates: number; lastUpdateAt: number | null; reconnects: number; lastError: string | null } | null;
    /** v13.8 per held coin: the pool kind read on-chain, or why it cannot be. */
    chain?: Array<{ mint: string; symbol: string; pool: string | null; kind: string | null; reason: string | null }>;
  };
  /**
   * v13.28 enrich RPC. `host` is the hostname of SOLANA_RPC_URL only.
   * `callsPerMin` is enrich reads in the last minute. No URL and no key.
   */
  enrich?: { host: string | null; callsPerMin: number };
  /**
   * v13.29 soft-gate rechecks. `pending` is queued, `ran` finished, `dropped` was evicted
   * to keep the queue at 300. Rechecks share the enrich RPC budget and never use Helius.
   */
  recheck?: { pending: number; ran: number; dropped: number };
  /**
   * v13.34 cheap pre-filter. `kills` is by reason, before any RPC.
   * `rpcSaved` counts enrich reads and chain-mark calls that were not sent.
   * `heliusQueue` is the priority-0 Helius depth. `enrich` is enrichSighting latency.
   */
  prefilter?: {
    kills: Record<string, number>;
    rpcSaved: number;
    heliusQueue: number;
    enrich: { count: number; p50Ms: number; p90Ms: number; maxMs: number };
  };
  /** v13.24 installed release. The Home crash card compares a report to this. */
  appVersion?: string;
  /** v12. Last crash the phone reported (POST /api/client-crash). Kept after Dismiss. */
  lastClientCrash: { at: number; version: string; brief: string; text?: string; dismissed?: boolean } | null;
  /** v13.23 safety and bundle chips for coins that have been checked. */
  safetyChips?: Array<{ mint: string; safety: string; bundle?: string }>;
}

/** v13.2 WS "marks" message: position cards only, a few hundred bytes. */
export interface MarksDelta {
  now: number;
  cashUsd: number;
  equityUsd: number;
  /** v13.7 live book marks (armed desk only). */
  live?: { cashUsd: number; equityUsd: number; cashKnown?: boolean; balanceError?: string | null; positions: MarksDelta["positions"] };
  positions: Array<{
    book?: "live";
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
    netPnlUsd?: number | null;
    netPnlPct?: number | null;
    exitSlippage?: number | null;
    marks?: MarkPoint[];
    safetyChip?: string;
    bundleChip?: string | null;
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
  /** Market cap already printed by the listing. Display only. Enrichment does not read this. */
  marketCapUsd?: number;
  /** Pool or mint creation time from a free feed, unix ms. Absent when the payload did not say. */
  createdAt?: number;
  /** Age already printed by the feed. Absent when the payload did not say. */
  ageSeconds?: number;
}

export type RugLookup =
  | { status: "clean"; evidence?: string }
  | { status: "unknown"; evidence?: string }
  | { status: "rugged"; evidence: string };

export interface RugRegistry {
  lookup(wallet?: string | null): Promise<RugLookup>;
}
