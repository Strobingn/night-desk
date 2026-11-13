import { tinyPx } from "../price-text.js";
import { NetLimiter } from "../market/net.js";
import { LiveSubmitError, POOL_DRAINED_MESSAGE, isNoSellRouteMessage, offersSellAnyway } from "../market/live-submit.js";
import { DEAD_MARKS, deadFromMarks, markCollapsed, noteCollapsedSample, readSellRoute, type CollapseStreak } from "../market/dead-holding.js";
import { BANNER_AFTER_MS } from "../agents/feed-health.js";
import { fetchJupiterQuotes } from "../market/dex-prices.js";
import { fetchDexTape, TapeQuoter, TAPE_TICK_MS } from "../market/tape-quotes.js";
import { randomUUID } from "node:crypto";
import { assessPosition, entryAllowed } from "../agents/risk.js";
import { HARD_RULES, SCORE_BAND, clampAgeMinutes, clampBuyUsd, clampCooldownHours, clampDailyLossUsd, clampDevHoldingPct, clampEntrySlippage, clampExitSlippage, slippageFromWire, clampHolderCount, clampLiquidityUsd, clampOpenPositions, clampPnlAlertPct, clampPositionPct, clampExposurePct, clampPositionUsd, clampResetUsd, SIZING_BAND, clampScore, clampStopLossPct, clampTop10, clampTradesPerHour, clampTrailArmPct, clampTrailArmFraction, TRAIL_ARM_MAX, clampTrailGapPct, clampVolumeUsd, OPEN_POSITION_BAND, VOLUME_BOOST_BAND, clampVolumeBoost, POSITION_REFRESH_BAND, clampPositionRefreshMs, LIVE_BAND, clampLiveTradeUsd, clampLiveDailyCapUsd, liveTrailFromWire, pctText } from "../rules.js";
import { autoBuyBlock } from "./auto-gates.js";
import { STRATEGY } from "../strategy/config.js";
import { StrategyEngine, defaultSettings as defaultStrategySettings, patchSettings as patchStrategySettings, type EngineQuote, type FiredSignal, type ScorecardView } from "../strategy/engine.js";
import { assessStrategyExit, strategyLinePrice, type StrategyMeta } from "../strategy/exits.js";
import { BoundedMap, LatencyStats } from "../strategy/latency.js";
import { ShadowStore } from "../strategy/store.js";
import { classifyStopExit } from "./gap.js";
import { MomentumTracker } from "../market/momentum.js";
import { DEFAULT_SCOUT_SOURCES, type ScoutSources } from "../agents/scout.js";
import { evaluateFilter } from "../agents/filter.js";
import { scoreToken } from "../agents/analyst.js";
import { assertNonNegativeFinite, entryPriceAllowed, exitImpactAllowed, floorUsd, maxSizeForPool, planOrder, quotePaperBuy, quotePaperSell, realizablePnl, resolveManualSize, roundUsd, splitPosition } from "../agents/execution-math.js";
import { dexscreenerUrl, parseCoinInput, positionTag } from "../market/coin-input.js";
import { resolveCoinMint } from "../market/coin-lookup.js";
import { DexSearchClient, matchLocal, mergeTickerCandidates, rankDexSearch, tickerQuery, type LocalCoin, type TickerCandidate } from "../market/ticker-search.js";
import { EnrichDeferred, applyRugcheck, enrichSighting, isHeliusUrl, needsFilterRugcheck, type EnrichNote } from "../market/enrich.js";
import { KillMemory, type PrefilterThresholds } from "../market/prefilter.js";
import { RecheckQueue, recheckEligible, recheckToken } from "../market/recheck.js";
import { fetchDexQuotes } from "../market/dex-prices.js";
import { Scout } from "../agents/scout.js";
import { RawTape, draftFromRaw, rawCandidate } from "./raw-tape.js";
import { EventBus } from "../bus.js";
import type { MarksDelta } from "../types.js";
import type { DeskConfig } from "../config.js";
import { ReplayFeed } from "../demo/replay.js";
import { advise, AdvisorBook, noteEntry, noteKill, noteNearMissSurface, noteNearMissTaken, noteOutcome, notePass, type Advice, type FeatureSample, type WeakSurvivor } from "./advisor.js";
import { classifyNearMiss } from "./near-miss.js";
import { phraseAdvice } from "./commentary.js";
import { ABSURD_RISE, LOG_THROTTLE_MS, LIVE_FRESH_MS, QUOTE_CONFIRM_MS, QUOTE_SIDE_GONE_USD, REANCHOR_SILENT_MS, SHOCK_MOVE, absurdScale, entryAnchor, isJump, markUnusable, needsShockConfirm, outlierReason, quoteConfirms, quoteSideDrained, reanchorCandidate, residualExitUsd, residualMarkPrice, sameMarkSource, type MarkOrigin, type ReanchorCandidate } from "../market/mark-guard.js";

/** Shown when a sell would fill on a mark dozens of times entry that no other feed confirms. */
const UNVERIFIED_SELL = "Price unverified - sell refused, retry";

/** v13.39 card copy when the quote side is drained or Jupiter has no sell route. */
const LIQUIDITY_GONE_NOTE = "Liquidity gone, no sell route";

/** Paper gate refusal. Carries EXIT_IMPACT so the banner is not labeled LIVE_SWAP_FAILED. */
class GateError extends Error {
  constructor(
    message: string,
    readonly code: "EXIT_IMPACT" | "UNVERIFIED_SELL" | "NO_SELL_ROUTE"
  ) {
    super(message);
    this.name = "GateError";
  }
}
import { visibleEquity } from "./equity-series.js";
import { replaySaved, type ReplayResult } from "../strategy/replay.js";
import { feedOf, MarketRecorder, type RecordedQuote, type RecordedSignal, type RecorderStats } from "../market/recorder.js";
import { buildRecap, recapReport, resetAtFromEquity, resolveRecapSince, type RecapReport } from "./recap.js";
import { PositionPricer, type LiveOrigin } from "../market/position-pricer.js";
import { ChainMarkReader, WSOL_MINT as SOL_MINT_ADDR, pumpCurveAddress } from "../market/chain-marks.js";
import { ChainStream, wsUrlFor } from "../market/chain-stream.js";
import { MIN_FEE_SOL, fetchWalletBalances, inspectDeskWallet, isPublicRpc, type DeskWalletStatus, type WalletBalances } from "../market/wallet-status.js";
import { APP_VERSION, type ClientCrash } from "./crash-card.js";
import { usesPumpRoute } from "../market/pump-live.js";
import { bundleShare, isPumpCoin, pumpExcluded, slotActivity, type BundleResult, type SlotTransaction } from "../market/bundle.js";
import { decodeMintSafety, SAFETY_UNKNOWN, safeMintAccount, type MintAccountBytes, type MintSafety } from "../market/mint-safety.js";
import { tipLamports } from "../market/helius-sender.js";
import { bondingCurvePda, canonicalPumpPoolPda } from "../pump/sdk.js";
import type { LiveSwapResult } from "../market/live-broker.js";
import { LayeredRugRegistry, loadRugWalletMap, StaticRugRegistry } from "../market/rug-registry.js";
import { PumpCore } from "../pump/index.js";
import { solanaConnection } from "../pump/rpc.js";
import { DeskStore } from "../store/db.js";
import type {
  AnalystReport,
  CandidateToken,
  ClosedTrade,
  DeskEvents,
  DeskPrefs,
  DeskSnapshot,
  ExitOrder,
  FeedEvent,
  FeedStatus,
  AdviceNote,
  Fill,
  LiveReadiness,
  ManualBuyRefusal,
  ManualBuyResult,
  PipelineCounts,
  Position,
  CapWhy,
  PositionView,
  RawSighting,
  WatchItem,
  WalletView,
  CoinLookup,
  CoinLookupError,
  BookKind,
  LiveBookView
} from "../types.js";
import { PaperBook } from "./book.js";
import { ORDER_MARK_MAX_AGE_MS, ORDER_MAX_TRIES, ORDER_RETRY_MS, OrderList, PERMANENT_REFUSALS, crosses, describeOrder, distance, resolveOrder, type DeskOrder, type OrderInput } from "./orders.js";

/** v13.7 per-book state maps (cooldowns, opening, marks) key live positions with this prefix. */
const LIVE_KEY = "live:";
/** Pump and chain-priced holdings sell on their own venue. A Jupiter miss is not a drained pool. */
function sellsOnPump(pos: { dex?: string | null; priceFeed?: string | null }): boolean {
  const dex = (pos.dex ?? "").toLowerCase();
  return pos.priceFeed === "chain" || dex === "pump.fun" || dex.startsWith("pump.fun ");
}

function bookKey(kind: BookKind, mint: string): string {
  return kind === "live" ? `${LIVE_KEY}${mint}` : mint;
}

interface UnconfirmedLive {
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  signature: string | null;
  at: number;
  message: string;
  landed?: boolean;
}

function loadUnconfirmed(raw: unknown): Map<string, UnconfirmedLive> {
  const map = new Map<string, UnconfirmedLive>();
  if (!Array.isArray(raw)) return map;
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const item = row as Partial<UnconfirmedLive>;
    if ((item.side !== "buy" && item.side !== "sell") || typeof item.mint !== "string" || !item.mint) continue;
    map.set(`${item.side}:${item.mint}`, {
      mint: item.mint,
      symbol: typeof item.symbol === "string" ? item.symbol : item.mint.slice(0, 4),
      side: item.side,
      signature: typeof item.signature === "string" && item.signature ? item.signature : null,
      at: typeof item.at === "number" ? item.at : Date.now(),
      message: typeof item.message === "string" ? item.message : "Confirmation unknown.",
      landed: item.landed === true
    });
  }
  return map;
}

type SettingsPatch = {
  [K in keyof DeskSettings]?: unknown;
};

interface DeskSettings {
  minVolume1hUsd?: number;
  analystMinScore?: number;
  volumeBoost?: number;
  maxTop10Pct?: number;
  maxPositionPct?: number;
  defaultBuyUsd?: number | null;
  maxOpenPositions?: number;
  allowUnlockedLp?: boolean;
  maxEntrySlippage?: number;
  /** v13.2 Position price refresh, ms. */
  positionRefreshMs?: number;
  maxExitSlippage?: number | null;
  operatorReady?: boolean;
  minLiquidityUsd?: number;
  minTokenAgeMin?: number;
  maxTokenAgeMin?: number;
  minHolderCount?: number;
  maxDevHoldingPct?: number;
  maxTradesPerHour?: number;
  dailyMaxLossUsd?: number;
  cooldownHours?: number;
  /** v13.20 set once the stored 6h ban has been retired. Absent means "force off". */
  cooldownRetired?: boolean;
  stopLossPct?: number;
  trailTakeProfit?: boolean;
  trailArmPct?: number;
  trailGapPct?: number;
  autoBuy?: boolean;
  scoutDexscreener?: boolean;
  scoutGecko?: boolean;
  scoutJupiter?: boolean;
  scoutDexpaprika?: boolean;
  scoutBitquery?: boolean;
  scoutPumpApi?: boolean;
  scoutLaunchLab?: boolean;
  notifyNearMiss?: boolean;
  notifyFills?: boolean;
  notifyStops?: boolean;
  /** v13.7 AI auto-buys go live too. Default false: live = Dirk's manual buys only. */
  liveAutoBuy?: boolean;
  pnlAlertPct?: number;
  positionSizeUsd?: number | null;
  maxExposurePct?: number;
  paperResetUsd?: number;
  /** v13.5 live wallet (separate from every paper size). */
  liveTradeUsd?: number;
  liveDailyCapUsd?: number | null;
  liveTrailPct?: number;
  /** v13.23 Helius Sender tip in SOL. Default 0.000005. Paper trades do not use it. */
  senderTipSol?: number;
}

interface DeskSettingsView {
  positionRefreshMs: number;
  /** v13.3 null = entry cap + 3% (the v13.2 behavior). */
  maxExitSlippage: number | null;
  minVolume1hUsd: number;
  analystMinScore: number;
  volumeBoost: number;
  maxTop10Pct: number;
  maxPositionPct: number;
  stopLossPct: number;
  defaultBuyUsd: number | null;
  maxOpenPositions: number;
  allowUnlockedLp: boolean;
  maxEntrySlippage: number;
  minLiquidityUsd: number;
  minTokenAgeMin: number;
  maxTokenAgeMin: number;
  minHolderCount: number;
  maxDevHoldingPct: number;
  maxTradesPerHour: number;
  dailyMaxLossUsd: number;
  cooldownHours: number;
  trailTakeProfit: boolean;
  trailArmPct: number;
  trailGapPct: number;
  autoBuy: boolean;
  scoutDexscreener: boolean;
  scoutGecko: boolean;
  scoutJupiter: boolean;
  scoutDexpaprika: boolean;
  scoutBitquery: boolean;
  scoutPumpApi: boolean;
  scoutLaunchLab: boolean;
  notifyNearMiss: boolean;
  notifyFills: boolean;
  notifyStops: boolean;
  pnlAlertPct: number;
  positionSizeUsd: number | null;
  maxExposurePct: number;
  paperResetUsd: number;
  liveTradeUsd: number;
  liveDailyCapUsd: number | null;
  liveTrailPct: number;
  liveAutoBuy: boolean;
  senderTipSol: number;
}

/** Codes that make a manual buy ask for "Buy anyway" first. */
const HARD_KILL_CODES = new Set(["MINT_AUTHORITY_ACTIVE", "DEV_RUG_HISTORY"]);
/** A lookup older than this is refreshed before a buy uses its liquidity. */
const LOOKUP_TTL_MS = 10 * 60_000;
const WATCHLIST_MAX = 60;

/**
 * Legal handoffs (nothing else may open, size, or close a position):
 *
 *   scout.candidate → Filter
 *   filter.result pass → Analyst
 *   filter.result reject → Logger
 *   analyst.report trade → Executor buy
 *   operator manual buy → Executor buy (same cap, no add; skips Filter and Analyst)
 *   analyst.report reject → Logger
 *   market.tick → Risk (price only; cannot open a position)
 *   executor.fill buy → Risk watches the position
 *   risk.exit → Executor sell
 *   every stage result → Logger
 */

/** A live buy waits this long for Helius, then uses a recent cache or refuses. */
const LIVE_BALANCE_WAIT_MS = 4_000;
/** Manual and background mint reads. An engine entry uses ENGINE_SAFETY_MS instead. */
const MINT_SAFETY_MS = 2_500;
/** Engine token-safety (paper and live). One Helius read-lane slot is about 6s at 10/min, plus RPC latency. */
const ENGINE_SAFETY_MS = 8_000;
/** Engine live launch-bundle check. Two read-lane calls at 10/min, then fail closed. Manual buys stay on launchBundleSoon. */
const ENGINE_LIVE_BUNDLE_MS = 15_000;
/**
 * Most launch-slot transactions the bundle check reads one by one, in a single batched request.
 * Above this it reads the whole slot. Ten matches the smallest Helius plan's 10 requests a second,
 * in case each call in a batch is counted on its own.
 */
const BUNDLE_TX_BATCH_MAX = 10;

/** Why an engine live bundle check did not return a verdict. Timeout and RPC error are logged apart. */
interface BundleFailure {
  reason: "timeout" | "rpc";
}

function isBundleFailure(value: BundleResult | BundleFailure | null): value is BundleFailure {
  return value != null && "reason" in value && !("flagged" in value);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}
/** A cached balance older than this cannot authorize a live buy. An exit may use an older successful SOL figure. */
const LIVE_BALANCE_CACHE_MS = 60_000;
/**
 * A live sell of a position that filled inside this window. The buy already confirmed the
 * token amount and that the wallet could pay. A stale or failed balance read must not refuse it.
 */
const RECENT_LIVE_FILL_MS = 30_000;
/** How long that sell waits for a fresh wallet read before it sends the confirmed amount. */
const RECENT_FILL_BALANCE_MS = 750;

export class Desk {
  readonly bus = new EventBus<DeskEvents>();
  readonly book: PaperBook;
  readonly store: DeskStore;
  /** Pump core. Real SOL stays simulate-only until `pump.safety` is armed, and a restart clears that arm. */
  readonly pump: PumpCore;
  readonly config: DeskConfig;
  private readonly scout: Scout;
  /** v13.27 raw Tape rows. Not candidates, not positions, not marks. */
  private readonly rawTape: RawTape;
  private readonly replay: ReplayFeed;
  private readonly pricer: PositionPricer;
  /** v13.6 on-chain pool/curve reader on the desk's private RPC (SOLANA_RPC_URL), shared by held marks and curve pricing. */
  private readonly chain: ChainMarkReader | undefined;
  /** v13.8 websocket account stream on held pools. */
  private readonly stream: ChainStream | undefined;
  private readonly rugs: LayeredRugRegistry;
  private readonly advisor: AdvisorBook;
  private advice: AdviceNote[] = [];
  private weakSurvivor: WeakSurvivor | null = null;
  private markLiquidity = new Map<string, number>();
  /** Last scouted token per mint. Manual buy refuses a mint that is not here. */
  private readonly sightings = new Map<string, CandidateToken>();
  /** Mints with a buy in flight. Blocks a second add before the fill lands. */
  private readonly opening = new Set<string>();
  /** Checklist note only. Never copied into LIVE_TRADING. */
  private operatorReady = false;
  /** Blank manual buy uses the position cap when this is null. */
  private defaultBuyUsd: number | null = null;
  private maxOpenPositions: number = OPEN_POSITION_BAND.fallback;
  /** User chose this on. A lone unlocked LP may pass and be bought. Mint authority and rugs stay hard. */
  private allowUnlockedLp = true;
  private minLiquidityUsd = 0;
  private minTokenAgeMin = 0;
  private maxTokenAgeMin = 0;
  private minHolderCount = 0;
  private maxDevHoldingPct = 0;
  /** v13.29 one later enrich for coins that missed only soft gates. */
  private readonly rechecks = new RecheckQueue();
  /** v13.34 hard kills never return to enrich. Soft kills get one free-feed recheck. */
  private readonly killMemory = new KillMemory();
  /** Chain-mark RPCs not sent because the mint was neither held nor watched. */
  private chainRpcSaved = 0;
  /** Unheld curve reads collapse to one saved call per second, matching the batch. */
  private curveDropAt = 0;
  private recheckTimer: NodeJS.Timeout | null = null;
  private recheckBusy = false;
  private maxTradesPerHour = 0;
  private dailyMaxLossUsd = 0;
  private trailTakeProfit = false;
  private autoBuy = true;
  private scoutSources: ScoutSources = { ...DEFAULT_SCOUT_SOURCES };
  private notifyNearMiss = true;
  private notifyFills = true;
  private notifyStops = true;
  private pnlAlertPct = 0;
  /** v12 sizing. null = size from the % cap. */
  private positionSizeUsd: number | null = null;
  /** v12. 1 = no extra limit beyond cash (the v11 behavior). */
  private maxExposurePct: number = SIZING_BAND.exposureDefaultPct;
  private paperResetUsd: number = HARD_RULES.paperStartingUsd;
  /** Add-coin lookups by mint. Manual buys of these mints use the lookup's pool and platform tag. */
  private readonly lookups = new Map<string, { at: number; platform: string; token: CandidateToken; audit?: LookupAudit }>();
  /** Verified chain fields from a scout enrich or a lookup, so a later timeout can reuse them. */
  private readonly chainFacts = new Map<string, { at: number; ages: Partial<Record<ChainFactField, number>>; token: CandidateToken }>();
  private watchlist: WatchItem[] = [];
  /** v13.6 ticker search (own spacing, cache and 429 backoff). */
  private dexSearch: DexSearchClient | null = null;
  /** Display SOL/USD. Persisted so the wallet line survives a restart. Trading still requires a fresh print. */
  private solUsdCache: { value: number; at: number } | null = null;
  private solTimer: NodeJS.Timeout | null = null;
  /** Absurd post-fill marks already held once. The next agreeing print may stop. */
  private readonly absurdHeld = new Set<string>();
  /** Last sell refusal, so a manual close can show the gate text instead of a generic miss. */
  private readonly closeRefusals = new Map<string, { code: string; error: string }>();
  private readonly curveQueue = new Set<string>();
  private curveTimer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  /** v13.10 live price / volume / change for every Tape coin (killed ones too). Live feed only. */
  tape: TapeQuoter | null = null;
  private tapeTimer: NodeJS.Timeout | null = null;
  private lastClientCrash: ClientCrash | null = null;
  /** v13.11 limit / take-profit / stop orders (paper and live), saved in the desk store. */
  private orders = new OrderList();
  private orderTimer: NodeJS.Timeout | null = null;
  /** Trading engine: signals, shadow books, scorecard. It never places an order itself. */
  readonly strategy: StrategyEngine;
  private strategyTimer: NodeJS.Timeout | null = null;
  /** Last Tape quote time handed to the engine per mint, so one quote is not counted twice. */
  private strategyQuoteAt = new Map<string, number>();
  /** Price feed each watched coin is anchored to. A quote from another feed is not used. */
  private strategyFeed = new BoundedMap<string, string | undefined>(400);
  private strategyExitRetryAt = new Map<string, number>();
  /** Live engine buys in flight. They count against the engine's open limit before they fill. */
  private engineLivePending = new Set<string>();
  /** v13.44 what the live engine has done since the desk started, so the phone can say why it is not buying. */
  private liveEngine = {
    signals: 0,
    otherSignals: 0,
    buys: 0,
    lastSignalAt: null as number | null,
    lastBuyAt: null as number | null,
    lastSkip: null as { at: number; symbol: string; code: string; message: string } | null
  };
  /** Live engine buys run one after another, so each sees the spend and the result of the one before it. */
  private engineLiveQueue: Promise<void> = Promise.resolve();
  readonly latency = new LatencyStats();
  private candidateAt = new BoundedMap<string, number>(2_000);
  private watchAt = new BoundedMap<string, number>(400);
  private readonly firingOrders = new Set<string>();
  private readonly orderJobs = new Set<Promise<unknown>>();
  /** Marks restored from disk at boot are not fresh prices: an order never fires on them. */
  private bootAt = Date.now();
  private readonly bootMarks = new Map<string, number>();
  /** Supply (market cap ÷ price) from a coin's first priced sighting, for market-cap triggers. */
  private readonly supplyByMint = new Map<string, number>();
  private readonly lookupFetch: typeof fetch;
  private readonly depthFetch: typeof fetch | undefined;
  /** v12.1: one shared request budget for Scout, enrichment, held marks, Add coin and the watchlist. */
  readonly net = new NetLimiter();
  private readonly watchFetch: typeof fetch;
  private pricerFailingSince: number | null = null;
  private pricerError: string | null = null;
  private readonly lpUnlockedMints = new Set<string>();
  private readonly analystScores = new Map<string, number>();
  /** Near-miss cards still waiting on a one-tap buy. One card per mint until it is taken. */
  private readonly nearMissCards = new Map<string, Advice>();
  /** Mints already shown as a near miss that have not been entered yet. */
  private readonly surfacedNearMiss = new Set<string>();
  private readonly walletStatus: DeskWalletStatus;
  /** v13.5 live per-trade USD. Live auto-buys and one-tap buys use this, never a paper size. */
  private liveTradeUsd: number = LIVE_BAND.tradeUsd.fallback;
  /** v13.23 live Sender tip. Paper fills never read this. */
  private senderTipSol = 0.000005;
  private readonly mintAccounts?: (mint: string) => Promise<MintAccountBytes | null>;
  private readonly launchBundleFn?: (mint: string) => Promise<BundleResult | null>;
  private readonly safetyCache = new Map<string, { at: number; ttl: number; result: MintSafety }>();
  private readonly bundleCache = new Map<string, { at: number; forever: boolean; result: BundleResult }>();
  private readonly safetyInflight = new Map<string, { priority: -1 | 0 | 1 | 2; budgetMs: number; job: Promise<MintSafety>; abort: () => void }>();
  /** v13.5 live daily spend cap. null = off (the default). */
  private liveDailyCapUsd: number | null = null;
  /** v13.5 live trailing stop, fraction. Armed from entry. */
  private liveTrailPct: number = LIVE_BAND.trailPct.fallback;
  /**
   * v13.7 live book. Exists only when the desk is armed (LIVE_TRADING=true + a valid key). The paper
   * book (`this.book`) always keeps running the AI; live holds real-money positions only.
   */
  liveBook: PaperBook | null = null;
  /** Live orders ignore prices taken before this process armed. */
  private liveEnabledAt = 0;
  private liveStartingUsd = 0;
  private liveStartedAt = Date.now();
  /** v13.7 false (default): only Dirk's manual buys go live; the AI keeps buying on paper. */
  private liveAutoBuy = false;
  /** v13.33 bumped on every snapshot() so a cached copy stays older than the next build. */
  private snapshotSeq = 0;
  /** v13.5 last read-only wallet balance read. */
  private walletBalances: WalletBalances | null = null;
  private walletInflight: Promise<WalletBalances | null> | null = null;
  private walletTimer: NodeJS.Timeout | null = null;
  /** Display-only. A read-only quote found no pool. Never a sell and never a ledger write. */
  private noRoute = new Set<string>();
  /** Display-only count of collapsed marks. The chart series drops identical prints inside 2s. */
  private collapseStreak = new Map<string, CollapseStreak>();
  private routeProbeTimer: NodeJS.Timeout | null = null;
  private routeProbeBusy = false;
  private readonly walletReader: () => Promise<WalletBalances>;
  private readonly signatureStatus?: (signature: string) => Promise<"confirmed" | "failed" | "unknown">;
  /** A live swap that was submitted (or may have been) and is not a booked fill. Blocks another send. */
  private unconfirmedLive = new Map<string, UnconfirmedLive>();
  private readonly inflight = new Set<Promise<unknown>>();
  private cooldowns = new Map<string, number>();
  /** First >30% print inside 10s of entry, keyed by mint. The feed has to repeat it. */
  private shocks = new Map<string, { feed: string; price?: number }>();
  /** v13.2 calibrated on-chain marks. Display and stop confirmation only. */
  private liveMarks = new Map<string, { price: number; at: number; feed: string }>();
  /** Recent Dex and Jupiter prints. A chain mark and a large rise need the other feed, not a copy of themselves. */
  private quotePrints = new Map<string, { dex?: { price: number; at: number }; jup?: { price: number; at: number } }>();
  /** v13.2 a >30% live jump waiting for a second read. */
  private livePending = new Map<string, { price: number; at: number }>();
  private lastConfirmAt = new Map<string, number>();
  /** v13.2 feed that supplied the last accepted risk mark. */
  private riskFeed = new Map<string, string>();
  /** v13.2 a different feed proposing itself while the entry feed is silent. */
  private reanchors = new Map<string, ReanchorCandidate>();
  /** v13.2 one PRICE_SOURCE / PRICE_UNUSABLE line per mint per 5 minutes. */
  private logGate = new Map<string, number>();
  private positionRefreshMs: number = POSITION_REFRESH_BAND.fallback;
  /** v13.3 operator exit-impact tolerance; null keeps entry cap + 3%. */
  private maxExitSlippage: number | null = null;
  /**
   * v13.39: mint is still held, but the mid is not sellable value. Keyed by book+mint.
   * Cleared when quote-side liquidity or a sell route returns. Not a write-off.
   */
  private liquidityGone = new Map<string, { at: number; residualUsd: number; reason: string; anchorPrice: number }>();
  /** Latest quote-side USD from a Dex tick, used when a later NO_ROUTES has no quote on the request. */
  private lastQuoteUsd = new Map<string, number>();
  private startedAt = Date.now();
  /** When the live engine counters started: process start, or the last change of live variant. */
  private liveEngineSince = Date.now();
  /** Earliest instant the current paper book owns. Recaps never look past it. */
  private resetAt = 0;
  /** Bumped by a paper reset so a fill already in flight cannot reopen the book. */
  private bookEpoch = 0;
  private equityTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private commentTimer: NodeJS.Timeout | null = null;
  private lastNotes = new Set<string>();
  private lastEquityAt = 0;
  /** v13.41 live equity curve: last sample time and value. */
  private lastLiveEquityAt = 0;
  private lastLiveEquity: number | null = null;
  /** v13.41 saves quotes and signals for coins the engine follows, for later analysis. */
  readonly recorder: MarketRecorder;
  /** Last equity sample actually written. A bogus jump is not stored and does not move this. */
  private lastEquitySample: { equity: number; cash: number } | null = null;
  private pipeline: PipelineCounts = {
    scouted: 0,
    filteredPass: 0,
    filteredKill: 0,
    analystTrade: 0,
    analystReject: 0,
    fills: 0,
    riskExits: 0,
    executorSkips: 0,
    gapExits: 0
  };
  private killReasons: Record<string, number> = {};
  /** Filter kills that failed closed because a provider did not answer, by reason code. */
  private unverifiedKills: Record<string, number> = {};
  /** v13.3 recent marks and liquidity per mint for the pre-buy crash guard. */
  readonly momentum = new MomentumTracker();
  private feed: FeedStatus;

  constructor(
    config: DeskConfig,
    deps: {
      priceFetch?: typeof fetch;
      lookupFetch?: typeof fetch;
      chainFetch?: typeof fetch;
      walletBalances?: () => Promise<WalletBalances>;
      depthFetch?: typeof fetch;
      /** Tests inject this. Production reads signature status and does not send. */
      signatureStatus?: (signature: string) => Promise<"confirmed" | "failed" | "unknown">;
      /** Tests inject the mint account. Production reads it on the low-priority RPC lane. */
      mintAccounts?: (mint: string) => Promise<MintAccountBytes | null>;
      /** Tests inject the creation-slot result. Production reads it once per mint. */
      launchBundle?: (mint: string) => Promise<BundleResult | null>;
    } = {}
  ) {
    this.config = config;
    this.mintAccounts = deps.mintAccounts ?? (process.env.VITEST ? async () => safeMintAccount() : undefined);
    this.launchBundleFn = deps.launchBundle;
    // v13.8: re-read pool depth before a buy when the sighting has none. Live feeds only (tests inject).
    this.depthFetch = deps.depthFetch ?? (config.feedMode !== "replay" && !config.demoFeed && !deps.priceFetch ? deps.lookupFetch ?? this.net.fetchAt(0) : undefined);
    if (this.depthFetch) {
      const fetchImpl = this.depthFetch;
      this.tape = new TapeQuoter({
        dex: (mints) => fetchDexTape(mints, fetchImpl),
        curves: async (mints) => {
          const prices = new Map<string, number>();
          const missing = new Map<string, string>();
          const keep = mints.filter((mint) => this.chainMarkWanted(mint));
          for (const mint of mints) {
            if (!keep.includes(mint)) missing.set(mint, "not held or watched");
          }
          if (!keep.length) {
            if (this.chain && mints.length) this.chainRpcSaved += 1;
            return { prices, missing };
          }
          if (!this.chain) {
            for (const m of keep) missing.set(m, "on-chain reads are off");
            return { prices, missing };
          }
          const read = await this.chain.readCurves(keep);
          for (const [m, why] of read.missing) missing.set(m, why);
          if (read.quotes.size) {
            const sol = await this.solUsd();
            for (const q of read.quotes.values()) {
              const usd = sol ? q.native * sol : NaN;
              if (usd > 0 && Number.isFinite(usd)) prices.set(q.mint, usd);
              else missing.set(q.mint, "no SOL/USD price to convert the curve");
            }
          }
          return { prices, missing };
        },
        jupiter: async (mints) => {
          const out = new Map<string, number>();
          for (const [m, q] of await fetchJupiterQuotes(mints, fetchImpl)) if (q.priceUsd > 0) out.set(m, q.priceUsd);
          return out;
        }
      });
    }
    this.net.useEnrichRpc(config.rpcUrl, config.enrichCallsPerMin);
    this.lookupFetch = deps.lookupFetch ?? deps.priceFetch ?? this.net.fetchAt(-1);
    this.watchFetch = deps.lookupFetch ?? deps.priceFetch ?? this.net.fetchAt(1);
    this.store = new DeskStore(config.dbPath, config.jsonlPath, config.logPath);
    this.recorder = new MarketRecorder(this.store.db, config.marketRecordDays);
    const savedSol = this.store.readJson("solUsd") as { value?: unknown; at?: unknown } | null;
    if (savedSol && typeof savedSol.value === "number" && savedSol.value > 0 && Number.isFinite(savedSol.value) && typeof savedSol.at === "number") {
      this.solUsdCache = { value: savedSol.value, at: savedSol.at };
    }
    this.advisor = new AdvisorBook(config.advisorPath);
    const saved = this.readSettings();
    if (typeof saved.minVolume1hUsd === "number") {
      this.config.rules.minVolume1hUsd = clampVolumeUsd(saved.minVolume1hUsd);
    }
    if (typeof saved.analystMinScore === "number") {
      this.config.rules.analystMinScore = clampScore(saved.analystMinScore);
    }
    // v13.1: a saved boost wins; otherwise the default. Nothing is written until Dirk saves.
    this.config.rules.volumeBoost =
      typeof saved.volumeBoost === "number" ? clampVolumeBoost(saved.volumeBoost) : clampVolumeBoost(this.config.rules.volumeBoost ?? VOLUME_BOOST_BAND.default);
    if (typeof saved.maxTop10Pct === "number") {
      this.config.rules.maxTop10Pct = clampTop10(saved.maxTop10Pct);
    }
    if (typeof saved.maxPositionPct === "number") {
      this.config.rules.maxPositionPct = clampPositionPct(saved.maxPositionPct, this.config.rules.maxPositionPct, SIZING_BAND.autoMaxPct);
    }
    if (typeof saved.maxEntrySlippage === "number") {
      this.config.rules.maxEntrySlippage = clampEntrySlippage(saved.maxEntrySlippage);
    }
    if ("defaultBuyUsd" in saved) this.defaultBuyUsd = clampBuyUsd(saved.defaultBuyUsd ?? null);
    if (typeof saved.maxOpenPositions === "number") this.maxOpenPositions = clampOpenPositions(saved.maxOpenPositions);
    if (typeof saved.positionRefreshMs === "number") this.positionRefreshMs = clampPositionRefreshMs(saved.positionRefreshMs);
    if ("maxExitSlippage" in saved) {
      this.maxExitSlippage =
        typeof saved.maxExitSlippage === "number" ? clampExitSlippage(saved.maxExitSlippage, this.config.rules.maxEntrySlippage + HARD_RULES.exitImpactSlack) : null;
    }
    if (typeof saved.allowUnlockedLp === "boolean") this.allowUnlockedLp = saved.allowUnlockedLp;
    this.absorbGates(saved);
    this.operatorReady = saved.operatorReady === true;
    this.signatureStatus = deps.signatureStatus;
    this.walletStatus = inspectDeskWallet({ readEnvSecret: config.readWalletSecret, keypairPath: config.walletKeypairPath });
    const owner = this.walletStatus.walletPublicKey;
    this.walletReader =
      deps.walletBalances ??
      (async () =>
        owner
          ? fetchWalletBalances(this.net.fetchAt(-1), config.walletRpcUrl, owner)
          : { sol: null, usdc: null, at: Date.now(), error: "No wallet key loaded" });
    this.rugs = new LayeredRugRegistry(new StaticRugRegistry(loadRugWalletMap(config.rugWalletsFile)));
    // v13.7: the paper book (and the AI on it) always runs. An armed desk adds a separate live book,
    // saved under "book:live", that holds only real-money positions.
    const live = config.mode === "live";
    const restored = config.resetPaper ? null : this.store.loadBook();
    const starting = restored && restored.startingBalanceUsd > 0 ? restored.startingBalanceUsd : config.startingBalanceUsd;
    this.config.startingBalanceUsd = starting;
    this.book = new PaperBook(restored?.cashUsd ?? starting);
    if (live) {
      this.liveEnabledAt = Date.now();
      const liveSaved = this.store.loadBook("book:live");
      this.liveBook = new PaperBook(liveSaved?.cashUsd ?? 0);
      this.liveStartingUsd = liveSaved?.startingBalanceUsd ?? 0;
      this.liveStartedAt = liveSaved?.startedAt ?? Date.now();
      for (const pos of liveSaved?.positions ?? []) {
        pos.closing = false;
        pos.live = true;
        this.liveBook.positions.set(pos.mint, pos);
        this.liveBook.mark(pos.mint, pos.entryPrice);
      }
      for (const [mint, priceUsd] of liveSaved?.lastPrices ?? []) {
        const pos = this.liveBook.positions.get(mint);
        if (!pos || (pos.entryPrice > 0 && priceUsd / pos.entryPrice >= ABSURD_RISE)) continue;
        this.liveBook.mark(mint, priceUsd);
      }
      for (const [mint, points] of liveSaved?.markSeries ?? []) if (this.liveBook.positions.has(mint)) this.liveBook.restoreSeries(mint, points);
      for (const [mint, until] of liveSaved?.cooldowns ?? []) {
        if (this.config.rules.revengeCooldownMs > 0 && until > Date.now()) this.cooldowns.set(bookKey("live", mint), until);
      }
    }
    if (restored) {
      this.startedAt = restored.startedAt;
      for (const pos of restored.positions) {
        pos.closing = false;
        this.book.positions.set(pos.mint, pos);
        this.book.mark(pos.mint, pos.entryPrice);
      }
      for (const [mint, priceUsd] of restored.lastPrices ?? []) {
        const pos = this.book.positions.get(mint);
        if (pos && pos.entryPrice > 0 && priceUsd / pos.entryPrice >= ABSURD_RISE) continue;
        this.book.mark(mint, priceUsd);
      }
      for (const [mint, points] of restored.markSeries ?? []) {
        const pos = this.book.positions.get(mint);
        if (!pos) continue;
        const kept = pos.entryPrice > 0 ? points.filter((point) => !(point.priceUsd / pos.entryPrice >= ABSURD_RISE)) : points;
        this.book.restoreSeries(mint, kept);
      }
      for (const [mint, until] of restored.cooldowns) {
        if (this.config.rules.revengeCooldownMs > 0 && until > Date.now() && !mint.startsWith(LIVE_KEY)) this.cooldowns.set(mint, until);
      }
    }
    this.healAbsurdMarks();
    this.resetAt = this.ensureResetAt();
    this.watchlist = loadWatchlist(this.store.readJson("watchlist"));
    this.unconfirmedLive = loadUnconfirmed(this.store.readJson("liveUnconfirmed"));
    this.orders = new OrderList(this.store.readJson("orders"));
    const strategyBase = { ...defaultStrategySettings(), enabled: config.strategyEngine === true };
    const strategySaved = this.store.readJson("strategy");
    const strategyLoaded = strategySaved != null ? patchStrategySettings(strategyBase, strategySaved) : null;
    this.strategy = new StrategyEngine({
      store: new ShadowStore(this.store.db),
      settings: strategyLoaded?.ok ? strategyLoaded.settings : strategyBase,
      onError: (where, err) => console.error(`[strategy] ${where}`, err)
    });
    this.bootAt = Date.now();
    for (const [mint, at] of this.book.lastMarkAt) this.bootMarks.set(`paper:${mint}`, at);
    for (const [mint, at] of this.liveBook?.lastMarkAt ?? []) this.bootMarks.set(`live:${mint}`, at);
    const crash = this.store.readJson("lastClientCrash") as { at?: unknown; version?: unknown; brief?: unknown; text?: unknown; dismissed?: unknown } | null;
    if (crash && typeof crash.at === "number" && typeof crash.brief === "string") {
      const brief = crash.brief;
      this.lastClientCrash = {
        at: crash.at,
        version: typeof crash.version === "string" ? crash.version : "unknown",
        brief,
        text: typeof crash.text === "string" && crash.text.trim() ? crash.text : brief,
        dismissed: crash.dismissed === true
      };
    }
    this.rawTape = new RawTape({
      onFlush: () => this.bus.emit("desk.changed", { reason: "raw-tape", at: Date.now() })
    });
    this.scout = new Scout({
      bus: this.bus,
      feedMode: config.feedMode,
      demo: config.demoFeed,
      rpcUrl: config.rpcUrl,
      rugcheckUrl: config.rugcheckUrl,
      pumpWsUrl: config.pumpWsUrl,
      bitqueryKey: config.bitqueryKey,
      enrichConcurrency: config.enrichConcurrency,
      queueCap: config.enrichQueueCap,
      holderPagesMax: config.holderPagesMax,
      net: this.net,
      onTape: (row) => this.rawTape.observe(row),
      prefilter: () => this.prefilterThresholds(),
      killMemory: this.killMemory,
      laneBusy: () => {
        const lane = this.net.heliusQueue();
        const stats = this.net.stats().find((row) => row.id === "helius");
        return lane.priority0 > 0 || (stats != null && stats.budgetPerMin > 0 && stats.reqLastMin >= stats.budgetPerMin);
      },
      onPrefilterKill: (raw, reasons) => {
        const primary = reasons[0];
        this.log({
          stage: "filter",
          kind: "reject",
          mint: raw.mint,
          symbol: raw.symbol,
          code: primary?.code,
          message: `Prefilter killed ${raw.symbol || raw.mint.slice(0, 4)} before RPC. ${primary?.message ?? "Rejected."}`,
          detail: reasons.map((reason) => reason.code).join(", ")
        });
      },
      onStatus: (patch) => {
        this.feed = { ...this.feed, ...patch };
      },
      onLog: (message, code) => {
        this.log({ stage: "scout", kind: "info", code, message });
      }
    });
    this.scout.setSources(this.scoutSources);
    this.feed = { ...this.scout.status };
    this.replay = new ReplayFeed(this.scout);
    // v13.6: held-coin pool reads use the desk's own RPC (.env SOLANA_RPC_URL). The public
    // mainnet-beta RPC 429'd these every few seconds on Austin, so marks fell back to Jupiter.
    const chainRpc = config.walletRpcUrl || config.rpcUrl;
    const publicRpc = isPublicRpc(chainRpc);
    this.chain =
      deps.chainFetch || (config.feedMode !== "replay" && !config.demoFeed && !deps.priceFetch)
        ? new ChainMarkReader(chainRpc, deps.chainFetch ?? this.net.fetchAt(0), publicRpc ? 10_000 : POSITION_REFRESH_BAND.min)
        : undefined;
    // A websocket to the public endpoint spends the same IP budget as the wallet read. Poll only there.
    const wsUrl = this.chain && !deps.chainFetch && !publicRpc ? config.rpcWsUrl || wsUrlFor(chainRpc) : null;
    this.stream = wsUrl
      ? new ChainStream(wsUrl, (key, data, at) => {
          this.pricer.onStreamAccount(key, data, at);
          this.pump.onAccount(key, data);
        })
      : undefined;
    this.pump = new PumpCore({
      db: this.store.db,
      rpcUrl: config.walletRpcUrl || config.rpcUrl,
      stream: this.stream,
      connection: solanaConnection(config.walletRpcUrl || config.rpcUrl, this.net.fetchAt(1))
    });
    this.scout.setPumpFrameHook((text) => this.pump.onPumpFrame(text));
    this.pricer = new PositionPricer({
      heldMints: () => {
        const held = [
          ...new Set([...this.book.positions.values(), ...(this.liveBook?.positions.values() ?? [])].filter((pos) => pos.source !== "replay").map((pos) => pos.mint))
        ];
        this.pump.feed.setHeldMints(held);
        return held;
      },
      tick: (mint, priceUsd, quote) =>
        this.scout.tick(mint, priceUsd, {
          feed: quote?.feed,
          pairAddress: quote?.pairAddress,
          dex: quote?.dex,
          liquidityUsd: quote?.liquidityUsd,
          quoteUsd: quote?.quoteUsd
        }),
      fetchImpl: deps.priceFetch ?? this.net.fetchAt(0),
      pollMs: () => this.positionRefreshMs,
      pairFor: (mint) => this.liveBook?.positions.get(mint)?.pairAddress ?? this.book.positions.get(mint)?.pairAddress,
      // v13.6: a held pump.fun coin with no DexScreener pair yet is read from its bonding curve.
      fallbackPair: (mint) => (mint.endsWith("pump") ? pumpCurveAddress(mint) ?? undefined : undefined),
      live: (mint, priceUsd, origin) => this.liveMark(mint, priceUsd, origin),
      chain: this.chain,
      stream: this.stream,
      onStale: (mint, silentMs) => {
        const pos = this.book.positions.get(mint) ?? this.liveBook?.positions.get(mint);
        this.log({
          stage: "risk",
          kind: "info",
          mint,
          symbol: pos?.symbol,
          code: "PRICE_STALE",
          message: `Risk has had no price for ${pos?.symbol ?? mint.slice(0, 6)} in ${Math.round(silentMs / 60_000)} minutes. The hard stop cannot fire until a price returns.`
        });
      },
      onRecovered: (mint) => {
        const pos = this.book.positions.get(mint) ?? this.liveBook?.positions.get(mint);
        this.log({
          stage: "risk",
          kind: "info",
          mint,
          symbol: pos?.symbol,
          code: "PRICE_RECOVERED",
          message: `Risk is pricing ${pos?.symbol ?? mint.slice(0, 6)} again.`
        });
      },
      onError: (message) => {
        // v12.1: a single 429 on held marks is not a banner; 2+ minutes without one good poll is.
        this.pricerFailingSince ??= Date.now();
        this.pricerError = message;
      },
      onOk: () => {
        this.pricerFailingSince = null;
        this.pricerError = null;
      }
    });
    this.wire();
    if (restored) {
      for (const pos of this.book.positions.values()) {
        const px = this.book.price(pos.mint, pos.entryPrice);
        // A restored absurd mark is not a rug. The next prints have to agree before a stop.
        if (this.absurdUnverified(pos, px)) continue;
        this.review(pos.mint, px);
      }
    } else {
      this.persist();
    }
    if (this.liveBook) {
      for (const pos of [...this.liveBook.positions.values()]) {
        const px = this.liveBook.price(pos.mint, pos.entryPrice);
        if (this.absurdUnverified(pos, px)) continue;
        this.review(pos.mint, px, "live");
      }
    }
    this.log({
      stage: "logger",
      kind: "info",
      message:
        config.mode === "live"
          ? `Logger opened the paper book at ${money(this.book.cashUsd)} for the AI and a live book for real swaps. ${this.liveScopeLine()}`
          : `Logger opened the paper book at ${money(config.startingBalanceUsd)}. Live trading is disarmed.`,
      detail: config.armError
    });
    if (config.armError) {
      this.log({
        stage: "executor",
        kind: "reject",
        code: "LIVE_NOT_ARMED",
        message: config.armError
      });
    }
  }

  start(): void {
    if (this.config.demoFeed) this.replay.start();
    this.scout.start();
    if (this.config.feedMode !== "replay") {
      this.pricer.start();
      this.watchTimer = setInterval(() => void this.refreshWatchlist(), 20_000);
      if (this.tape) {
        const tape = this.tape;
        this.tapeTimer = setInterval(() => void tape.tick().catch(() => undefined), TAPE_TICK_MS);
        this.tapeTimer.unref?.();
      }
      setTimeout(() => void this.refreshWatchlist(), 3_000);
    }
    this.equityTimer = setInterval(() => this.markEquity(), 2_000);
    // v13.11 orders: every 2 s on the latest fresh price (held coins are also checked on every mark).
    this.orderTimer = setInterval(() => this.checkOrders(), 2_000);
    this.orderTimer.unref?.();
    this.strategyTimer = setInterval(() => this.strategyPass(), 2_000);
    this.strategyTimer.unref?.();
    this.pinOrderMints();
    // v13.5 read-only wallet balance for the card (and the live cash line). Never signs.
    if (this.walletStatus.walletPublicKey && this.config.feedMode !== "replay") {
      const walletEvery = isPublicRpc(this.config.walletRpcUrl) ? 60_000 : this.config.mode === "live" ? 20_000 : 60_000;
      this.walletTimer = setInterval(() => void this.refreshWallet(), walletEvery);
      setTimeout(() => void this.refreshWallet(), 2_000);
    }
    // One Jupiter wrapped-SOL price per minute when the held-mark loop has not already printed one.
    // Same keyless price API the pricer uses. No Helius call.
    if (this.config.feedMode !== "replay" && !this.config.demoFeed) {
      this.solTimer = setInterval(() => void this.refreshDisplaySol(), 60_000);
      setTimeout(() => void this.refreshDisplaySol(), 2_000);
    }
    this.commentTimer = setInterval(() => void this.commentOnce(), 60_000);
    setTimeout(() => void this.commentOnce(), 8_000);
    // Read-only sell quotes for the Dead section. One pass a minute. No swap is built or sent.
    if (this.config.feedMode !== "replay" && !this.config.demoFeed && this.config.jupiterQuoteUrl) {
      this.routeProbeTimer = setInterval(() => void this.probeSellRoutes(), 60_000);
      this.routeProbeTimer.unref?.();
    }
    this.heartbeat = setInterval(() => {
      const snap = this.snapshot();
      console.log(
        `[desk] ${snap.mode} equity ${money(snap.equityUsd)} cash ${money(snap.cashUsd)} open ${snap.positions.length} kills ${snap.pipeline.filteredKill} fills ${snap.pipeline.fills}`
      );
    }, 30_000);
    this.markEquity();
    console.log(
      `[desk] ${this.config.mode.toUpperCase()} feed=${this.config.feedMode} demo=${this.config.demoFeed} cap=${(this.config.rules.maxPositionPct * 100).toFixed(0)}% stop=-${pctText(this.config.rules.stopLossPct)} winners=manual`
    );
  }

  stop(): void {
    this.recorder.flush();
    this.replay.stop();
    this.scout.stop();
    this.rawTape.stop();
    this.pricer.stop();
    this.stream?.stop();
    if (this.equityTimer) clearInterval(this.equityTimer);
    if (this.commentTimer) clearInterval(this.commentTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.tapeTimer) clearInterval(this.tapeTimer);
    if (this.orderTimer) clearInterval(this.orderTimer);
    if (this.strategyTimer) clearInterval(this.strategyTimer);
    if (this.walletTimer) clearInterval(this.walletTimer);
    if (this.routeProbeTimer) clearInterval(this.routeProbeTimer);
    if (this.solTimer) clearInterval(this.solTimer);
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
    this.persist();
    this.advisor.save();
    this.store.close();
  }

  /** One DexScreener pass over open positions. Tests call this directly. Replay fixtures are not sent. */
  async repricePositions(): Promise<void> {
    await this.pricer.poll();
    await this.drain();
  }

  async submitCandidate(token: CandidateToken): Promise<void> {
    this.scout.publish(token);
    await this.drain();
  }

  /**
   * v13.27 put a raw sighting on the Tape immediately. No enrich, no quote, no buy.
   * The gate seeds one of these so the phone can show the unenriched marker.
   */
  noteRawSighting(raw: RawSighting): void {
    this.rawTape.observe(draftFromRaw(raw, "pending"));
    this.rawTape.flush();
  }

  /**
   * Drop the paper book back to the reset amount (default $100, settings $100–$10,000). Open positions are removed from the ledger
   * and no order is sent. The event log, advisor memory, and settings (including
   * the 1h volume floor) stay. Live mode is refused and LIVE_TRADING is not changed.
   */
  resetPaperBook(
    confirm: boolean,
    startingUsd?: number
  ): { ok: true; cashUsd: number; startingBalanceUsd: number; archive: string; archivePath: string | null } | { ok: false; error: string } {
    if (confirm !== true) return { ok: false, error: "Confirm the reset before the paper book is cleared." };
    if (startingUsd !== undefined && (typeof startingUsd !== "number" || !Number.isFinite(startingUsd) || startingUsd <= 0)) {
      return { ok: false, error: "startingUsd must be a positive dollar amount (100 to 10,000)." };
    }
    if (startingUsd !== undefined) {
      // v13.3: the new start is also the saved "Paper reset $" setting, so the next reset matches.
      this.paperResetUsd = clampResetUsd(startingUsd);
      this.store.writeJson("settings", { ...this.readSettings(), paperResetUsd: this.paperResetUsd });
    }
    const starting = clampResetUsd(this.paperResetUsd);
    // v13.3: archive the session before anything is cleared. Trades and equity rows are kept too.
    const archiveAt = Date.now();
    const archiveName = `session-${new Date(archiveAt).toISOString().replace(/[:]/g, "-").replace(/\..+$/, "")}`;
    const archivePath = this.store.archiveSession(archiveName, {
      archivedAt: archiveAt,
      sessionStart: this.resetAt,
      startingBalanceUsd: this.config.startingBalanceUsd,
      cashUsd: this.book.cashUsd,
      equityUsd: this.book.equity(),
      openPositions: [...this.book.positions.values()].map((pos) => ({
        mint: pos.mint,
        symbol: pos.symbol,
        qty: pos.qty,
        costUsd: pos.costUsd,
        entryPrice: pos.entryPrice,
        markUsd: this.book.price(pos.mint, pos.entryPrice),
        openedAt: pos.openedAt
      })),
      closed: this.store.closedSince(this.resetAt),
      equity: visibleEquity(this.store.equitySince(this.resetAt)),
      pipeline: this.pipelineView(),
      settings: this.readSettings(),
      nextStartingUsd: starting
    });
    this.bookEpoch += 1;
    this.config.startingBalanceUsd = starting;
    this.book.positions.clear();
    this.book.lastPrice.clear();
    for (const key of this.noRoute) if (!key.startsWith(LIVE_KEY)) this.noRoute.delete(key);
    for (const key of this.collapseStreak.keys()) if (!key.startsWith(LIVE_KEY)) this.collapseStreak.delete(key);
    this.book.cashUsd = starting;
    this.cooldowns.clear();
    this.shocks.clear();
    this.markLiquidity.clear();
    this.startedAt = Date.now();
    this.resetAt = this.startedAt;
    this.store.writeJson("resetAt", this.resetAt);
    for (const key of Object.keys(this.pipeline) as Array<keyof PipelineCounts>) {
      if (key === "unverifiedKills") continue;
      this.pipeline[key] = 0;
    }
    this.killReasons = {};
    this.unverifiedKills = {};
    this.weakSurvivor = null;
    this.persist();
    this.markEquity(true);
    this.log({
      stage: "system",
      kind: "info",
      message: `Paper book reset to ${money(starting)}. The previous session was archived as ${archiveName} (trades and equity history kept). Open positions dropped. The log, advisor memory, and volume floor stay. ${this.liveBook ? "The live book and its positions are untouched." : "Live trading is still off."}`
    });
    this.publishAdvice(this.buildAdvice());
    return { ok: true, cashUsd: this.book.cashUsd, startingBalanceUsd: starting, archive: archiveName, archivePath };
  }

  /**
   * Recap for the current book only. 12h, 24h, and 7d are clipped to the last
   * paper reset. `reset` is that instant. The body is the summary plus the last 50 closes.
   */
  /** Phone crash report. The stack lands in desk.log and the jsonl payload. */
  recordClientCrash(version: string, stack: string): void {
    const full = stack.slice(0, 20_000);
    const brief = full.replace(/\s+/g, " ").slice(0, 500);
    const label = version.trim().slice(0, 40) || "unknown";
    this.lastClientCrash = { at: Date.now(), version: label, brief, text: full, dismissed: false };
    this.store.writeJson("lastClientCrash", this.lastClientCrash);
    this.log(
      {
        stage: "system",
        kind: "info",
        code: "CLIENT_CRASH",
        message: `Android client crash ${label}: ${brief}`
      },
      { version: label, stack: full }
    );
    this.bus.emit("desk.changed", { reason: "client-crash", at: Date.now() });
  }

  /** Hide the Home card. The crash record stays in the store. */
  dismissClientCrash(): { ok: true } {
    if (this.lastClientCrash && !this.lastClientCrash.dismissed) {
      this.lastClientCrash = { ...this.lastClientCrash, dismissed: true };
      this.store.writeJson("lastClientCrash", this.lastClientCrash);
    }
    this.bus.emit("desk.changed", { reason: "crash-dismiss", at: Date.now() });
    return { ok: true };
  }

  recap(sinceArg?: string | null): RecapReport {
    const now = Date.now();
    const since = resolveRecapSince(sinceArg ?? "12h", this.resetAt, now);
    const snap = this.snapshot();
    return recapReport(
      buildRecap({
        since,
        until: now,
        events: this.store.eventsSince(since),
        equity: visibleEquity(this.store.equitySince(since)),
        closed: this.store.closedSince(since),
        open: snap.positions,
        startingBalanceUsd: snap.startingBalanceUsd
      })
    );
  }

  /**
   * Live 1h volume floor for new Filter checks. Clamped to $1,000–$500,000.
   * Boot default is $10,000 until this is called. Open positions and the hard stop are unchanged.
   */
  setMinVolume(raw: number): { ok: true; minVolume1hUsd: number } | { ok: false; error: string } {
    const updated = this.updateSettings({ minVolume1hUsd: raw });
    if (!updated.ok) return updated;
    return { ok: true, minVolume1hUsd: updated.settings.minVolume1hUsd };
  }

  /**
   * Saved desk adjustments. The −6% stop is not a field here and is not changed.
   * Unknown or non-finite numbers are refused and nothing is written.
   */
  updateSettings(patch: SettingsPatch): { ok: true; settings: DeskSettingsView } | { ok: false; error: string } {
    const next: DeskSettings = { ...this.readSettings() };
    if ("minVolume1hUsd" in patch) {
      const raw = Number(patch.minVolume1hUsd);
      if (!Number.isFinite(raw)) return { ok: false, error: "Volume floor must be a number of US dollars." };
      next.minVolume1hUsd = clampVolumeUsd(raw);
    }
    if ("analystMinScore" in patch) {
      const raw = Number(patch.analystMinScore);
      if (!Number.isFinite(raw) || raw < SCORE_BAND.min || raw > SCORE_BAND.max) {
        return { ok: false, error: "Trade line must be from 0.10 to 0.95." };
      }
      next.analystMinScore = Math.round(raw * 100) / 100;
    }
    if ("volumeBoost" in patch) {
      const raw = Number(patch.volumeBoost);
      if (!Number.isFinite(raw) || raw < 0 || raw > 100) return { ok: false, error: "Volume boost must be a percent from 0 to 100." };
      next.volumeBoost = clampVolumeBoost(raw);
    }
    if ("maxTop10Pct" in patch) {
      const raw = Number(patch.maxTop10Pct);
      if (!Number.isFinite(raw)) return { ok: false, error: "Top 10 cap must be a percent from 5 to 35." };
      next.maxTop10Pct = clampTop10(raw);
    }
    if ("maxPositionPct" in patch) {
      const raw = Number(patch.maxPositionPct);
      if (!Number.isFinite(raw) || raw <= 0) return { ok: false, error: `Position size must be a percent from 1 to ${SIZING_BAND.autoMaxPct * 100}.` };
      next.maxPositionPct = clampPositionPct(raw, HARD_RULES.maxPositionPct, SIZING_BAND.autoMaxPct);
    }
    if ("defaultBuyUsd" in patch) {
      const raw = patch.defaultBuyUsd;
      if (raw == null || raw === "") next.defaultBuyUsd = null;
      else {
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: "Default buy size must be a USD amount, or blank to use the cap." };
        next.defaultBuyUsd = clampBuyUsd(n);
      }
    }
    if ("maxOpenPositions" in patch) {
      const raw = Number(patch.maxOpenPositions);
      if (!Number.isFinite(raw)) return { ok: false, error: "Max open positions must be a whole number from 1 to 24." };
      next.maxOpenPositions = clampOpenPositions(raw);
    }
    if ("positionRefreshMs" in patch) {
      const raw = Number(patch.positionRefreshMs);
      if (!Number.isFinite(raw)) return { ok: false, error: `Position price refresh must be ${POSITION_REFRESH_BAND.min} to ${POSITION_REFRESH_BAND.max} ms.` };
      next.positionRefreshMs = clampPositionRefreshMs(raw);
    }
    if ("allowUnlockedLp" in patch) {
      if (typeof patch.allowUnlockedLp !== "boolean") return { ok: false, error: "Allow unlocked LP must be true or false." };
      next.allowUnlockedLp = patch.allowUnlockedLp;
    }
    if ("maxEntrySlippage" in patch) {
      if (patch.maxEntrySlippage == null || patch.maxEntrySlippage === "") {
        return { ok: false, error: "Entry slippage cap cannot be removed. Send a percent from 0.5 to 50." };
      }
      const raw = Number(patch.maxEntrySlippage);
      if (!Number.isFinite(raw) || raw <= 0 || raw > 50) return { ok: false, error: "Entry slippage cap must be a percent from 0.5 to 50." };
      // v13.3: the wire value is a percent (0.5–50); an old web build's fraction (≤ 0.03) still reads right.
      next.maxEntrySlippage = slippageFromWire(raw);
    }
    if ("maxExitSlippage" in patch) {
      if (patch.maxExitSlippage == null || patch.maxExitSlippage === "") {
        next.maxExitSlippage = null;
      } else {
        const raw = Number(patch.maxExitSlippage);
        if (!Number.isFinite(raw) || raw <= 0 || raw > 50) return { ok: false, error: "Exit slippage must be a percent from 0.5 to 50 (or blank for entry cap + 3%)." };
        next.maxExitSlippage = slippageFromWire(raw);
      }
    }
    const refused = this.assignGates(patch, next);
    if (refused) return refused;
    this.store.writeJson("settings", next);
    this.applySaved(next);
    const view = this.settingsView();
    this.log({
      stage: "system",
      kind: "info",
      message: `Settings saved. Volume ${money(view.minVolume1hUsd)}, trade line ${view.analystMinScore.toFixed(2)}, volume boost ${(view.volumeBoost * 100).toFixed(0)}%, top 10 ${(view.maxTop10Pct * 100).toFixed(0)}%, position ${(view.maxPositionPct * 100).toFixed(0)}%, entry slip ${(view.maxEntrySlippage * 100).toFixed(2)}%, exit slip ${view.maxExitSlippage == null ? "entry+3%" : `${(view.maxExitSlippage * 100).toFixed(2)}%`}, buy ${view.defaultBuyUsd == null ? "cap" : money(view.defaultBuyUsd)}, open ${view.maxOpenPositions}, unlocked LP ${view.allowUnlockedLp ? "allowed" : "blocked"}. ${this.config.rules.stopLossPct < HARD_RULES.stopLossPct - 1e-9 ? `Hard stop −${(this.config.rules.stopLossPct * 100).toFixed(1)}% (your setting, tighter than the −${(HARD_RULES.stopLossPct * 100).toFixed(0)}% default).` : `Hard stop stays −${(HARD_RULES.stopLossPct * 100).toFixed(0)}%.`}`
    });
    return { ok: true, settings: view };
  }

  /**
   * Operator paper/live close. Uses the same sell path as a risk exit.
   * Does not ban the mint and does not change filter rules.
   */
  async closePosition(
    mint: string,
    fraction = 1,
    bookArg?: BookKind,
    opts?: { sellAnyway?: boolean }
  ): Promise<
    | { ok: true; soldFraction?: number; proceedsUsd?: number; symbol?: string; pnlUsd?: number; pnlPct?: number; exitPrice?: number; exitCode?: string }
    | { ok: false; error: string; code?: string; allowSellAnyway?: boolean }
  > {
    // v13.7: a sell names its book. No book = the paper book, so an old client can never sell real coins by accident.
    const kind: BookKind = bookArg === "live" ? "live" : "paper";
    if (kind === "live" && !this.liveBook) return { ok: false, error: `No live position to sell. ${this.liveNotArmedMessage()}` };
    const book = this.bk(kind);
    this.closeRefusals.delete(bookKey(kind, mint));
    // Read before heal. healAbsurdMarks puts entry back on the card, and selling at that
    // entry would hide a poisoned mark instead of refusing it.
    const prior = book.lastPrice.get(mint);
    this.healAbsurdMarks();
    const pos = book.positions.get(mint);
    if (!pos) {
      const elsewhere = kind === "paper" && this.liveBook?.positions.has(mint);
      return { ok: false, error: elsewhere ? "No open position for that mint in the paper book. It is held live; sell it from the Live section." : "No open position for that mint." };
    }
    if (pos.closing) return { ok: false, error: "Close already in progress." };
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || !(fraction > 0) || fraction > 1) {
      return { ok: false, error: "Sell fraction must be 25%, 50% or 100% (a number above 0 and at most 1)." };
    }
    if ((prior != null && this.sellUnverified(pos, prior)) || this.sellUnverified(pos, book.price(mint, pos.entryPrice))) {
      return { ok: false, error: UNVERIFIED_SELL };
    }
    const mark = book.price(mint, pos.entryPrice);
    if (!(mark > 0)) return { ok: false, error: "No mark to close against." };
    if (fraction < 1 && kind === "live") return { ok: false, error: "Partial sells are paper-only. Use a full close for a live position." };
    if (fraction < 1) {
      const split = splitPosition(pos.qty, pos.costUsd, fraction);
      // A remainder worth under a cent is closed in full instead of leaving dust.
      if (split.ok && split.remainQty * mark >= 0.01) return this.partialSell(pos, mark, split, opts?.sellAnyway === true);
    }
    pos.closing = true;
    const order: ExitOrder = {
      mint: pos.mint,
      symbol: pos.symbol,
      qty: pos.qty,
      markPrice: mark,
      liquidityUsd: pos.liquidityUsd,
      pnlPct: pos.entryPrice > 0 ? (mark - pos.entryPrice) / pos.entryPrice : 0,
      score: pos.score,
      reason: {
        code: "MANUAL_CLOSE",
        message: "Manual close from the desk. Trail and hard stop were not the trigger."
      },
      ...(kind === "live" ? { book: "live" as const } : {}),
      ...(opts?.sellAnyway === true ? { sellAnyway: true } : {})
    };
    this.log({
      stage: "system",
      kind: "info",
      mint: pos.mint,
      symbol: pos.symbol,
      code: "MANUAL_CLOSE",
      message: `Manual ${kind === "live" ? "live " : ""}close requested for ${pos.symbol} at mark ${price(mark)}.`
    });
    this.bus.emit("risk.exit", order);
    await this.drain();
    if (book.positions.has(mint)) {
      const refused = this.closeRefusals.get(bookKey(kind, mint));
      this.closeRefusals.delete(bookKey(kind, mint));
      const error = refused?.error ?? `Close of ${pos.symbol} did not complete. Position is still open.`;
      return {
        ok: false,
        error,
        ...(refused ? { code: refused.code } : {}),
        ...(offersSellAnyway(error) ? { allowSellAnyway: true } : {})
      };
    }
    const closed = this.store.recentClosed(20).find((trade) => trade.id === pos.tradeId);
    return {
      ok: true,
      soldFraction: 1,
      symbol: pos.symbol,
      ...(closed
        ? { proceedsUsd: closed.proceedsUsd, pnlUsd: closed.pnlUsd, pnlPct: closed.pnlPct, exitPrice: closed.exitPrice, exitCode: closed.exitCode }
        : {})
    };
  }


  // ---------------------------------------------------------------- trading engine

  /** The engine's scorecard plus how many engine positions the main paper book holds right now. */
  private strategyCard(): ScorecardView {
    let mainOpen = 0;
    for (const pos of this.book.positions.values()) if (pos.strategy) mainOpen += 1;
    let liveOpen = 0;
    for (const pos of this.liveBook?.positions.values() ?? []) if (pos.strategy) liveOpen += 1;
    const card = this.strategy.scorecard();
    return {
      ...card,
      mainOpen,
      live: {
        open: liveOpen,
        tradeUsd: this.liveTradeUsd,
        targetNetUsd: this.liveEngineTarget(),
        blocked: card.liveVariant ? this.liveEngineBlock() : "No live variant chosen.",
        since: this.liveEngineSince,
        signals: this.liveEngine.signals,
        otherSignals: this.liveEngine.otherSignals,
        buys: this.liveEngine.buys,
        lastSignalAt: this.liveEngine.lastSignalAt,
        lastBuyAt: this.liveEngine.lastBuyAt,
        lastSkip: this.liveEngine.lastSkip,
        spentTodayUsd: roundUsd(this.liveSpentTodayUsd()),
        dailyCapUsd: this.liveDailyCapUsd
      },
      recording: this.recorder.stats()
    };
  }

  /** The live take-profit: the paper target scaled to the live trade size, so both aim for the same percent. */
  private liveEngineTarget(): number {
    const s = this.strategy.settings;
    return Math.max(0.05, roundUsd((s.targetNetUsd * this.liveTradeUsd) / s.tradeUsd));
  }

  /** Today's closed live result (UTC day). */
  private liveNetTodayUsd(): number {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    let net = 0;
    for (const trade of this.store.closedSince(start.getTime())) if (trade.mode === "live") net += trade.pnlUsd;
    return net;
  }

  /**
   * Why the engine would not send a live buy right now, or null when it would.
   * The wallet and daily cap are checked at the buy. The $10 paper-book pause is not an input.
   */
  private liveEngineBlock(): string | null {
    if (!this.strategy.settings.enabled) return "The trading engine is off.";
    if (!this.liveBook) return "The live wallet is not armed on this desk.";
    if (!this.operatorReady) return "The live checklist (operatorReady) is not marked.";
    const net = this.liveNetTodayUsd();
    if (net <= -STRATEGY.live.dailyMaxLossUsd + 1e-9) return `Live is ${money(net)} on the day, past the engine's $${STRATEGY.live.dailyMaxLossUsd.toFixed(0)} live pause. It resumes on the next UTC day.`;
    return null;
  }

  /** Coins the engine has a position in on either book. They stay quoted so trailing and fade exits have data. */
  private engineHeldMints(): string[] {
    const out: string[] = [];
    for (const pos of this.book.positions.values()) if (pos.strategy) out.push(pos.mint);
    for (const pos of this.liveBook?.positions.values() ?? []) if (pos.strategy) out.push(pos.mint);
    return out;
  }

  strategyView(): ScorecardView {
    return this.strategyCard();
  }

  /** Change the engine's switch, sizes or active variants. Saved, and applied to the next signal. */
  updateStrategy(patch: unknown): { ok: true; strategy: ScorecardView } | { ok: false; error: string } {
    const result = patchStrategySettings(this.strategy.settings, patch);
    if (!result.ok) return result;
    const was = this.strategy.settings.enabled;
    const wasLive = this.strategy.settings.liveVariant ?? null;
    this.strategy.settings = result.settings;
    this.store.writeJson("strategy", result.settings);
    if (wasLive !== (result.settings.liveVariant ?? null)) {
      // The counters describe the variant that is live now, so they start over with it.
      this.liveEngine = { signals: 0, otherSignals: 0, buys: 0, lastSignalAt: null, lastBuyAt: null, lastSkip: null };
      this.liveEngineSince = Date.now();
      const block = this.liveEngineBlock();
      this.log({
        stage: "system",
        kind: "info",
        code: "STRATEGY",
        message: result.settings.liveVariant
          ? `Engine LIVE on for ${result.settings.liveVariant}: real money, $${this.liveTradeUsd.toFixed(2)} a trade, take-profit at $${this.liveEngineTarget().toFixed(2)} net, ${result.settings.maxOpen} open at most.${block ? ` Not trading yet: ${block}` : ""}`
          : "Engine LIVE off. The engine trades paper only again. Open live positions keep their exits."
      });
    }
    if (was !== result.settings.enabled) {
      this.log({
        stage: "system",
        kind: "info",
        code: "STRATEGY",
        message: result.settings.enabled
          ? `Trading engine on. Coins that pass Filter and Analyst are watched for a Launch or Momentum signal. Paper only: $${result.settings.tradeUsd.toFixed(0)} a trade, ${result.settings.maxOpen} open at most, take-profit at $${result.settings.targetNetUsd.toFixed(2)} net.`
          : "Trading engine off. Analyst passes go straight to the Executor again."
      });
    }
    this.pinOrderMints();
    return { ok: true, strategy: this.strategyCard() };
  }

  /** Wipe the shadow books and their saved trades. The main paper book is not touched. */
  resetStrategy(confirm: boolean): { ok: true; strategy: ScorecardView } | { ok: false; error: string } {
    if (!confirm) return { ok: false, error: "Send confirm: true to wipe the scorecard." };
    this.strategy.reset();
    this.log({ stage: "system", kind: "info", code: "STRATEGY", message: "Scorecard reset. Every shadow book is back to its starting balance." });
    return { ok: true, strategy: this.strategyCard() };
  }

  private watchForSignal(report: AnalystReport): void {
    const token = report.token;
    const now = Date.now();
    if (this.book.positions.has(token.mint)) return;
    if (!this.strategy.watch(token, report.score, now)) return;
    this.strategyFeed.set(token.mint, token.priceFeed);
    this.watchAt.set(token.mint, now);
    this.pinOrderMints();
    this.log({
      stage: "analyst",
      kind: "info",
      mint: token.mint,
      symbol: token.symbol,
      code: "SIGNAL_WATCH",
      message: `Engine is watching ${token.symbol} for a Launch or Momentum signal (up to ${Math.round(STRATEGY.watch.maxWatchMs / 60_000)} min). No buy yet.`
    });
  }

  /**
   * Every 2 s: hand fresh Tape quotes for the engine's coins to the engine, run its time limits,
   * and re-check time limits on the main book's engine positions. Adds no network calls: the
   * quotes come from the Tape quoter's existing batched pass.
   */
  strategyPass(now = Date.now()): void {
    const pinned = [...new Set([...this.strategy.pinned(), ...this.engineHeldMints()])];
    this.strategy.keepFlows(pinned);
    for (const mint of pinned) {
      const q = this.tape?.get(mint);
      if (!q || q.priceUsd == null || !(q.priceUsd > 0) || !Number.isFinite(q.priceUsd)) continue;
      if (this.strategyQuoteAt.get(mint) === q.at) continue;
      this.strategyQuoteAt.set(mint, q.at);
      this.recorder.quote({
        t: q.at,
        mint,
        symbol: this.sightings.get(mint)?.symbol ?? "",
        priceUsd: q.priceUsd,
        liquidityUsd: q.liquidityUsd ?? this.markLiquidity.get(mint) ?? null,
        vol5mUsd: q.vol5mUsd,
        vol1hUsd: q.vol1hUsd,
        change1hPct: q.change1hPct,
        buys5m: q.buys5m ?? null,
        sells5m: q.sells5m ?? null,
        source: q.source ?? null,
        flowAt: q.flowAt ?? null
      });
      // A position is marked only by the feed that priced its entry, so a signal must come from that feed too.
      const anchor = this.strategyFeed.get(mint);
      const feed = feedOf(q.source) ?? undefined;
      if (anchor && feed && anchor !== feed) continue;
      this.strategyQuote(mint, { at: q.at, priceUsd: q.priceUsd, vol5mUsd: q.vol5mUsd, vol1hUsd: q.vol1hUsd, change1hPct: q.change1hPct, liquidityUsd: q.liquidityUsd ?? this.markLiquidity.get(mint) ?? null, buys5m: q.buys5m ?? null, sells5m: q.sells5m ?? null, flowAt: q.flowAt, ...(feed ? { feed } : {}) }, now);
    }
    this.strategy.tick(now);
    this.recorder.flush();
    this.recorder.tidy(now, pinned);
    if (this.strategyQuoteAt.size > pinned.length) {
      const keep = new Set(pinned);
      for (const mint of [...this.strategyQuoteAt.keys()]) if (!keep.has(mint)) this.strategyQuoteAt.delete(mint);
    }
    for (const pos of [...this.book.positions.values()]) {
      if (!pos.strategy || pos.closing) continue;
      const at = this.book.markedAt(pos.mint);
      const mark = this.book.lastPrice.get(pos.mint);
      if (at == null || mark == null || now - at > STRATEGY.watch.markFreshMs) continue;
      this.review(pos.mint, mark, "paper");
    }
    for (const pos of [...(this.liveBook?.positions.values() ?? [])]) {
      if (!pos.strategy || pos.closing) continue;
      const at = this.liveBook!.markedAt(pos.mint);
      const mark = this.liveBook!.lastPrice.get(pos.mint);
      if (at == null || mark == null || now - at > STRATEGY.watch.markFreshMs) continue;
      this.review(pos.mint, mark, "live");
    }
    // Keep the Tape quoter's pins in step with what the engine is watching or holding now.
    if (pinned.length || this.strategy.pinned().length) this.pinOrderMints();
  }

  /**
   * The engine's live buy: only for the one variant the operator set live, only on a signal that
   * variant trades. It goes through every live check a manual live buy does (checklist, live size,
   * daily cap, wallet, slippage), and stops for the day once live is past its loss pause.
   */
  private async strategyLiveBuy(fired: FiredSignal): Promise<void> {
    const meta = fired.liveMeta;
    if (!meta) return;
    const { token, score } = fired;
    // Results are written to the counters this attempt started under. A change of live variant swaps in new ones.
    const tally = this.liveEngine;
    tally.signals += 1;
    tally.lastSignalAt = Date.now();
    const skip = (message: string, code: "ENGINE_LIVE_PAUSED" | "ENGINE_LIVE_SKIP" | "LAUNCH_BUNDLE_UNVERIFIED" = "ENGINE_LIVE_SKIP") => {
      this.pipeline.executorSkips += 1;
      tally.lastSkip = { at: Date.now(), symbol: token.symbol, code, message };
      this.log({ stage: "executor", kind: "reject", mint: token.mint, symbol: token.symbol, code, message: `Engine live buy skipped ${token.symbol}. ${message}` });
    };
    const block = this.liveEngineBlock();
    if (block) return skip(block, "ENGINE_LIVE_PAUSED");
    const live = this.liveBook!;
    if (live.positions.has(token.mint) || this.engineLivePending.has(token.mint)) return skip("Already held on the live book.");
    // A buy still in flight holds a slot, so two signals in one pass cannot both take the last one.
    const held = [...live.positions.values()].filter((pos) => pos.strategy && !pos.closing && !this.engineLivePending.has(pos.mint)).length;
    const open = held + this.engineLivePending.size;
    if (open >= this.strategy.settings.maxOpen) return skip(`The engine already has ${open} live. It holds ${this.strategy.settings.maxOpen} at most.`);
    this.engineLivePending.add(token.mint);
    try {
      // The read-lane waits sit outside the one-buy lock. The next live buy can run its own checks
      // while this one is waiting on Helius. The lock below covers only the buy itself.
      const safety = await this.tokenSafety(token.mint, -1, true);
      if (safety.status !== "safe") return skip(`${safety.chip}.`);
      if (isPumpCoin(token)) {
        const bundle = await this.engineLiveBundle(token.mint, safety.supply);
        if (bundle == null) return skip("Launch bundle could not be verified.", "LAUNCH_BUNDLE_UNVERIFIED");
        if ("reason" in bundle) {
          const message = bundle.reason === "timeout" ? "Launch bundle timed out." : "Launch bundle RPC error.";
          return skip(message, "LAUNCH_BUNDLE_UNVERIFIED");
        }
        if (bundle.flagged) return skip(`${bundle.label ?? "Bundled"}.`);
      }
      const again = this.liveEngineBlock();
      if (again) return skip(again, "ENGINE_LIVE_PAUSED");
      await this.withLiveBuyLock(async () => {
        // Entry slippage and the crash guard run inside the buy, against this signal's mark.
        const result = await this.executeBuy(token, score, this.liveTradeUsd, "analyst", false, {
          tag: fired.signal.signal,
          book: "live",
          engineLive: true,
          strategy: { ...meta, targetNetUsd: this.liveEngineTarget() }
        });
        if (result.ok) {
          tally.buys += 1;
          tally.lastBuyAt = Date.now();
        } else {
          // The buy path refused (wallet, daily cap, slippage, route...). Keep its own words for the phone.
          tally.lastSkip = { at: Date.now(), symbol: token.symbol, code: result.code ?? "REFUSED", message: result.error };
        }
      });
    } catch (err) {
      tally.lastSkip = { at: Date.now(), symbol: token.symbol, code: "ERROR", message: err instanceof Error ? err.message : String(err) };
      throw err;
    } finally {
      this.engineLivePending.delete(token.mint);
    }
  }

  /** One live engine buy at a time, so the next one sees this buy's spend. Held only for the buy, not the reads before it. */
  private async withLiveBuyLock(run: () => Promise<void>): Promise<void> {
    const turn = this.engineLiveQueue;
    let done!: () => void;
    this.engineLiveQueue = new Promise<void>((resolve) => (done = resolve));
    try {
      await turn;
      await run();
    } finally {
      done();
    }
  }

  /** One quote for a coin the engine is watching or a shadow book holds. A fired signal becomes a paper buy. */
  strategyQuote(mint: string, quote: EngineQuote, now = Date.now()): void {
    const fired = this.strategy.onQuote(mint, quote, now);
    if (!fired) return;
    const watchedAt = this.watchAt.get(mint);
    if (watchedAt != null) this.latency.record("watchToSignal", now - watchedAt);
    this.recorder.signal({
      // The firing quote's own time, so a replay opens the trade on that quote and not the one after.
      t: quote.at,
      mint,
      symbol: fired.token.symbol,
      kind: fired.signal.signal,
      priceUsd: fired.signal.priceUsd,
      detail: {
        risePct: fired.signal.risePct,
        reason: fired.signal.reason,
        vol5mUsd: quote.vol5mUsd,
        vol1hUsd: quote.vol1hUsd,
        change1hPct: quote.change1hPct,
        // The depth the engine actually sized against: the quote's, else the watched coin's.
        liquidityUsd: fired.token.liquidityUsd,
        buys5m: quote.buys5m ?? null,
        sells5m: quote.sells5m ?? null,
        ageSeconds: fired.token.ageSeconds,
        score: fired.score,
        // The feed that priced the signal. The position is marked only by this feed, and so is its replay.
        feed: quote.feed ?? null,
        paperVariant: fired.meta.variant,
        liveVariant: fired.liveMeta?.variant ?? null
      }
    });
    this.log({
      stage: "analyst",
      kind: "pass",
      mint,
      symbol: fired.token.symbol,
      code: "SIGNAL",
      message: `Engine signal on ${fired.token.symbol}. ${fired.signal.reason}`,
      detail: fired.signal.signal
    });
    this.track(this.strategyBuys(fired));
  }

  /** Tests and tools: one engine quote, then wait for any buy it caused. */
  async submitStrategyQuote(mint: string, quote: EngineQuote, now = Date.now()): Promise<void> {
    this.strategyQuote(mint, quote, now);
    await this.drain();
  }

  /** The engine's paper buy. Its live buy, when a live variant is set, is strategyLiveBuy. */
  private async strategyBuy(fired: FiredSignal): Promise<void> {
    const { token, score, meta } = fired;
    const startedAt = Date.now();
    const skip = (code: import("../types.js").ReasonCode, message: string) => {
      this.pipeline.executorSkips += 1;
      this.log({ stage: "executor", kind: "reject", mint: token.mint, symbol: token.symbol, code, message: `Executor skipped ${token.symbol}. ${message}` });
    };
    const open = [...this.book.positions.values()].filter((pos) => pos.strategy && !pos.closing).length;
    if (open >= this.strategy.settings.maxOpen) {
      skip("MAX_OPEN_POSITIONS", `The engine already has ${open} open. It holds ${this.strategy.settings.maxOpen} at most.`);
      return;
    }
    const net = this.netTodayUsd();
    if (net <= -STRATEGY.dailyMaxLossUsd + 1e-9) {
      // Paper engine entries only. The live buy for this signal is strategyLiveBuy, which does not read this result.
      skip("DAILY_LOSS", `The paper book is ${money(net)} on the day, past the engine's $${STRATEGY.dailyMaxLossUsd.toFixed(0)} pause. It resumes on the next UTC day.`);
      return;
    }
    await this.buyIfSafe({ token, score, breakdown: [], decision: "trade" }, { sizeUsd: this.strategy.settings.tradeUsd, tag: fired.signal.signal, meta });
    if (this.book.positions.get(token.mint)?.strategy) this.latency.record("signalToFill", Date.now() - startedAt);
  }

  /** The paper buy and, when a live variant is set for this signal, the live buy. Neither waits on the other's outcome. */
  private async strategyBuys(fired: FiredSignal): Promise<void> {
    // A signal of the kind the live variant does not trade: counted, so "no live buys" can be told from "no signals".
    if (!fired.liveMeta && this.strategy.settings.liveVariant) this.liveEngine.otherSignals += 1;
    const live = fired.liveMeta ? this.strategyLiveBuy(fired).catch((err) => console.error("[strategy] live buy", err)) : null;
    await this.strategyBuy(fired);
    if (live) await live;
  }

  /** Today's paper result (UTC day): closed trades plus what the open positions are showing. */
  private netTodayUsd(): number {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    let net = 0;
    for (const trade of this.store.closedSince(start.getTime())) if (trade.mode === "paper") net += trade.pnlUsd;
    for (const pos of this.book.positions.values()) net += pos.qty * this.book.price(pos.mint, pos.entryPrice) - pos.costUsd;
    return net;
  }

  /** The engine's exits for a position it opened, on the paper or the live book. */
  private strategyExit(pos: Position, mark: number, kind: BookKind = "paper"): void {
    const meta = pos.strategy;
    if (!meta || pos.closing) return;
    const now = Date.now();
    const key = bookKey(kind, pos.mint);
    const retryAt = this.strategyExitRetryAt.get(key);
    if (retryAt != null && now < retryAt) return;
    const book = this.bk(kind);
    const markAt = book.markedAt(pos.mint) ?? 0;
    const liquidityUsd = this.markLiquidity.get(pos.mint) ?? pos.liquidityUsd;
    const net = realizablePnl({ markPrice: mark, qty: pos.qty, costUsd: pos.costUsd, liquidityUsd, markAt, now });
    const verdict = assessStrategyExit({
      entryPrice: pos.entryPrice,
      entryMark: pos.entryMark,
      openedAt: pos.openedAt,
      mark,
      markFresh: now - markAt <= STRATEGY.watch.markFreshMs,
      netPnlUsd: net?.netPnlUsd ?? null,
      now,
      meta,
      flow: this.strategy.flowFor(pos.mint)
    });
    if (verdict.armBreakeven || verdict.patch) {
      pos.strategy = { ...meta, ...(verdict.armBreakeven ? { breakevenArmed: true } : {}), ...(verdict.patch ?? {}) };
      this.persist();
    }
    if (verdict.action !== "exit" || !verdict.code) return;
    // A refused exit (thin pool, unverified mark) is retried, but not on every tick.
    this.strategyExitRetryAt.set(key, now + (verdict.code === "STRATEGY_STOP" || verdict.code === "ENGINE_TRAIL" || verdict.code === "LIQUIDITY_DROP" ? 15_000 : 60_000));
    pos.closing = true;
    this.bus.emit("risk.exit", {
      mint: pos.mint,
      symbol: pos.symbol,
      qty: pos.qty,
      markPrice: mark,
      liquidityUsd: pos.liquidityUsd,
      pnlPct: pos.entryPrice > 0 ? mark / pos.entryPrice - 1 : 0,
      score: pos.score,
      reason: { code: verdict.code, message: verdict.message },
      ...(kind === "live" ? { book: "live" as const } : {})
    });
  }

  // ---------------------------------------------------------------- v13.11 orders

  private saveOrders(): void {
    this.store.writeJson("orders", this.orders.toJSON());
    this.pinOrderMints();
  }

  /**
   * Limit-buy coins and coins the engine is watching stay quoted on the Tape quoter.
   * A pin is a quote slot. It does not disable Buy or hide Live, and a manual buy does not read it.
   */
  private pinOrderMints(): void {
    this.tape?.pin([...this.orders.open().filter((o) => o.side === "limit_buy").map((o) => o.mint), ...this.strategy.pinned(), ...this.engineHeldMints()]);
  }

  /**
   * The freshest real price an order may act on. Held coins: the book's confirmed mark (the one
   * the hard stop uses). Limit buys: that, or the Tape quote, whichever is newer. Never a mark
   * restored from disk, never one older than 30 s, never 0.
   */
  private orderMark(o: Pick<DeskOrder, "book" | "mint" | "side">, maxAgeMs = ORDER_MARK_MAX_AGE_MS, now = Date.now()): { price: number; at: number; source: string } | { stale: string } {
    const book = o.book === "live" ? this.liveBook : this.book;
    const cands: Array<{ price: number; at: number; source: string }> = [];
    if (book) {
      const at = book.markedAt(o.mint);
      const p = book.lastPrice.get(o.mint);
      if (at != null && p != null && p > 0 && Number.isFinite(p) && this.freshMark(o.book, o.mint, at)) cands.push({ price: p, at, source: "mark" });
    }
    if (o.side === "limit_buy") {
      const q = this.tape?.get(o.mint);
      if (q?.priceUsd != null && q.priceUsd > 0 && Number.isFinite(q.priceUsd)) cands.push({ price: q.priceUsd, at: q.at, source: q.source ?? "tape" });
      if (o.book === "live") {
        const at = this.book.markedAt(o.mint);
        const p = this.book.lastPrice.get(o.mint);
        if (at != null && p != null && p > 0 && this.freshMark("paper", o.mint, at)) cands.push({ price: p, at, source: "mark" });
      }
    }
    const best = cands.sort((a, b) => b.at - a.at)[0];
    if (!best) return { stale: "waiting: no price yet" };
    const age = now - best.at;
    if (age > maxAgeMs) return { stale: `waiting: price stale (${Math.round(age / 1000)}s old)` };
    return best;
  }

  /** A mark restored from disk at boot is not a fresh price. */
  private freshMark(book: "paper" | "live", mint: string, at: number): boolean {
    const restored = this.bootMarks.get(`${book}:${mint}`);
    return restored == null || at !== restored || at > this.bootAt;
  }

  /** v13.11 place a limit buy, take profit or stop. Checked against a fresh price; nothing fires at placement. */
  placeOrder(input: OrderInput): { ok: true; order: DeskOrder; text: string } | { ok: false; error: string } {
    const book = input.book === "live" ? "live" : "paper";
    const mint = typeof input.mint === "string" ? input.mint.trim() : "";
    if (!mint) return { ok: false, error: "Mint is required." };
    const side = input.side;
    const pbook = book === "live" ? this.liveBook : this.book;
    const pos = pbook?.positions.get(mint);
    const seen = this.sightings.get(mint) ?? this.lookups.get(mint)?.token;
    const symbol = pos?.symbol ?? seen?.symbol ?? mint.slice(0, 4);
    if (side === "limit_buy" && !seen && !pos) {
      return { ok: false, error: `${symbol} has not been scouted or looked up. Open it in Add coin first, then set the limit.` };
    }
    if (side === "limit_buy" && pos) {
      return { ok: false, error: `${symbol} is already open in the ${book} book (no averaging down). Set a stop or take profit on it instead.` };
    }
    // Placement accepts a price up to 2 minutes old; firing needs one under 30 s.
    let markNow: number | null = null;
    const m = this.orderMark({ book, mint, side: side === "limit_buy" ? "limit_buy" : "stop_sell" }, 120_000);
    if ("price" in m) markNow = m.price;
    else if (pos) {
      const shown = this.displayMark(pos, book);
      if (shown.price > 0 && Date.now() - shown.at <= 120_000) markNow = shown.price;
    } else if (seen && seen.priceUsd > 0 && side === "limit_buy" && book === "paper") {
      const at = this.book.markedAt(mint);
      if (at != null && Date.now() - at <= 120_000) markNow = seen.priceUsd;
    }
    const hardStopPrice = pos ? assessPosition(pos, pbook!.price(mint, pos.entryPrice), this.config.rules).stopPrice : null;
    const supply = this.supplyByMint.get(mint) ?? null;
    const made = resolveOrder(input, {
      symbol,
      mark: markNow,
      held: !!pos && !pos.closing,
      entryPrice: pos?.entryPrice ?? null,
      hardStopPrice,
      hardStopPct: this.config.rules.stopLossPct,
      supply,
      liveArmed: !!this.liveBook
    });
    if (!made.ok) {
      this.log({ stage: "system", kind: "reject", mint, symbol, code: "ORDER", message: `Order refused. ${made.error}` });
      return made;
    }
    if (made.order.book === "live" && made.order.side === "limit_buy" && made.order.sizeUsd == null) made.order.sizeUsd = this.liveTradeUsd;
    const added = this.orders.add(made.order);
    if (!added.ok) return added;
    this.saveOrders();
    const wait = made.order.book === "live" && !this.liveBook ? " · waiting: live not armed (never fills on paper)" : "";
    const stopNote = made.order.side === "stop_sell" ? " A stop is your trigger, not a guaranteed fill: fees, slippage, or a failed swap leave it retrying or failed." : "";
    const text = `${describeOrder(made.order)} placed${wait}.${stopNote}`;
    this.log({ stage: "system", kind: "info", mint, symbol, code: "ORDER", message: `Order: ${text}` });
    return { ok: true, order: made.order, text };
  }

  cancelOrder(id: string): { ok: true; order: DeskOrder } | { ok: false; error: string } {
    const o = this.orders.get(id);
    if (!o) return { ok: false, error: "No order with that id." };
    if (o.status !== "open") return { ok: false, error: o.status === "working" ? "That order is firing right now and can't be canceled." : `That order is already ${o.status}.` };
    this.orders.finish(o, "canceled", "Canceled by you.");
    this.saveOrders();
    this.log({ stage: "system", kind: "info", mint: o.mint, symbol: o.symbol, code: "ORDER", message: `Order canceled: ${describeOrder(o)}.` });
    return { ok: true, order: o };
  }

  /** v13.11 check open orders (all, or one mint) against fresh prices and fire the ones that crossed. */
  checkOrders(onlyMint?: string): void {
    const now = Date.now();
    let changed = false;
    for (const o of this.orders.open()) {
      if (onlyMint && o.mint !== onlyMint) continue;
      if (o.status !== "open" || this.firingOrders.has(o.id)) continue;
      if (o.book === "live" && !this.liveBook) {
        if (o.note !== "waiting: live not armed") {
          o.note = "waiting: live not armed";
          changed = true;
        }
        continue;
      }
      const book = this.bk(o.book);
      if (o.side !== "limit_buy") {
        const pos = book.positions.get(o.mint);
        if (!pos) {
          this.orders.finish(o, "canceled", "Position closed before this order fired.", now);
          changed = true;
          continue;
        }
        if (pos.closing) continue;
      } else if (book.positions.has(o.mint)) {
        this.orders.finish(o, "canceled", `Already holding ${o.symbol} in the ${o.book} book.`, now);
        changed = true;
        continue;
      }
      if (o.nextTryAt && now < o.nextTryAt) continue;
      const mark = this.orderMark(o, ORDER_MARK_MAX_AGE_MS, now);
      if (!("price" in mark)) {
        if (!o.note?.startsWith("Refused") && o.note !== mark.stale) {
          o.note = mark.stale;
          changed = true;
        }
        continue;
      }
      if (o.note?.startsWith("waiting:")) {
        delete o.note;
        changed = true;
      }
      if (o.book === "live" && mark.at < this.liveEnabledAt) {
        const note = "rechecked: waiting for a price taken after live was enabled";
        if (o.note !== note) {
          o.note = note;
          changed = true;
        }
        continue;
      }
      if (crosses(o, mark.price)) {
        // Not tracked with the pipeline jobs: the sell path drains those, and would wait on itself.
        const job = this.fireOrder(o, mark.price, mark.source).catch((err) => console.error("[desk] order failed", err));
        this.orderJobs.add(job);
        void job.finally(() => this.orderJobs.delete(job));
      }
    }
    if (changed) this.store.writeJson("orders", this.orders.toJSON());
  }

  private async fireOrder(o: DeskOrder, mark: number, source: string): Promise<void> {
    if (this.firingOrders.has(o.id)) return;
    this.firingOrders.add(o.id);
    if (o.book === "live" && !this.liveBook) {
      o.status = "open";
      o.note = "waiting: live not armed";
      o.updatedAt = Date.now();
      this.firingOrders.delete(o.id);
      this.saveOrders();
      return;
    }
    const now = Date.now();
    if (o.book === "live") {
      const held = o.side === "limit_buy" ? undefined : this.liveBook?.positions.get(o.mint);
      const recent = this.recentLiveFill(held);
      const read = await this.liveBalance(o.side === "limit_buy" ? "buy" : "exit", false, recent ? RECENT_FILL_BALANCE_MS : LIVE_BALANCE_WAIT_MS);
      if ((!read || read.error != null || read.sol == null) && !recent) {
        o.status = "open";
        o.note = `Refused: wallet balance not current${read?.error ? ` (${read.error})` : ""}. Nothing was sent.`;
        o.nextTryAt = now + ORDER_RETRY_MS;
        o.updatedAt = now;
        this.firingOrders.delete(o.id);
        this.saveOrders();
        return;
      }
    }
    o.status = "working";
    o.firedAt = now;
    o.firedMark = mark;
    o.tries += 1;
    o.updatedAt = now;
    this.saveOrders();
    this.log({ stage: "system", kind: "info", mint: o.mint, symbol: o.symbol, code: "ORDER", message: `Order triggered: ${describeOrder(o)}. Mark ${price(mark)} (${source}). Running the normal ${o.side === "limit_buy" ? "buy" : "sell"} checks.` });
    try {
      let ok = false;
      let error = "";
      let code = "";
      let fill: number | undefined;
      if (o.side === "limit_buy") {
        // The quote that fired it is the newest price: the buy checks run against it, not an older mark.
        const priced = this.bk(o.book);
        if (source !== "mark" && !priced.positions.has(o.mint)) {
          priced.mark(o.mint, mark);
          const seen = this.sightings.get(o.mint);
          if (seen) this.sightings.set(o.mint, { ...seen, priceUsd: mark });
        }
        const res = await this.manualBuy(o.mint, o.sizeUsd, { book: o.book });
        ok = res.ok;
        if (res.ok) fill = res.fillPriceUsd;
        else {
          error = res.error;
          code = res.code;
        }
      } else {
        const res = await this.closePosition(o.mint, o.fraction ?? 1, o.book);
        ok = res.ok;
        if (res.ok) fill = res.exitPrice;
        else error = res.error;
      }
      const at = Date.now();
      if (ok) {
        o.fillPrice = fill;
        this.orders.finish(o, "filled", `Filled${fill ? ` at ${price(fill)}` : ""} (trigger ${price(o.triggerPrice)}, mark ${price(mark)}).`, at);
      } else if (o.side !== "limit_buy" && !this.bk(o.book).positions.has(o.mint)) {
        this.orders.finish(o, "canceled", "Position closed before this order fired.", at);
      } else if (PERMANENT_REFUSALS.has(code) || o.tries >= ORDER_MAX_TRIES) {
        this.orders.finish(o, "failed", `Refused: ${error}${code === "HARD_KILL" ? "" : ` (${o.tries} tries)`}`, at);
      } else {
        o.status = "open";
        o.nextTryAt = at + ORDER_RETRY_MS;
        o.note = `Refused at ${price(mark)}: ${error} Retrying in ${Math.round(ORDER_RETRY_MS / 1000)}s (try ${o.tries} of ${ORDER_MAX_TRIES}).`;
        o.updatedAt = at;
      }
      this.log({
        stage: "system",
        kind: ok ? "info" : "reject",
        mint: o.mint,
        symbol: o.symbol,
        code: "ORDER",
        message: `Order ${o.status}: ${describeOrder(o)}. ${o.note ?? ""}`.trim()
      });
    } catch (err) {
      o.status = "open";
      o.nextTryAt = Date.now() + ORDER_RETRY_MS;
      o.note = `Refused: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.firingOrders.delete(o.id);
      this.saveOrders();
    }
  }

  /** Open orders for GET /api/orders. Does not build the rest of the snapshot. */
  ordersBody(): { ok: true; orders: NonNullable<DeskSnapshot["orders"]> } {
    return { ok: true, orders: this.orderViews() };
  }

  /** Saved settings for GET /api/settings. Does not build the snapshot or read the SPA. */
  settingsBody(): { ok: true; settings: DeskSettingsView } {
    return { ok: true, settings: this.settingsView() };
  }

  /** Tests: wait for orders that are firing. */
  async ordersSettled(): Promise<void> {
    while (this.orderJobs.size) await Promise.all([...this.orderJobs]);
  }

  /** Open orders first, then the last finished ones, with the live distance to the trigger. */
  private orderViews(): NonNullable<DeskSnapshot["orders"]> {
    const now = Date.now();
    const rank = (o: DeskOrder) => (o.status === "open" || o.status === "working" ? 0 : 1);
    return [...this.orders.all()]
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
      .map((o) => {
        const m = o.status === "open" || o.status === "working" ? this.orderMark(o, 120_000, now) : null;
        const markUsd = m && "price" in m ? m.price : null;
        const waiting = o.status === "open" ? (o.book === "live" && !this.liveBook ? "waiting: live not armed" : o.note?.startsWith("waiting:") ? o.note : null) : null;
        return { ...o, markUsd, distancePct: distance(o, markUsd), waiting, text: describeOrder(o) };
      });
  }

  /** v13.3 Sell all: closes every open position at its current mark, one after another. */
  async closeAllPositions(bookArg?: BookKind): Promise<{
    ok: true;
    sold: Array<{ mint: string; symbol: string; proceedsUsd?: number; pnlUsd?: number }>;
    failed: Array<{ mint: string; symbol: string; error: string }>;
    pnlUsd: number;
  }> {
    const sold: Array<{ mint: string; symbol: string; proceedsUsd?: number; pnlUsd?: number }> = [];
    const failed: Array<{ mint: string; symbol: string; error: string }> = [];
    const kind: BookKind = bookArg === "live" ? "live" : "paper";
    const book = kind === "live" ? this.liveBook : this.book;
    for (const pos of [...(book?.positions.values() ?? [])]) {
      const result = await this.closePosition(pos.mint, 1, kind);
      if (result.ok) sold.push({ mint: pos.mint, symbol: pos.symbol, proceedsUsd: result.proceedsUsd, pnlUsd: result.pnlUsd });
      else failed.push({ mint: pos.mint, symbol: pos.symbol, error: result.error });
    }
    const pnlUsd = roundUsd(sold.reduce((sum, row) => sum + (row.pnlUsd ?? 0), 0));
    this.log({
      stage: "system",
      kind: "info",
      code: "MANUAL_CLOSE",
      message: `Sell all${kind === "live" ? " (live)" : ""}: closed ${sold.length} position${sold.length === 1 ? "" : "s"}${failed.length ? `, ${failed.length} could not close` : ""}. Realized ${signed(pnlUsd)}.`
    });
    return { ok: true, sold, failed, pnlUsd };
  }

  /** Paper partial sell. Sells part of the qty into the same pool model a full exit uses. */
  private partialSell(
    pos: Position,
    mark: number,
    split: { sellQty: number; soldCostUsd: number; remainQty: number; remainCostUsd: number; fraction: number },
    sellAnyway = false
  ): { ok: true; soldFraction: number; proceedsUsd: number } | { ok: false; error: string; code?: string; allowSellAnyway?: boolean } {
    if (this.sellUnverified(pos, mark)) return { ok: false, error: UNVERIFIED_SELL, code: "UNVERIFIED_SELL" };
    const liquidity = this.markLiquidity.get(pos.mint) ?? pos.liquidityUsd;
    const impact = this.paperExitImpact(pos, mark, split.sellQty, liquidity, true, sellAnyway);
    if (impact) return this.sellRefusal(impact);
    const quote = quotePaperSell(mark, split.sellQty, liquidity);
    const proceedsUsd = roundUsd(quote.proceedsUsd ?? 0);
    assertNonNegativeFinite("proceedsUsd", proceedsUsd);
    if (this.paperProceedsUnverified(pos, proceedsUsd, quote.fillPrice, split.soldCostUsd)) return { ok: false, error: UNVERIFIED_SELL };
    const now = Date.now();
    const id = randomUUID();
    const pnlUsd = roundUsd(proceedsUsd - split.soldCostUsd);
    this.book.cashUsd = roundUsd(this.book.cashUsd + proceedsUsd);
    pos.qty = split.remainQty;
    pos.costUsd = split.remainCostUsd;
    this.store.openTrade({ id, mint: pos.mint, symbol: pos.symbol, openedAt: pos.openedAt, costUsd: split.soldCostUsd, score: pos.score, mode: "paper" });
    this.store.closeTrade({
      id,
      mint: pos.mint,
      symbol: pos.symbol,
      openedAt: pos.openedAt,
      closedAt: now,
      costUsd: split.soldCostUsd,
      proceedsUsd,
      pnlUsd,
      pnlPct: split.soldCostUsd > 0 ? pnlUsd / split.soldCostUsd : 0,
      exitCode: "PARTIAL_SELL",
      score: pos.score,
      mode: "paper",
      entryPrice: pos.entryPrice,
      exitPrice: quote.fillPrice
    });
    this.pipeline.fills += 1;
    const pct = Math.round(split.fraction * 100);
    this.log(
      {
        stage: "executor",
        kind: "fill",
        mint: pos.mint,
        symbol: pos.symbol,
        code: "PARTIAL_SELL",
        message: `Executor sold ${pct}% of ${pos.symbol} for ${money(proceedsUsd)} @ ${price(quote.fillPrice)} (paper). Realized ${signed(pnlUsd)}. ${money(split.remainCostUsd)} cost basis still open.`,
        detail: money(proceedsUsd)
      },
      { fraction: split.fraction, qty: split.sellQty, proceedsUsd, pnlUsd }
    );
    this.persist();
    this.markEquity(true);
    this.publishAdvice(this.buildAdvice());
    return { ok: true, soldFraction: split.fraction, proceedsUsd };
  }

  /**
   * v13.8 a sighting with a price but no readable pool depth (DexScreener lists a pump.fun /
   * Meteora DBC bonding-curve pair with no liquidity) cannot be sized against the exit check.
   * Re-read depth: DexScreener's deepest pair, the pump.fun curve on-chain, then Jupiter.
   * Price and depth always come from the same source. Nothing found = token unchanged + reason.
   */
  private async ensureDepth(token: CandidateToken): Promise<{ token: CandidateToken; tried: string[] }> {
    if (token.liquidityUsd > 0 && Number.isFinite(token.liquidityUsd)) return { token, tried: [] };
    const tried: string[] = [];
    const fetchImpl = this.depthFetch;
    if (!fetchImpl) return { token, tried: ["no depth reads in this mode"] };
    try {
      const q = (await fetchDexQuotes([token.mint], fetchImpl)).get(token.mint);
      if (q && q.liquidityUsd > 0 && q.priceUsd > 0) {
        const next: CandidateToken = { ...token, priceUsd: q.priceUsd, liquidityUsd: q.liquidityUsd, priceFeed: "dexscreener", pairAddress: q.pairAddress ?? token.pairAddress, dex: q.dex ?? token.dex };
        this.remember(next);
        return { token: next, tried };
      }
      tried.push("DexScreener lists no pair with liquidity");
    } catch {
      tried.push("DexScreener did not answer");
    }
    if (token.mint.endsWith("pump")) {
      const curve = await takeFirst(this.curvePrice(token.mint), LOOKUP_CURVE_MS, {
        ok: false as const,
        reason: "the RPC did not answer inside the buy budget"
      });
      if (curve.ok) {
        const next: CandidateToken = { ...token, priceUsd: curve.priceUsd, liquidityUsd: curve.liquidityUsd, priceFeed: "chain", pairAddress: curve.curve, dex: "pump.fun curve" };
        this.remember(next);
        return { token: next, tried };
      }
      tried.push(`pump.fun curve: ${curve.reason}`);
    }
    const jup = await takeFirst(jupiterLookupQuote(token.mint, token.priceUsd, fetchImpl), LOOKUP_PRICE_MS, { ok: false as const });
    if (jup.ok) {
      const next: CandidateToken = { ...token, priceUsd: jup.priceUsd, liquidityUsd: jup.liquidityUsd, priceFeed: "jupiter" };
      return { token: next, tried };
    }
    tried.push(jup.error ? `Jupiter: ${jup.error}` : "Jupiter has no liquidity for it");
    return { token, tried };
  }

  /**
   * v13.6 price a coin from its pump.fun bonding curve on-chain (exact SOL reserves × a fresh
   * SOL/USD). Null + reason when there is no readable, live curve or no fresh SOL/USD.
   */
  async curvePrice(mint: string): Promise<{ ok: true; priceUsd: number; liquidityUsd: number; curve: string } | { ok: false; reason: string }> {
    if (!this.chain) return { ok: false, reason: "on-chain reads are off in this mode" };
    let read: Awaited<ReturnType<ChainMarkReader["readCurves"]>>;
    try {
      read = await this.chain.readCurves([mint]);
    } catch (err) {
      return { ok: false, reason: `the RPC read failed (${err instanceof Error ? err.message : String(err)})` };
    }
    const q = read.quotes.get(mint);
    if (!q) return { ok: false, reason: read.missing.get(mint) ?? "no pump.fun bonding curve on-chain for it" };
    const sol = await this.solUsd();
    if (!sol) return { ok: false, reason: "no fresh SOL/USD price to convert the curve price" };
    const priceUsd = q.native * sol;
    const liquidityUsd = 2 * q.virtualSol * sol;
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd) || !(liquidityUsd > 0)) return { ok: false, reason: "the bonding curve is empty" };
    return { ok: true, priceUsd, liquidityUsd, curve: q.curve };
  }

  /** Remember a SOL/USD print for the wallet line. Does not fetch. */
  private rememberSolUsd(value: number, at: number): void {
    if (!(value > 0) || !Number.isFinite(value) || value < 5 || value > 5_000 || !Number.isFinite(at)) return;
    const prev = this.solUsdCache;
    if (prev && prev.at === at && prev.value === value) return;
    if (prev && at < prev.at) return;
    this.solUsdCache = { value, at };
    this.store.writeJson("solUsd", { value, at });
  }

  /** Last SOL/USD already on the desk, for the wallet line. Does not fetch. */
  private displaySolUsd(): { value: number; at: number } | null {
    const held = this.pricer?.quotes.solUsd;
    if (held && held.value > 0 && Number.isFinite(held.value)) this.rememberSolUsd(held.value, held.at);
    if (this.solUsdCache && this.solUsdCache.value > 0 && Number.isFinite(this.solUsdCache.value)) return this.solUsdCache;
    return null;
  }

  /**
   * Fill the wallet SOL/USD from Jupiter's wrapped-SOL price when the held-mark loop has not.
   * Uses the existing keyless Jupiter price call. Never a Helius read.
   */
  async refreshDisplaySol(): Promise<void> {
    const now = Date.now();
    const held = this.pricer?.quotes.solUsd;
    if (held && held.value > 0 && now - held.at <= 60_000) {
      this.rememberSolUsd(held.value, held.at);
      return;
    }
    if (this.solUsdCache && now - this.solUsdCache.at <= 60_000) return;
    try {
      const quotes = await fetchJupiterQuotes([SOL_MINT_ADDR], this.lookupFetch);
      const v = quotes.get(SOL_MINT_ADDR)?.priceUsd;
      if (v && v > 0 && Number.isFinite(v)) this.rememberSolUsd(v, Date.now());
    } catch {
      /* the wallet line keeps the last print */
    }
  }

  /** SOL/USD no older than 2 minutes: the held-mark loop's, else one Jupiter call. */
  private async solUsd(): Promise<number | null> {
    const held = this.pricer.quotes.solUsd;
    if (held && Date.now() - held.at <= 120_000 && held.value > 0) return held.value;
    if (this.solUsdCache && Date.now() - this.solUsdCache.at <= 60_000) return this.solUsdCache.value;
    try {
      const quotes = await fetchJupiterQuotes([SOL_MINT_ADDR], this.lookupFetch);
      const v = quotes.get(SOL_MINT_ADDR)?.priceUsd;
      if (v && v > 0 && Number.isFinite(v)) {
        const at = Date.now();
        this.rememberSolUsd(v, at);
        return v;
      }
    } catch {
      /* fail closed */
    }
    return null;
  }

  /** Held positions, the watchlist, and open limit buys. Scout noise does not take a chain-mark slot. */
  private chainMarkWanted(mint: string): boolean {
    if (!mint) return false;
    if (this.book?.positions.has(mint) || this.liveBook?.positions.has(mint)) return true;
    if (this.watchlist.some((item) => item.mint === mint)) return true;
    return this.orders.open().some((order) => order.side === "limit_buy" && order.mint === mint);
  }

  private prefilterThresholds(): PrefilterThresholds {
    const banned = new Set<string>();
    const now = Date.now();
    for (const [key, until] of this.cooldowns) {
      if (until <= now) continue;
      banned.add(key.startsWith("live:") ? key.slice("live:".length) : key);
    }
    return {
      minVolume1hUsd: this.config.rules.minVolume1hUsd,
      minLiquidityUsd: this.minLiquidityUsd,
      minAgeSeconds: this.minTokenAgeMin > 0 ? this.minTokenAgeMin * 60 : 0,
      maxAgeSeconds: this.maxTokenAgeMin > 0 ? this.maxTokenAgeMin * 60 : 0,
      minMarketCapUsd: 0,
      maxMarketCapUsd: 0,
      bannedMints: banned
    };
  }

  /** v13.35 fail-closed kills whose check said the data could not be verified. */
  unverifiedKillCounts(): Record<string, number> {
    return { ...this.unverifiedKills };
  }

  private pipelineView(): PipelineCounts {
    return { ...this.pipeline, unverifiedKills: { ...this.unverifiedKills } };
  }

  private noteUnverified(checks: ReadonlyArray<{ code: string; pass?: boolean; message: string }>): void {
    for (const check of checks) {
      if (check.pass === true) continue;
      if (!check.message.includes("could not be verified")) continue;
      this.unverifiedKills[check.code] = (this.unverifiedKills[check.code] ?? 0) + 1;
    }
  }

  prefilterSnapshot(): {
    kills: Record<string, number>;
    rpcSaved: number;
    heliusQueue: number;
    enrich: { count: number; p50Ms: number; p90Ms: number; maxMs: number };
  } {
    const view = this.scout.prefilterView();
    return {
      kills: view.kills,
      rpcSaved: view.rpcSaved + this.chainRpcSaved,
      heliusQueue: this.net.heliusQueue().priority0,
      enrich: view.enrich
    };
  }

  /** v13.6 Tape: pump.fun sightings printed with "Mark 0" get priced from their curve. */
  private queueCurvePrice(mint: string): void {
    if (!this.chainMarkWanted(mint)) {
      if (this.chain) {
        const now = Date.now();
        if (now - this.curveDropAt >= 1_000) {
          this.curveDropAt = now;
          this.chainRpcSaved += 1;
        }
      }
      return;
    }
    if (!this.chain || this.curveQueue.size >= 60) return;
    this.curveQueue.add(mint);
    if (this.curveTimer) return;
    this.curveTimer = setTimeout(() => {
      this.curveTimer = null;
      const mints = [...this.curveQueue].slice(0, 40);
      for (const m of mints) this.curveQueue.delete(m);
      this.track(this.priceCurves(mints));
    }, 1_000);
    this.curveTimer.unref?.();
  }

  private async priceCurves(mints: string[]): Promise<void> {
    if (!this.chain || !mints.length) return;
    let read: Awaited<ReturnType<ChainMarkReader["readCurves"]>>;
    try {
      read = await this.chain.readCurves(mints);
    } catch {
      return;
    }
    if (!read.quotes.size) return;
    const sol = await this.solUsd();
    if (!sol) return;
    for (const q of read.quotes.values()) {
      const seen = this.sightings.get(q.mint);
      if (!seen || seen.priceUsd > 0) continue;
      const priceUsd = q.native * sol;
      const liquidityUsd = 2 * q.virtualSol * sol;
      if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) continue;
      this.sightings.set(q.mint, { ...seen, priceUsd, liquidityUsd: seen.liquidityUsd > 0 ? seen.liquidityUsd : liquidityUsd });
      this.log({
        stage: "scout",
        kind: "info",
        mint: q.mint,
        symbol: seen.symbol,
        message: `Scout priced ${seen.symbol} from its pump.fun bonding curve on-chain. Mark ${price(priceUsd)}, 1h volume ${money(seen.volume1hUsd)}, curve depth ${money(liquidityUsd)}.`,
        detail: seen.source
      });
    }
  }

  /**
   * v13.6 / v13.17 Search by ticker or name ($ optional, any case). One held or previously
   * traded coin answers without a network call. The Tape is merged with DexScreener search
   * so a coin does not have to be on Home or the Tape, and a Tape hit does not hide others.
   * A provider failure keeps the local rows and says why. One coin → the lookup card;
   * several → code AMBIGUOUS with a pick list (HTTP 200 so old apps still show the text).
   */
  async lookupTicker(query: string): Promise<CoinLookup | CoinLookupError> {
    // "Held" means open in the book the desk is trading now (paper, or live when LIVE).
    const heldMints = new Set<string>([...this.book.positions.keys(), ...(this.liveBook?.positions.keys() ?? [])]);
    const tier0: LocalCoin[] = [];
    for (const pos of [...(this.liveBook?.positions.values() ?? []), ...this.book.positions.values()]) {
      tier0.push({ mint: pos.mint, symbol: pos.symbol, name: pos.name, liquidityUsd: pos.liquidityUsd, held: true, origin: "position" });
    }
    const tier1: LocalCoin[] = [];
    // The other mode's saved book (live when paper, paper when live), then recent trades.
    for (const pos of this.otherBookPositions()) {
      tier1.push({ mint: pos.mint, symbol: pos.symbol, name: pos.name, liquidityUsd: pos.liquidityUsd, held: false, origin: "position" });
    }
    const trades = this.store.recentClosed(200).reverse();
    for (const trade of trades) tier1.push({ mint: trade.mint, symbol: trade.symbol, held: heldMints.has(trade.mint), origin: "trade" });
    const enrich = (rows: TickerCandidate[]): TickerCandidate[] =>
      rows.map((row) => {
        const seen = this.sightings.get(row.mint) ?? this.lookups.get(row.mint)?.token;
        return {
          ...row,
          name: row.name || seen?.name || "",
          liquidityUsd: seen && seen.liquidityUsd > 0 ? seen.liquidityUsd : row.liquidityUsd,
          volume1hUsd: seen && Number.isFinite(seen.volume1hUsd) ? seen.volume1hUsd : row.volume1hUsd,
          held: heldMints.has(row.mint)
        };
      });
    const pick = async (rows: TickerCandidate[], where: string): Promise<CoinLookup | CoinLookupError> => {
      if (rows.length === 1 && rows[0]!.exact) {
        const found = await this.lookupCoin(rows[0]!.mint);
        return found.ok ? { ...found, matchedBy: `${query.toUpperCase()} · ${where}` } : found;
      }
      return {
        ok: false,
        code: "AMBIGUOUS",
        query,
        error: `${rows.length} coin${rows.length === 1 ? "" : "s"} match “${query}” (${where}). Tap the one you mean.`,
        candidates: rows
      };
    };
    const local0 = enrich(matchLocal(query, tier0));
    if (local0.length) return pick(local0, "held");
    const local1 = enrich(matchLocal(query, tier1));
    if (local1.length) return pick(local1, "traded before");
    const tier2: LocalCoin[] = [];
    for (const token of this.sightings.values()) tier2.push({ mint: token.mint, symbol: token.symbol, name: token.name, liquidityUsd: token.liquidityUsd, volume1hUsd: token.volume1hUsd, origin: "tape" });
    for (const entry of this.lookups.values()) tier2.push({ mint: entry.token.mint, symbol: entry.token.symbol, name: entry.token.name, liquidityUsd: entry.token.liquidityUsd, volume1hUsd: entry.token.volume1hUsd, origin: "tape" });
    for (const item of this.watchlist) tier2.push({ mint: item.mint, symbol: item.symbol, name: item.name, origin: "tape" });
    const local2 = enrich(matchLocal(query, tier2)).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    this.dexSearch ??= new DexSearchClient(this.lookupFetch);
    const searched = await this.dexSearch.search(query);
    let providerNote: string | undefined;
    let ranked: TickerCandidate[] = [];
    if (!searched.ok) providerNote = searched.error;
    else {
      ranked = rankDexSearch(query, searched.body, heldMints);
      if (searched.cached) providerNote = "DexScreener search is cached and can be up to 60s old. Open a coin for a fresh price.";
    }
    const merged = mergeTickerCandidates(local2, ranked);
    if (!merged.length) {
      return {
        ok: false,
        code: "LOOKUP_FAILED",
        providerNote,
        error: providerNote
          ? providerNote
          : `No Solana coin called “${query}” in your positions, trades, the Tape or DexScreener search. Paste the mint or a link.`
      };
    }
    const where = merged.every((row) => row.origin !== "dexscreener")
      ? "on the Tape"
      : merged.every((row) => row.origin === "dexscreener")
        ? "DexScreener search"
        : "the Tape and DexScreener";
    if (merged.length === 1 && merged[0]!.exact) {
      const found = await this.lookupCoin(merged[0]!.mint);
      if (!found.ok) return providerNote ? { ...found, providerNote } : found;
      return { ...found, matchedBy: `${query.toUpperCase()} · ${where}`, ...(providerNote ? { providerNote } : {}) };
    }
    const noun = `${merged.length} coin${merged.length === 1 ? "" : "s"}`;
    const listed = providerNote ? `${providerNote} ${noun} still listed.` : null;
    return {
      ok: false,
      code: "AMBIGUOUS",
      query,
      providerNote,
      error: listed
        ?? (merged.some((row) => !row.exact)
          ? `No exact “${query}” on Solana. Close matches below; tap one.`
          : `${noun} match “${query}” (${where}). Tap the one you mean. Home and the Tape are not required.`),
      candidates: merged
    };
  }

  /** Positions saved in the other mode's book (live when paper, paper when live). Read-only. */
  private otherBookPositions(): Position[] {
    try {
      // v13.7: an armed desk already holds both books in memory (tier 0).
      if (this.liveBook) return [];
      const other = this.store.loadBook("book:live");
      return Array.isArray(other?.positions) ? other!.positions : [];
    } catch {
      return [];
    }
  }

  /**
   * Add coin: parse a mint or link, resolve it to a Solana mint, read price/pool/holders/mint
   * authority the same way Scout does, and run the existing Filter and Analyst as a report.
   * No price from DexScreener means an error and no buy.
   */
  async lookupCoin(q: string): Promise<CoinLookup | CoinLookupError> {
    const parsed = parseCoinInput(q);
    if (!parsed.ok) {
      const ticker = tickerQuery(q);
      if (ticker) return this.lookupTicker(ticker);
      return { ok: false, error: parsed.error, code: "LOOKUP_FAILED" };
    }
    const resolved = await resolveCoinMint(parsed, this.lookupFetch);
    if (!resolved.ok) return { ok: false, error: resolved.error, code: "LOOKUP_FAILED", platform: parsed.platform };
    const mint = resolved.mint;
    const lookupStarted = Date.now();
    // Safety overlaps price and chain. The phone lookup client dies at 8s, so it cannot wait behind them.
    const safetyPromise = this.tokenSafety(mint, -1);
    // Dex and Jupiter are raced. Chain reads reuse that Dex body and start Alchemy at once.
    // RugCheck runs beside the RPC calls. The leftover budget stays inside that 8s, with a tail for the response.
    let dexPayload: unknown | null = null;
    const priced = await lookupPriceFeeds(
      enrichSighting(
        { mint, source: "raydium", observedAt: Date.now() },
        { fetchImpl: this.lookupFetch, holderPagesMax: 0, onDex: (payload) => { dexPayload = payload; } }
      ).catch(() => null),
      jupiterLookupQuote(mint, 0, this.lookupFetch),
      LOOKUP_PRICE_MS
    );
    let token = priced.token ?? blankLookupToken(mint);
    let priceSource: "dexscreener" | "jupiter" | "chain" = token.priceFeed === "jupiter" ? "jupiter" : "dexscreener";
    let curveWhy: string | null = null;
    let providerNote: string | undefined;
    const dexPriced = token.priceFeed === "dexscreener" && token.priceUsd > 0 && token.liquidityUsd > 0;
    if (!dexPriced) {
      const dexPrice = token.priceFeed === "dexscreener" ? token.priceUsd : 0;
      const fallback = priced.jup.ok ? priced.jup : dexPrice > 0 ? await takeFirst(jupiterLookupQuote(mint, dexPrice, this.lookupFetch), 1_000, priced.jup) : priced.jup;
      if (fallback.ok) {
        if (dexPrice > 0 && Math.abs(fallback.priceUsd / dexPrice - 1) > LOOKUP_PRICE_AGREEMENT) {
          return {
            ok: false,
            error: `Prices disagree (DexScreener ${dexPrice.toPrecision(4)} vs Jupiter ${fallback.priceUsd.toPrecision(4)}). No reliable price, so Buy is off.`,
            code: "PRICE_UNAVAILABLE",
            platform: parsed.platform,
            mint
          };
        }
        token.priceUsd = fallback.priceUsd;
        token.liquidityUsd = fallback.liquidityUsd;
        token.priceFeed = "jupiter";
        priceSource = "jupiter";
      } else if (fallback.error) {
        return { ok: false, error: fallback.error, code: "PRICE_UNAVAILABLE", platform: parsed.platform, mint, providerNote: "Tap Look up to try again. Nothing was bought." };
      } else if (!(token.priceUsd > 0) || !(token.liquidityUsd > 0)) {
        const curve = await takeFirst(this.curvePrice(mint), LOOKUP_CURVE_MS, {
          ok: false as const,
          reason: "the public RPC did not answer inside the lookup budget"
        });
        if (curve.ok) {
          token.priceUsd = curve.priceUsd;
          token.liquidityUsd = curve.liquidityUsd;
          token.priceFeed = "chain";
          token.pairAddress = curve.curve;
          token.dex = "pump.fun curve";
          priceSource = "chain";
        } else {
          curveWhy = curve.reason;
        }
      }
    }
    if (!(token.priceUsd > 0) || !Number.isFinite(token.priceUsd) || (token.priceFeed !== "dexscreener" && token.priceFeed !== "jupiter" && token.priceFeed !== "chain") || !(token.liquidityUsd > 0)) {
      return {
        ok: false,
        error: `No reliable price for ${token.symbol || mint.slice(0, 6)}. Tried DexScreener (no priced pool with depth), Jupiter (no quote) and the pump.fun bonding curve on-chain (${curveWhy ?? "not readable"}). Buy is off.`,
        code: "PRICE_UNAVAILABLE",
        platform: parsed.platform,
        mint,
        providerNote: "Tap Look up to try again. Nothing was bought."
      };
    }
    const providers: string[] = [];
    const pumpEarly = isPumpCoin({ source: token.source, dex: token.dex, platform: parsed.platform });
    const bundlePromise = pumpEarly
      ? safetyPromise.then((safety) => this.launchBundleSoon(mint, safety.supply))
      : Promise.resolve(null);
    if (priceSource === "dexscreener") providers.push("dex");
    if (priceSource === "jupiter") providers.push("jupiter");
    if (priceSource === "chain") providers.push("curve");
    let chainTimedOut = false;
    if (this.config.rpcUrl || this.config.rugcheckUrl) {
      const note: EnrichNote = { providers: [], timedOut: false };
      const budgetMs = lookupChainBudgetMs(Date.now() - lookupStarted);
      let chain: CandidateToken | null = null;
      try {
        chain = await enrichSighting(
          { mint, source: token.source === "pumpfun" ? "pumpfun" : "raydium", observedAt: Date.now(), symbol: token.symbol, name: token.name, devWallet: token.devWallet ?? undefined },
          {
            rpcUrl: this.config.rpcUrl || undefined,
            rugcheckUrl: this.config.rugcheckUrl || undefined,
            fetchImpl: this.lookupFetch,
            holderPagesMax: 0,
            skipDex: dexPayload != null,
            dexPayload,
            budgetMs,
            note
          }
        );
      } catch (err) {
        if (!(err instanceof EnrichDeferred)) throw err;
        chainTimedOut = true;
      }
      if (note.timedOut) chainTimedOut = true;
      for (const name of note.providers) if (!providers.includes(name)) providers.push(name);
      if (chain) applyChainFields(token, chain);
      if (chainTimedOut && !chainVerified(token)) {
        providerNote = "Price is in from DexScreener or Jupiter. The public RPC or Rugcheck did not answer in time, so mint authority is unverified and the hard kill stays on. Tap Look up to try again.";
      } else if (chainTimedOut) {
        providerNote = "Price is in. Some chain checks timed out; the ones that answered are filled in.";
      }
    }
    const freshChain = chainFactFieldSet(token);
    const reused = this.fillChainFromFacts(token);
    if (reused) {
      if (!providers.includes("sighting")) providers.push("sighting");
      const ageMin = Math.max(1, Math.round(reused.ageMs / 60_000));
      const reuseNote = `Chain read was incomplete. Reused a scout or lookup from ${ageMin} min ago for the checks it had verified.`;
      providerNote = providerNote ? `${providerNote} ${reuseNote}` : reuseNote;
    }
    this.lookups.set(mint, { at: Date.now(), platform: parsed.platform, token: { ...token, social: { ...token.social } } });
    if (this.lookups.size > 200) {
      const first = this.lookups.keys().next().value;
      if (first) this.lookups.delete(first);
    }
    const held = this.book.positions.has(mint) || this.liveBook?.positions.has(mint) === true;
    if (!held) {
      this.remember(token, freshChain);
      this.book.mark(mint, token.priceUsd);
    }
    const rug = await this.rugs.lookup(token.devWallet);
    const filter = evaluateFilter(token, rug, this.config.rules, {
      allowUnlockedLp: this.allowUnlockedLp,
      minLiquidityUsd: this.minLiquidityUsd,
      minAgeSeconds: this.minTokenAgeMin > 0 ? this.minTokenAgeMin * 60 : 0,
      maxAgeSeconds: this.maxTokenAgeMin > 0 ? this.maxTokenAgeMin * 60 : 0,
      minHolderCount: this.minHolderCount,
      maxDevHoldingPct: this.maxDevHoldingPct
    });
    const report = scoreToken(token, this.config.rules);
    this.analystScores.set(mint, report.score);
    const hardKills: Array<{ code: string; message: string }> = filter.checks
      .filter((c) => !c.pass && HARD_KILL_CODES.has(c.code))
      .map((c) => ({ code: c.code, message: c.message }));
    const safety = await safetyPromise;
    if (safety.status === "blocked") hardKills.push({ code: "TOKEN_SAFETY", message: safety.chip });
    const bundle = await bundlePromise;
    const cooldownUntil = this.cooldowns.get(mint) ?? 0;
    const capUsd = this.positionCapUsd();
    const manualMaxUsd = this.positionCapUsd(this.book.equity(), SIZING_BAND.manualMaxPct);
    const poolMaxUsd = maxSizeForPool(token.liquidityUsd, this.config.rules.maxEntrySlippage, this.maxExitSlippage);
    const blocked = held
      ? "Already holding it. The desk does not average down."
      : !(capUsd >= 0.01)
        ? "No cash or exposure room for a buy."
        : !(poolMaxUsd >= 1)
          ? "Pool is too thin for even $1 under the slippage and exit-depth caps."
          : null;
    const checks = filter.checks.map((c) => ({ code: c.code, pass: c.pass, message: c.message }));
    const audit: LookupAudit = { providerNote, chainTimedOut, providers, checks };
    const lookedUp = this.lookups.get(mint);
    if (lookedUp) lookedUp.audit = audit;
    this.noteUnverified(checks);
    this.log(
      {
        stage: "system",
        kind: "info",
        mint,
        symbol: token.symbol,
        code: "MANUAL_BUY",
        message: `Add coin looked up ${token.symbol} from ${parsed.platform}. Mark ${price(token.priceUsd)}, liquidity ${money(token.liquidityUsd)}, 1h volume ${money(token.volume1hUsd)}. Filter ${filter.decision === "pass" ? "pass" : `kill (${filter.reasons.map((r) => r.code).join(", ")})`}, Analyst ${report.score.toFixed(2)}.${auditText(audit)}`
      },
      audit
    );
    return {
      ok: true,
      mint,
      symbol: token.symbol,
      name: token.name,
      platform: parsed.platform,
      tag: positionTag(parsed.platform),
      priceUsd: token.priceUsd,
      liquidityUsd: token.liquidityUsd,
      volume1hUsd: token.volume1hUsd,
      marketCapUsd: token.marketCapUsd ?? null,
      ageSeconds: token.ageSeconds,
      pairAddress: token.pairAddress ?? null,
      dex: token.dex ?? null,
      dexscreenerUrl: dexscreenerUrl(token.pairAddress ?? mint),
      priceSource,
      checks,
      filterPass: filter.decision === "pass",
      hardKills,
      analyst: { score: report.score, line: this.config.rules.analystMinScore, pass: report.decision === "trade" },
      poolMaxUsd,
      positionCapUsd: capUsd,
      manualMaxUsd,
      cashUsd: roundUsd(this.book.cashUsd),
      maxEntrySlippage: this.config.rules.maxEntrySlippage,
      held,
      watching: this.watchlist.some((item) => item.mint === mint),
      canBuy: blocked == null,
      buyBlockedReason: blocked ?? (cooldownUntil > Date.now() ? `Hard-stop cooldown for ${Math.ceil((cooldownUntil - Date.now()) / 60_000)} more minutes. Buy anyway overrides it.` : null),
      providerNote,
      safetyChip: safety.chip,
      bundleChip: bundle?.label ?? null
    };
  }

  listWatchlist(): WatchItem[] {
    return this.watchlist.map((item) => ({ ...item }));
  }

  /** Adds a coin from a mint or link. Needs a reliable price, same as a buy. */
  async addToWatchlist(q: string): Promise<{ ok: true; item: WatchItem; watchlist: WatchItem[] } | CoinLookupError> {
    const found = await this.lookupCoin(q);
    if (!found.ok) return found;
    const existing = this.watchlist.find((item) => item.mint === found.mint);
    if (existing) return { ok: true, item: { ...existing }, watchlist: this.listWatchlist() };
    if (this.watchlist.length >= WATCHLIST_MAX) {
      return { ok: false, error: `Watchlist is full (${WATCHLIST_MAX}). Remove one first.`, code: "LOOKUP_FAILED" };
    }
    const item: WatchItem = {
      mint: found.mint,
      symbol: found.symbol,
      name: found.name,
      platform: found.platform,
      addedAt: Date.now(),
      addedPriceUsd: found.priceUsd,
      lastPriceUsd: found.priceUsd,
      lastAt: Date.now(),
      changePct: 0,
      dexscreenerUrl: found.dexscreenerUrl
    };
    this.watchlist.push(item);
    this.saveWatchlist();
    this.bus.emit("desk.changed", { reason: "watchlist", at: Date.now() });
    this.log({ stage: "system", kind: "info", mint: item.mint, symbol: item.symbol, message: `Watchlist added ${item.symbol} at ${price(item.addedPriceUsd)} from ${item.platform}.` });
    return { ok: true, item: { ...item }, watchlist: this.listWatchlist() };
  }

  removeFromWatchlist(mint: string): { ok: true; watchlist: WatchItem[] } | { ok: false; error: string } {
    const cleaned = (mint ?? "").trim();
    const before = this.watchlist.length;
    this.watchlist = this.watchlist.filter((item) => item.mint !== cleaned);
    if (this.watchlist.length === before) return { ok: false, error: "That coin is not on the watchlist." };
    this.saveWatchlist();
    this.bus.emit("desk.changed", { reason: "watchlist", at: Date.now() });
    return { ok: true, watchlist: this.listWatchlist() };
  }

  /** One DexScreener pass over watched mints. A missing price leaves the last one and marks it stale. */
  async refreshWatchlist(): Promise<void> {
    if (!this.watchlist.length) return;
    let quotes: Map<string, { priceUsd: number }>;
    try {
      quotes = await fetchDexQuotes(this.watchlist.map((item) => item.mint), this.watchFetch);
    } catch {
      return;
    }
    const now = Date.now();
    let changed = false;
    for (const item of this.watchlist) {
      const quote = quotes.get(item.mint);
      if (!quote || !(quote.priceUsd > 0) || !Number.isFinite(quote.priceUsd)) continue;
      item.lastPriceUsd = quote.priceUsd;
      item.lastAt = now;
      item.changePct = watchChange(item.addedPriceUsd, quote.priceUsd);
      changed = true;
    }
    if (changed) {
      this.saveWatchlist();
      this.bus.emit("desk.changed", { reason: "watchlist", at: now });
    }
  }

  private saveWatchlist(): void {
    this.store.writeJson("watchlist", this.watchlist);
  }

  /**
   * Operator buy from the tape. Paper fills go through quotePaperBuy.
   * Live swaps go through the existing broker only when config.mode is already live.
   * Size defaults to the planOrder cap. A size above that cap is cut down to the cap and filled.
   * An open mint is refused (no averaging down). Unknown price is refused.
   */
  async manualBuy(
    mint: string,
    sizeUsd?: number,
    opts?: { ignoreCooldown?: boolean; confirmHardKill?: boolean; confirmSize?: boolean; book?: BookKind }
  ): Promise<ManualBuyResult | ManualBuyRefusal> {
    const cleaned = mint.trim();
    if (!cleaned) return { ok: false, error: "Mint is required.", code: "PRICE_UNAVAILABLE" };
    // An armed desk used to treat a missing book as live. Paper buttons omitted the
    // field, so a tap the operator meant as paper was sent as a real swap.
    // Missing book on an armed desk fills nothing and sends nothing.
    if (opts?.book !== "paper" && opts?.book !== "live") {
      if (this.liveBook) {
        const error = "Buy refused. The request did not name paper or live, and this desk is armed. Nothing was filled and nothing was sent.";
        this.log({ stage: "executor", kind: "reject", code: "BOOK_REQUIRED", message: error, mint: cleaned });
        return { ok: false, error, code: "BOOK_REQUIRED" };
      }
    }
    const kind: BookKind = opts?.book === "live" ? "live" : "paper";
    if (kind === "live" && !this.liveBook) {
      const error = this.liveNotArmedMessage();
      this.log({ stage: "executor", kind: "reject", mint: cleaned, code: "LIVE_NOT_ARMED", message: `Manual buy refused. ${error}` });
      return { ok: false, error, code: "LIVE_NOT_ARMED" };
    }
    const looked = this.lookups.get(cleaned);
    if (looked && !this.sightings.has(cleaned)) this.remember(looked.token);
    let seen = this.sightings.get(cleaned);
    if (!seen) {
      const raw = this.rawTape.get(cleaned);
      // A row still waiting on enrich has no scouted mark. Quote it; do not fill at the listing hint.
      if (raw && raw.enrich !== "enriched") seen = rawCandidate(raw);
    }
    if (!seen) {
      this.log({
        stage: "executor",
        kind: "reject",
        mint: cleaned,
        code: "PRICE_UNAVAILABLE",
        message: "Manual buy refused. No scouted mark for that mint."
      });
      return { ok: false, error: "No scouted mark for that mint. Buy refused.", code: "PRICE_UNAVAILABLE" };
    }
    // The live book does not inherit the paper book's last price.
    const priceUsd = this.bk(kind).price(cleaned, seen.priceUsd);
    const liquidityUsd = this.markLiquidity.get(cleaned) ?? seen.liquidityUsd;
    let token: CandidateToken = { ...seen, priceUsd, liquidityUsd };
    if (!(token.priceUsd > 0) || !Number.isFinite(token.priceUsd)) {
      // v13.6: brand-new pump.fun coins have no DexScreener pair and no Jupiter quote yet.
      // Read the bonding curve on-chain; fail closed if it is missing, complete or empty.
      const tried: string[] = [];
      const jup = await takeFirst(jupiterLookupQuote(cleaned, 0, this.lookupFetch), LOOKUP_PRICE_MS, { ok: false as const });
      if (jup.ok) {
        token = { ...token, priceUsd: jup.priceUsd, liquidityUsd: jup.liquidityUsd, priceFeed: "jupiter", pairAddress: undefined };
      } else {
        tried.push(`Jupiter has no quote${"error" in jup && jup.error ? ` (${jup.error})` : ""}`);
        const curve = await takeFirst(this.curvePrice(cleaned), LOOKUP_CURVE_MS, {
          ok: false as const,
          reason: "the RPC did not answer inside the buy budget"
        });
        if (curve.ok) {
          token = { ...token, priceUsd: curve.priceUsd, liquidityUsd: curve.liquidityUsd, priceFeed: "chain", pairAddress: curve.curve, dex: "pump.fun curve" };
          this.remember(token);
          this.log({ stage: "system", kind: "info", mint: cleaned, symbol: token.symbol, code: "MANUAL_BUY", message: `${token.symbol} has no DexScreener or Jupiter price yet. Priced from its pump.fun bonding curve on-chain: ${price(curve.priceUsd)}, curve depth ${money(curve.liquidityUsd)}. Stops follow the same curve.` });
        } else {
          tried.push(`pump.fun bonding curve: ${curve.reason}`);
        }
      }
      if (!(token.priceUsd > 0) || !Number.isFinite(token.priceUsd)) {
        const message = `No price for ${token.symbol} yet, so the buy was refused. Tried: DexScreener (no priced pair yet), ${tried.join(", ")}. The desk never fills without a real price. Try again in a minute, or paste its mint in Add coin.`;
        this.log({ stage: "executor", kind: "reject", mint: token.mint, symbol: token.symbol, code: "PRICE_UNAVAILABLE", message: `Manual buy refused. ${message}` });
        return { ok: false, error: message, code: "PRICE_UNAVAILABLE" };
      }
    }
    const lookupAudit = this.lookups.get(token.mint)?.audit;
    this.log(
      {
        stage: "system",
        kind: "info",
        mint: token.mint,
        symbol: token.symbol,
        code: "MANUAL_BUY",
        message: `Manual buy requested for ${token.symbol} at mark ${price(token.priceUsd)} on the ${kind} book.${lookupAudit ? auditText(lookupAudit) : ""}`
      },
      lookupAudit ?? null
    );
    // Hard kills (mint authority not revoked, dev rug link, token safety) need the operator's "Buy anyway".
    // A safety read that fails is Unknown and does not block a manual buy. AI buys never reach this path.
    const safety = await this.tokenSafety(token.mint, -1);
    // Bundle is warning-only for a manual buy. Never wait on an uncapped Helius P2 read (launchBundle / rpcBundle).
    const bundle = isPumpCoin(token) ? await this.launchBundleSoon(token.mint, safety.supply) : null;
    if (bundle?.flagged && bundle.label) {
      this.log({
        stage: "system",
        kind: "info",
        mint: token.mint,
        symbol: token.symbol,
        code: "BUNDLED",
        message: `Warning: ${token.symbol} ${bundle.label}. A manual buy is not blocked.`
      });
    }
    const cached = this.analystScores.get(token.mint);
    const score = cached != null && Number.isFinite(cached) ? cached : scoreToken(token, this.config.rules).score;
    this.analystScores.set(token.mint, score);
    // Opinion gates (engine watch, analyst line, soft filter, hard-stop ban) warn and do not refuse.
    // Hard kills still use Buy anyway: the first tap is held, the confirm buys.
    const notes: string[] = [];
    let heldByBan = false;
    if (!this.bk(kind).positions.has(token.mint)) {
      const rug = await this.rugs.lookup(token.devWallet);
      const failed = evaluateFilter(token, rug, this.config.rules, {
        allowUnlockedLp: this.allowUnlockedLp,
        minLiquidityUsd: this.minLiquidityUsd,
        minAgeSeconds: this.minTokenAgeMin > 0 ? this.minTokenAgeMin * 60 : 0,
        maxAgeSeconds: this.maxTokenAgeMin > 0 ? this.maxTokenAgeMin * 60 : 0,
        minHolderCount: this.minHolderCount,
        maxDevHoldingPct: this.maxDevHoldingPct
      }).checks.filter((check) => !check.pass);
      const kills = failed.filter((check) => HARD_KILL_CODES.has(check.code));
      const soft = failed.filter((check) => !HARD_KILL_CODES.has(check.code));
      const safetyBlocked = safety.status === "blocked";
      if ((kills.length || safetyBlocked) && opts?.confirmHardKill !== true) {
        const why = [...kills.map((k) => k.message), ...(safetyBlocked ? [safety.chip] : [])].join(" ");
        const message = `Hard kill on ${token.symbol}: ${why} Tap Buy anyway to ${kind === "live" ? "buy it with real money" : "paper-buy it"} regardless.`;
        this.log({ stage: "executor", kind: "reject", mint: token.mint, symbol: token.symbol, code: "HARD_KILL", message: `Manual buy held. ${message}` });
        return { ok: false, error: message, code: "HARD_KILL" };
      }
      if (kills.length || safetyBlocked) {
        this.log({
          stage: "system",
          kind: "info",
          mint: token.mint,
          symbol: token.symbol,
          code: "HARD_KILL",
          message: `Operator chose Buy anyway on ${token.symbol} past ${[...kills.map((k) => k.code), ...(safetyBlocked ? [safety.chip] : [])].join(", ")}. ${kind === "live" ? "Live buy." : "Paper only."}`
        });
      }
      if (this.strategy.isWatching(token.mint)) {
        notes.push(`Engine is watching ${token.symbol} for a Launch or Momentum signal. No buy yet.`);
      }
      if (!(score + 1e-9 >= this.config.rules.analystMinScore)) {
        notes.push(`Analyst scored ${token.symbol} ${score.toFixed(2)}. No trade. Below the ${this.config.rules.analystMinScore.toFixed(2)} line.`);
      }
      if (soft.length) notes.push(`Filter killed ${token.symbol}. ${soft.map((check) => check.message).join(" ")}`);
      const until = this.cooldowns.get(bookKey(kind, token.mint)) ?? 0;
      const banned = until > Date.now();
      // Only an explicit tap sets ignoreCooldown. A limit fill does not, so the ban still refuses it.
      if (banned && opts?.ignoreCooldown === true) {
        const mins = Math.ceil((until - Date.now()) / 60_000);
        notes.push(`Mint is banned after a hard stop. Cooldown has about ${mins} minute(s) left. Auto buys stay blocked.`);
      } else if (banned) heldByBan = true;
    }
    const bypassBan = opts?.ignoreCooldown === true;
    const warning = notes.length && !heldByBan ? `${notes.join(" ")} Manual ${kind} buy goes through.` : undefined;
    if (warning) {
      this.log({
        stage: "system",
        kind: "info",
        mint: token.mint,
        symbol: token.symbol,
        code: "MANUAL_OVERRIDE",
        message: warning
      });
    }
    const tag = looked ? positionTag(looked.platform) : undefined;
    // Explicit taps pass ignoreCooldown. Limit fills do not, so a hard-stop ban still blocks them.
    return this.executeBuy(token, score, sizeUsd, "manual", bypassBan, {
      confirmSize: opts?.confirmSize === true,
      tag,
      book: kind,
      warning
    });
  }

  /**
   * Stores an operator note. Does not set mode, LIVE_TRADING, or any key material.
   */
  setOperatorReady(operatorReady: boolean): { ok: true; readiness: LiveReadiness } | { ok: false; error: string } {
    if (typeof operatorReady !== "boolean") {
      return { ok: false, error: "operatorReady must be true or false. Live trading is unchanged." };
    }
    this.operatorReady = operatorReady;
    this.store.writeJson("settings", { ...this.readSettings(), operatorReady });
    this.log({
      stage: "system",
      kind: "info",
      code: "LIVE_NOT_ARMED",
      message: operatorReady
        ? "Operator marked the live checklist ready. Mode is unchanged. LIVE_TRADING is not set from the phone. The keypair stays on the desk host."
        : "Operator cleared the live-checklist mark. Mode is unchanged."
    });
    return { ok: true, readiness: this.readiness() };
  }

  /**
   * v13.9 plain reason the live buttons do nothing yet. Null when the live book is armed.
   * Never includes key material: only whether a usable key is present.
   */
  liveNotArmedReason(): string | null {
    if (this.liveBook) return null;
    const { keypairPresent, keyInvalid } = this.walletStatus;
    if (!keypairPresent) {
      return keyInvalid
        ? "Live not armed: wallet key missing (WALLET_PRIVATE_KEY on the desk host is not a private key)."
        : "Live not armed: wallet key missing.";
    }
    if (!this.config.liveRequested) return "Live not armed: LIVE_TRADING is off on the desk host.";
    return `Live not armed${this.config.armError ? `: ${this.config.armError}` : "."}`;
  }

  private liveNotArmedMessage(): string {
    return `${this.liveNotArmedReason() ?? "Live not armed."} Nothing was sent, and no paper trade was placed instead.`;
  }

  readiness(): LiveReadiness {
    const mode = this.config.mode;
    const liveTradingFlag = this.config.liveRequested;
    const { keypairPresent, walletPublicKey } = this.walletStatus;
    const rpcPresent = this.config.rpcUrl.trim().length > 0;
    const operatorReady = this.operatorReady;
    const bal = this.walletBalances;
    const balanceLine =
      bal == null
        ? "Wallet balance has not been read."
        : bal.error
          ? bal.usdc != null
            ? `Wallet balance is stale (${bal.error}). The last USDC figure is kept and labeled stale.`
            : `Wallet balance is unknown (${bal.error}). The live book does not show that as $0.`
          : `Wallet balance is current: ${bal.sol} SOL, ${bal.usdc} USDC.`;
    const lines = [
      `Mode ${mode}.`,
      `LIVE_TRADING is ${liveTradingFlag ? "true" : "off"}. The phone cannot turn this flag on.`,
      keypairPresent
        ? `Wallet key on the desk host is loaded (${this.walletStatus.keySource === "env" ? "WALLET_PRIVATE_KEY" : "WALLET_KEYPAIR_PATH"})${walletPublicKey ? `. Public address ${walletPublicKey}` : ""}. The secret stays on that host.`
        : this.walletStatus.keyInvalid
          ? "WALLET_PRIVATE_KEY on the desk host is not a valid Solana private key (base58 from Phantom, or a JSON byte array)."
          : "No wallet key on the desk host. Set WALLET_PRIVATE_KEY or WALLET_KEYPAIR_PATH in the desk host .env. Never put the key on the phone or in a chat.",
      isPublicRpc(this.config.walletRpcUrl)
        ? "SOLANA_RPC_URL is the public Solana endpoint, and DESK_WALLET_RPC_URL is not set, so the wallet uses that same URL. Published limits are 100 requests/10s per IP, 40/10s per method, and 40 concurrent, and they vary. The endpoint is not a production RPC. The desk budgets, caches, and backs off. Choosing another provider is outside this process."
        : rpcPresent
          ? "RPC is set on the desk host (SOLANA_RPC_URL or DESK_WALLET_RPC_URL). The URL is not shown here."
          : "SOLANA_RPC_URL is missing on the desk host.",
      balanceLine,
      `Live trade size $${this.liveTradeUsd}. Live daily cap ${this.liveDailyCapUsd == null ? "off (liveDailyCapUsd)" : `$${this.liveDailyCapUsd} (liveDailyCapUsd)`}.`,
      this.strategy.settings.liveVariant ? `Engine LIVE variant: ${this.strategy.settings.liveVariant} (real money, set by the operator).` : "Engine live variant: none (the engine trades paper only).",
      "AI auto-buys stay on the paper book. liveAutoBuy cannot be turned on. Enabling live does not place a trade.",
      "A pump.fun curve or PumpSwap coin spends SOL through @pump-fun/pump-sdk. A Jupiter buy spends USDC through JUPITER_QUOTE_URL and JUPITER_SWAP_URL and keeps SOL for fees. Neither path runs while the balance read is unknown. No order has been signed by this check.",
      "Open live orders are rechecked when the process arms and do not fire on a price from before that.",
      mode === "live"
        ? `Live swaps are enabled in config. ${this.liveScopeLine()}`
        : "Still paper. Real money starts only after the desk host sets LIVE_TRADING=true (with WALLET_PRIVATE_KEY filled) in .env, then restarts the desk.",
      operatorReady
        ? "operatorReady is true because a person sent it. The mark does not set LIVE_TRADING, does not send an order, and does not store a wallet."
        : "operatorReady is false. It stays false until a person sends {\"operatorReady\": true}. A balance read, including one that recovers, does not flip it."
    ];
    return { mode, liveTradingFlag, keypairPresent, walletPublicKey, rpcPresent, operatorReady, liveScope: this.liveScopeNow(), lines };
  }

  /** One advisory pass. Logs notes. Does not buy, sell, or change a rule. */
  async commentOnce(): Promise<string[]> {
    const base = this.buildAdvice();
    const phrased = await phraseAdvice(
      base.map((item) => item.text),
      { apiKey: this.config.openaiApiKey, model: this.config.openaiModel }
    );
    const merged = base.map((item, index) => ({ ...item, text: phrased[index] ?? item.text }));
    this.publishAdvice(merged);
    return merged.map((item) => item.text);
  }

  /** Test and replay entry for marks. Risk is the only consumer that can exit. */
  async markPrice(mint: string, priceUsd: number): Promise<void> {
    this.scout.tick(mint, priceUsd);
    await this.drain();
  }

  /** Feed status with live per-source state. The banner (`lastError`) is debounced to 2 minutes. */
  private feedView(now = Date.now()): FeedStatus {
    const report = this.scout.report(now);
    let banner = report.lastError;
    if (!banner && this.pricerFailingSince != null && now - this.pricerFailingSince >= BANNER_AFTER_MS) {
      banner = `position prices failing for ${Math.round((now - this.pricerFailingSince) / 60_000)} min${this.pricerError ? ` (${this.pricerError})` : ""}`;
    }
    return { ...this.feed, ...report, lastError: banner };
  }

  snapshot(): DeskSnapshot {
    this.healAbsurdMarks();
    const riskEquityUsd = this.book.equity();
    const equityUsd = this.displayEquity();
    const sessionPnlUsd = equityUsd - this.config.startingBalanceUsd;
    const positions = [...this.book.positions.values()].map((pos) => this.view(pos));
    const seq = ++this.snapshotSeq;
    return {
      seq,
      liveScope: this.liveScopeNow(),
      liveBook: this.liveBookView(),
      liveNotArmed: this.liveNotArmedReason(),
      tapeQuotes: this.tape?.view() ?? {},
      rawTape: this.rawTape.view(),
      orders: this.orderViews(),
      wallet: this.walletView(),
      mode: this.config.mode,
      liveRequested: this.config.liveRequested,
      armError: this.config.armError,
      readiness: this.readiness(),
      startedAt: this.startedAt,
      now: Date.now(),
      startingBalanceUsd: this.config.startingBalanceUsd,
      cashUsd: roundUsd(this.book.cashUsd),
      equityUsd: roundUsd(equityUsd),
      sessionPnlUsd: roundUsd(sessionPnlUsd),
      sessionPnlPct: this.config.startingBalanceUsd > 0 ? sessionPnlUsd / this.config.startingBalanceUsd : 0,
      rules: this.config.rules,
      prefs: this.prefsView(),
      positionCapUsd: this.positionCapUsd(riskEquityUsd),
      cooldowns: [...this.cooldowns.entries()]
        .filter(([, until]) => until > Date.now())
        .map(([mint, until]) => ({
          mint,
          until,
          minutesLeft: Math.ceil((until - Date.now()) / 60_000)
        })),
      feed: this.feedView(),
      pipeline: this.pipelineView(),
      killReasons: { ...this.killReasons },
      positions,
      closed: this.store
        .recentClosed(40)
        .filter((trade) => trade.closedAt >= this.startedAt)
        .slice(-20),
      equity: downsample(visibleEquity(this.store.equityCurve(this.startedAt)), 240),
      events: this.store.recentEvents(180),
      advice: this.advice,
      watchlist: this.watchlist.map((item) => ({ ...item })),
      exposureUsd: roundUsd(this.exposureUsd()),
      manualMaxUsd: this.positionCapUsd(riskEquityUsd, SIZING_BAND.manualMaxPct),
      capWhy: this.capWhy(riskEquityUsd),
      enrich: this.scout.enrichStatus(),
      recheck: this.rechecks.counts(),
      prefilter: this.prefilterSnapshot(),
      appVersion: APP_VERSION,
      lastClientCrash: this.lastClientCrash,
      markLoop: this.markLoopView(),
      safetyChips: this.safetyChipList(),
      strategy: this.strategyCard(),
      perf: this.latency.view()
    };
  }

  private wire(): void {
    this.bus.on("scout.candidate", (token) => {
      const arrivedAt = Date.now();
      if (token.discoveredAt > 0) this.latency.record("sightingToCandidate", arrivedAt - token.discoveredAt);
      this.candidateAt.set(token.mint, arrivedAt);
      this.rawTape.markEnriched(token);
      const seen = this.sightings.get(token.mint);
      const prior = seen ? { priceUsd: seen.priceUsd, volume1hUsd: seen.volume1hUsd } : null;
      this.remember(token);
      this.pipeline.scouted += 1;
      this.applyMark(token.mint, token.priceUsd, {
        feed: token.priceFeed,
        pairAddress: token.priceFeed === "dexscreener" ? token.pairAddress : undefined,
        dex: token.dex
      });
      this.log({
        stage: "scout",
        kind: "info",
        mint: token.mint,
        symbol: token.symbol,
        message: `Scout found ${token.symbol} on ${token.source}. Mark ${price(token.priceUsd)}, 1h volume ${money(token.volume1hUsd)}${scoutExtras(token)}.`,
        detail: token.source
      });
      this.tape?.note(token.mint, token.source);
      if (!(token.priceUsd > 0) && token.source === "pumpfun") this.queueCurvePrice(token.mint);
      const job = this.runFilter(token, prior);
      this.track(job);
    });

    this.bus.on("filter.result", (result) => {
      if (result.decision === "reject") {
        this.pipeline.filteredKill += 1;
        for (const reason of result.reasons) {
          this.killReasons[reason.code] = (this.killReasons[reason.code] ?? 0) + 1;
        }
        this.noteUnverified(result.reasons);
        const primary = result.reasons[0];
        if (primary) {
          noteKill(this.advisor.memory, primary.code);
          this.advisor.save();
        }
        this.log(
          {
            stage: "filter",
            kind: "reject",
            mint: result.token.mint,
            symbol: result.token.symbol,
            code: primary?.code,
            message: `Filter killed ${result.token.symbol}. ${primary?.message ?? "Rejected."}`,
            detail: result.reasons.map((r) => r.code).join(", ")
          },
          { reasons: result.reasons, checks: result.checks }
        );
        return;
      }
      this.pipeline.filteredPass += 1;
      notePass(this.advisor.memory);
      const lpUnlocked = result.flags?.includes("LP_UNLOCKED") === true;
      if (lpUnlocked) this.lpUnlockedMints.add(result.token.mint);
      this.log({
        stage: "filter",
        kind: "pass",
        mint: result.token.mint,
        symbol: result.token.symbol,
        code: lpUnlocked ? "LP_UNLOCKED" : undefined,
        message: lpUnlocked
          ? `Filter passed ${result.token.symbol} with flag LP unlocked. Mint revoked, holders and volume inside the lines, no dev rug. The pool can still be pulled. Analyst still scores it.`
          : `Filter passed ${result.token.symbol}. Mint revoked, LP locked, holders and volume inside the hard lines.`
      });
      const report = scoreToken(result.token, this.config.rules);
      this.bus.emit("analyst.report", report);
    });

    this.bus.on("analyst.report", (report) => {
      this.analystScores.set(report.token.mint, report.score);
      if (report.decision === "reject") {
        this.pipeline.analystReject += 1;
        this.weakSurvivor = {
          mint: report.token.mint,
          symbol: report.token.symbol,
          score: report.score,
          sample: sampleOf(report.token, report.score)
        };
        this.publishAdvice(this.buildAdvice());
        this.log(
          {
            stage: "analyst",
            kind: "reject",
            mint: report.token.mint,
            symbol: report.token.symbol,
            code: "SCORE_BELOW_THRESHOLD",
            message: `Analyst scored ${report.token.symbol} ${report.score.toFixed(2)}. No trade. ${report.reason?.message ?? ""}`,
            detail: report.score.toFixed(2)
          },
          { breakdown: report.breakdown }
        );
        return;
      }
      this.pipeline.analystTrade += 1;
      this.log(
        {
          stage: "analyst",
          kind: "pass",
          mint: report.token.mint,
          symbol: report.token.symbol,
          message: `Analyst scored ${report.token.symbol} ${report.score.toFixed(2)}. Handing to ${this.strategy.settings.enabled ? "the trading engine" : "Executor"}.`,
          detail: report.score.toFixed(2)
        },
        { breakdown: report.breakdown }
      );
      const candidateAt = this.candidateAt.get(report.token.mint);
      if (candidateAt != null) this.latency.record("candidateToDecision", Date.now() - candidateAt);
      // Engine on: the coin is watched for a Launch or Momentum signal instead of being bought on sight.
      if (this.strategy.settings.enabled) {
        this.watchForSignal(report);
        return;
      }
      const job = this.buyIfSafe(report);
      this.track(job);
    });

    this.bus.on("market.tick", (tick) => {
      this.pricer.noteTick(tick.mint);
      const held = this.book.positions.get(tick.mint) ?? this.liveBook?.positions.get(tick.mint);
      const heldBook = this.book.positions.has(tick.mint) ? this.book : this.liveBook;
      const lastGood = held && heldBook ? heldBook.price(tick.mint, held.entryPrice) : undefined;
      const anchor = held ? entryAnchor(held.entryPrice, lastGood ?? held.entryPrice) : undefined;
      // A rejected outlier must not become the crash-guard high and block the next buy.
      if (!markUnusable(tick.priceUsd) && !(anchor != null && outlierReason(anchor, tick.priceUsd))) {
        this.momentum.note(tick.mint, tick.priceUsd, tick.liquidityUsd, tick.at);
        if (this.strategy.holding(tick.mint)) {
          this.recorder.tick(tick.at, tick.mint, this.sightings.get(tick.mint)?.symbol ?? held?.symbol ?? "", tick.priceUsd, tick.liquidityUsd ?? null);
        }
        this.strategy.onTick(tick.mint, tick.priceUsd, tick.at, tick.liquidityUsd);
      }
      this.noteFeedQuote(tick.mint, tick.feed, tick.priceUsd, tick.at);
      this.applyMark(tick.mint, tick.priceUsd, {
        feed: tick.feed,
        pairAddress: tick.pairAddress,
        dex: tick.dex,
        liquidityUsd: tick.liquidityUsd,
        quoteUsd: tick.quoteUsd
      });
    });

    this.bus.on("risk.exit", (order) => {
      const job = this.sell(order);
      this.track(job);
    });
  }

  private async runFilter(
    token: CandidateToken,
    prior: { priceUsd: number; volume1hUsd: number } | null
  ): Promise<void> {
    if (needsFilterRugcheck(token, this.config.rules.minVolume1hUsd, this.maxDevHoldingPct)) {
      token = await applyRugcheck(token, { rugcheckUrl: this.config.rugcheckUrl, fetchImpl: this.net.fetchAt(1) });
    }
    const rug = await this.rugs.lookup(token.devWallet);
    const result = evaluateFilter(token, rug, this.config.rules, {
      allowUnlockedLp: this.allowUnlockedLp,
      minLiquidityUsd: this.minLiquidityUsd,
      minAgeSeconds: this.minTokenAgeMin > 0 ? this.minTokenAgeMin * 60 : 0,
      maxAgeSeconds: this.maxTokenAgeMin > 0 ? this.maxTokenAgeMin * 60 : 0,
      minHolderCount: this.minHolderCount,
      maxDevHoldingPct: this.maxDevHoldingPct
    });
    if (result.decision === "reject") {
      this.considerNearMiss(result, prior);
      const freeOnly =
        result.reasons.length > 0 &&
        result.reasons.every((reason) => reason.code === "VOLUME_TOO_LOW" || reason.code === "LIQUIDITY_TOO_THIN" || reason.code === "TOKEN_TOO_NEW");
      if (freeOnly) this.killMemory.note(result.token.mint, false, Date.now(), result.token.volume1hUsd);
      else if (!recheckEligible(result.token, result.reasons)) this.killMemory.note(result.token.mint, true, Date.now(), result.token.volume1hUsd);
      if (!freeOnly && this.rechecks.offer(result.token, result.reasons, Date.now())) this.armRechecks();
    }
    this.bus.emit("filter.result", result);
  }

  /** Next soft-gate recheck. Shares the enrich limiter inside recheckToken. */
  private armRechecks(now = Date.now()): void {
    if (this.recheckTimer) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }
    const wait = this.rechecks.msUntilNext(now);
    if (wait == null) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      void this.drainRechecks();
    }, wait);
    this.recheckTimer.unref?.();
  }

  private async drainRechecks(): Promise<void> {
    if (this.recheckBusy) return;
    this.recheckBusy = true;
    try {
      const due = this.rechecks.due(Date.now());
      for (const token of due) {
        try {
          const rpc = this.config.rpcUrl && !isHeliusUrl(this.config.rpcUrl) ? this.config.rpcUrl : undefined;
          const next = await recheckToken(token, { rpcUrl: rpc, fetchImpl: this.net.fetchAt(1), holderPagesMax: 0 });
          this.rechecks.noteRan();
          this.scout.publish(next);
        } catch (err) {
          if (err instanceof EnrichDeferred) this.rechecks.pushBack(token, Date.now() + err.retryMs);
          else this.rechecks.noteRan();
        }
      }
    } finally {
      this.recheckBusy = false;
      this.armRechecks();
    }
  }

  /**
   * A slightly-high top-10 or slightly-low volume print can be a card when price and
   * volume are both rising and Analyst would trade it. The card does not buy.
   * Mint authority and a dev rug never qualify, and this does not emit analyst.report.
   */
  private considerNearMiss(
    result: DeskEvents["filter.result"],
    prior: { priceUsd: number; volume1hUsd: number } | null
  ): void {
    const token = result.token;
    const gate = classifyNearMiss(result, this.config.rules);
    if (!gate || !prior) return;
    if (this.nearMissCards.has(token.mint) || this.surfacedNearMiss.has(token.mint)) return;
    if (this.book.positions.has(token.mint) || this.opening.has(token.mint)) return;
    if (!(token.priceUsd > prior.priceUsd && token.volume1hUsd > prior.volume1hUsd)) return;
    const report = scoreToken(token, this.config.rules);
    this.analystScores.set(token.mint, report.score);
    if (report.decision !== "trade") return;
    const text = `Near miss — your call. ${token.symbol} scored ${report.score.toFixed(2)} but Filter killed it on ${gate.code}. ${gate.message} Price and volume are rising. Not an auto-buy.`;
    this.nearMissCards.set(token.mint, {
      stance: "near-miss",
      symbol: token.symbol,
      mint: token.mint,
      text,
      code: gate.code,
      score: report.score
    });
    this.surfacedNearMiss.add(token.mint);
    noteNearMissSurface(this.advisor.memory);
    this.advisor.save();
    this.publishAdvice(this.buildAdvice());
  }

  private async buy(report: AnalystReport, order?: { sizeUsd: number; tag: string; meta: StrategyMeta }): Promise<ManualBuyResult | ManualBuyRefusal> {
    if (order) return this.executeBuy(report.token, report.score, order.sizeUsd, "analyst", false, { tag: order.tag, strategy: order.meta });
    return this.executeBuy(report.token, report.score, this.positionSizeUsd ?? undefined, "analyst");
  }

  private async executeBuy(
    token: CandidateToken,
    score: number,
    requestedUsd: number | undefined,
    source: "analyst" | "manual",
    ignoreCooldown = false,
    extra: { confirmSize?: boolean; tag?: string; book?: BookKind; strategy?: StrategyMeta; warning?: string; engineLive?: boolean } = {}
  ): Promise<ManualBuyResult | ManualBuyRefusal> {
    const epoch = this.bookEpoch;
    // AI auto-buys are paper. A request that names the live book is refused and sends nothing.
    // The one exception is the engine's live variant: the operator set it live on purpose, and the
    // buy carries that variant's exit rules.
    const engineLive =
      source === "analyst" && extra.book === "live" && extra.engineLive === true && extra.strategy != null && extra.strategy.variant === this.strategy.settings.liveVariant;
    if (source === "analyst" && extra.book === "live" && !engineLive) {
      const error = "AI auto-buys stay on the paper book. A live buy was refused and nothing was sent.";
      this.log({ stage: "executor", kind: "reject", mint: token.mint, symbol: token.symbol, code: "LIVE_AI_BLOCKED", message: error });
      return { ok: false, error, code: "LIVE_AI_BLOCKED" };
    }
    const kind: BookKind = engineLive ? "live" : source === "analyst" ? "paper" : (extra.book ?? "paper");
    if (kind === "live" && !this.liveBook) {
      const error = this.liveNotArmedMessage();
      return { ok: false, error, code: "LIVE_NOT_ARMED" };
    }
    const book = this.bk(kind);
    const key = bookKey(kind, token.mint);
    const isLive = kind === "live";
    // A confirmed manual buy may use up to 100% of the book. Everything else uses the saved cap (≤ 50%).
    // v13.5 live: the wallet's USDC is the book and the live per-trade size is the limit.
    // An engine buy asks for its own trade size, up to the auto ceiling (never the manual 100%).
    const capPct =
      isLive || (source === "manual" && extra.confirmSize === true)
        ? SIZING_BAND.manualMaxPct
        : extra.strategy && source === "analyst"
          ? SIZING_BAND.autoMaxPct
          : Math.min(this.config.rules.maxPositionPct, SIZING_BAND.autoMaxPct);
    if (isLive) {
      const pending = await this.blockIfUnconfirmed(token.mint, "buy", token.symbol);
      if (pending) return pending;
      if (!this.operatorReady) {
        const error = "Live buy refused. operatorReady is false. Mark the checklist on purpose before a live buy is sent. Nothing was sent, and no paper trade was placed instead.";
        this.pipeline.executorSkips += 1;
        this.log({ stage: "executor", kind: "reject", mint: token.mint, symbol: token.symbol, code: "OPERATOR_NOT_READY", message: error });
        return { ok: false, error, code: "OPERATOR_NOT_READY" };
      }
      // v13.5: every live buy uses the live size. A larger request (e.g. the phone's
      // paper one-tap amount) is cut to it. Never the paper position size.
      requestedUsd = requestedUsd != null && requestedUsd > 0 ? Math.min(requestedUsd, this.liveTradeUsd) : this.liveTradeUsd;
      const ready = await this.liveBuyReady(requestedUsd, usesPumpRoute(token));
      if (!ready.ok) {
        this.pipeline.executorSkips += 1;
        this.bus.emit("executor.skip", { token, reason: { code: ready.code, message: ready.error }, score });
        this.log({
          stage: "executor",
          kind: "reject",
          mint: token.mint,
          symbol: token.symbol,
          code: ready.code,
          message: `Executor skipped live ${token.symbol}. ${ready.error}`
        });
        return { ok: false, error: ready.error, code: ready.code };
      }
    }
    if (source === "analyst") {
      const gate = autoBuyBlock({
        autoBuy: this.autoBuy,
        maxTradesPerHour: this.maxTradesPerHour,
        // v13.44 an engine live buy is limited by live buys only. Paper engine buys used to fill the hourly limit first.
        buysLastHour: this.buysInLastHour(engineLive),
        // Paper losses sit in this sum. They pause paper auto-buys only. An engine live entry keeps the $5 closed-live pause.
        dailyMaxLossUsd: engineLive ? 0 : this.dailyMaxLossUsd,
        lossSoFarUsd: this.lossSoFarUsd()
      });
      if (!gate.ok) {
        this.pipeline.executorSkips += 1;
        this.bus.emit("executor.skip", { token, reason: gate.reason, score });
        this.log({
          stage: "executor",
          kind: "reject",
          mint: token.mint,
          symbol: token.symbol,
          code: gate.reason.code,
          message: `Executor skipped ${token.symbol}. ${gate.reason.message}`
        });
        return { ok: false, error: gate.reason.message, code: gate.reason.code };
      }
    }
    const openingHere = [...this.opening].filter((k) => k.startsWith(LIVE_KEY) === isLive).length;
    const openCount = [...book.positions.values()].filter((pos) => !pos.closing).length + openingHere;
    if (!book.positions.has(token.mint) && !this.opening.has(key) && openCount >= this.maxOpenPositions) {
      const reason = {
        code: "MAX_OPEN_POSITIONS" as const,
        message: `Already ${openCount} open. The desk allows ${this.maxOpenPositions}. Close one before another buy.`
      };
      this.pipeline.executorSkips += 1;
      this.bus.emit("executor.skip", { token, reason, score });
      this.log({
        stage: "executor",
        kind: "reject",
        mint: token.mint,
        symbol: token.symbol,
        code: reason.code,
        message: `Executor skipped ${token.symbol}. ${reason.message}`
      });
      return { ok: false, error: reason.message, code: reason.code };
    }
    let depthTried: string[] = [];
    if (!(token.liquidityUsd > 0) || !Number.isFinite(token.liquidityUsd)) {
      const depth = await this.ensureDepth(token);
      token = depth.token;
      depthTried = depth.tried;
    }
    const plan = planOrder({
      equityUsd: book.equity(),
      cashUsd: book.cashUsd,
      rules: this.config.rules,
      token,
      hasPosition: book.positions.has(token.mint) || this.opening.has(key),
      cooldownUntil: this.cooldowns.get(key) ?? null,
      now: Date.now(),
      ignoreCooldown: source === "manual" && ignoreCooldown,
      ceilingPct: capPct,
      // Live: the per-trade size and the wallet's USDC are the limits; paper exposure caps do not apply.
      exposureRoomUsd: isLive ? undefined : this.exposureRoomUsd()
    });
    if (!plan.ok) {
      this.pipeline.executorSkips += 1;
      this.bus.emit("executor.skip", { token, reason: plan.reason, score });
      this.log({
        stage: "executor",
        kind: "reject",
        mint: token.mint,
        symbol: token.symbol,
        code: plan.reason.code,
        message: `Executor skipped ${token.symbol}. ${plan.reason.message}`,
        detail: score.toFixed(2)
      });
      return { ok: false, error: plan.reason.message, code: plan.reason.code };
    }
    const preferred =
      !isLive && source === "manual" && requestedUsd == null && this.defaultBuyUsd != null ? Math.min(this.defaultBuyUsd, plan.sizeUsd) : requestedUsd;
    const sized = resolveManualSize(plan.sizeUsd, preferred);
    if (!sized.ok) {
      this.pipeline.executorSkips += 1;
      this.bus.emit("executor.skip", { token, reason: sized.reason, score });
      this.log({
        stage: "executor",
        kind: "reject",
        mint: token.mint,
        symbol: token.symbol,
        code: sized.reason.code,
        message: `Executor skipped ${token.symbol}. ${sized.reason.message}`,
        detail: score.toFixed(2)
      });
      return { ok: false, error: sized.reason.message, code: sized.reason.code };
    }

    const pctLabel = (capPct * 100).toFixed(0);
    // v13.3 pre-buy crash guard (auto and one-tap alike): skip a coin dumping or losing its pool right now.
    const crash = this.momentum.check(token.mint, token.priceUsd, token.liquidityUsd);
    if (crash) {
      this.pipeline.executorSkips += 1;
      this.bus.emit("executor.skip", { token, reason: { code: crash.code, message: crash.message }, score });
      this.log({
        stage: "executor",
        kind: "reject",
        mint: token.mint,
        symbol: token.symbol,
        code: crash.code,
        message: `Executor skipped ${token.symbol}. ${crash.message}`
      });
      return { ok: false, error: crash.message, code: crash.code };
    }
    const exitGate = exitImpactAllowed(sized.sizeUsd, token.liquidityUsd, this.config.rules.maxEntrySlippage, this.maxExitSlippage);
    if (!exitGate.ok && !Number.isFinite(exitGate.slippage)) {
      // v13.8: no readable pool depth. Still fail closed, in plain words (never "cost unknown, more than").
      exitGate.message =
        `Can't measure what selling ${token.symbol} would cost: no readable pool depth yet` +
        (depthTried.length ? ` (${depthTried.join("; ")})` : "") +
        ". Buy refused for safety.";
    }
    if (!exitGate.ok) {
      this.pipeline.executorSkips += 1;
      this.bus.emit("executor.skip", { token, reason: { code: "EXIT_IMPACT", message: exitGate.message }, score });
      this.log({
        stage: "executor",
        kind: "reject",
        mint: token.mint,
        symbol: token.symbol,
        code: "EXIT_IMPACT",
        message: `Executor skipped ${token.symbol}. ${exitGate.message}`
      });
      return { ok: false, error: exitGate.message, code: "EXIT_IMPACT" };
    }
    this.opening.add(key);
    try {
      if (isLive) {
        try {
          // The operator may have turned the engine or its live variant off while this buy waited on wallet reads.
          if (engineLive) {
            const still = this.strategy.settings.liveVariant === extra.strategy?.variant ? this.liveEngineBlock() : "The live variant was turned off.";
            if (still) {
              const message = `Engine live buy cancelled before it was sent. ${still}`;
              this.pipeline.executorSkips += 1;
              this.log({ stage: "executor", kind: "reject", mint: token.mint, symbol: token.symbol, code: "ENGINE_LIVE_PAUSED", message });
              return { ok: false, error: message, code: "ENGINE_LIVE_PAUSED" };
            }
          }
          const live = await this.runLiveSwap({
            side: "buy",
            mint: token.mint,
            sizeUsd: sized.sizeUsd,
            decimals: token.decimals,
            markPriceUsd: token.priceUsd,
            dex: token.dex,
            priceFeed: token.priceFeed
          });
          this.noteLiveSpend(sized.sizeUsd);
          void this.refreshWallet();
          if (!(live.qty > 0) || !(live.fillPriceUsd > 0) || !Number.isFinite(live.qty)) {
            const message = "Live quote was not a usable fill. Buy refused.";
            this.skipLive(token, score, message);
            return { ok: false, error: message, code: "LIVE_SWAP_FAILED" };
          }
          const liveGate = entryPriceAllowed(token.priceUsd, live.fillPriceUsd, this.config.rules.maxEntrySlippage);
          if (!liveGate.ok) {
            this.pipeline.executorSkips += 1;
            this.log({
              stage: "executor",
              kind: "reject",
              mint: token.mint,
              symbol: token.symbol,
              code: "ENTRY_SLIPPAGE",
              message: `Executor skipped ${token.symbol}. ${liveGate.message}`
            });
            return { ok: false, error: liveGate.message, code: "ENTRY_SLIPPAGE" };
          }
          const reason =
            source === "manual"
              ? sized.clampedFrom != null
                ? `Manual live buy $${sized.sizeUsd.toFixed(2)} (requested $${sized.clampedFrom.toFixed(2)} cut to the $${plan.capUsd.toFixed(2)} cap).`
                : `Manual live buy $${sized.sizeUsd.toFixed(2)} of the $${plan.capUsd.toFixed(2)} cap.`
              : `Engine live buy (${extra.strategy?.variant ?? "engine"}) at the live size $${sized.sizeUsd.toFixed(2)}.`;
          this.applyBuy(
            {
              id: randomUUID(),
              mint: token.mint,
              symbol: token.symbol,
              side: "buy",
              qty: live.qty,
              priceUsd: live.fillPriceUsd,
              markUsd: token.priceUsd,
              slippage: live.slippage,
              notionalUsd: sized.sizeUsd,
              feeUsd: live.feeUsd,
              mode: "live",
              txSignature: live.signature,
              at: Date.now(),
              reason,
              score
            },
            token,
            score,
            source,
            capPct,
            extra.tag,
            "live",
            extra.strategy
          );
          return this.bought(token, sized, "live", extra.warning);
        } catch (err) {
          if (err instanceof LiveSubmitError) {
            if (err.submitState === "submitted_unknown") {
              this.rememberUnconfirmed({ mint: token.mint, symbol: token.symbol, side: "buy", signature: err.signature, at: Date.now(), message: err.message });
            }
            this.skipLive(token, score, err.message);
            return { ok: false, error: err.message, code: err.code, signature: err.signature ?? undefined, submitState: err.submitState };
          }
          const message = err instanceof Error ? err.message : String(err);
          const code = /entry slippage/i.test(message) ? ("ENTRY_SLIPPAGE" as const) : ("LIVE_SWAP_FAILED" as const);
          this.skipLive(token, score, message);
          return { ok: false, error: message, code };
        }
      }

      if (epoch !== this.bookEpoch) {
        return { ok: false, error: "Paper book was reset before the fill. Buy dropped.", code: "BOOK_RESET" };
      }
      const quote = quotePaperBuy(token.priceUsd, sized.sizeUsd, token.liquidityUsd, this.config.rules.maxEntrySlippage);
      if (!quote.ok) {
        this.pipeline.executorSkips += 1;
        this.bus.emit("executor.skip", {
          token,
          reason: { code: "ENTRY_SLIPPAGE", message: quote.message },
          score
        });
        this.log({
          stage: "executor",
          kind: "reject",
          mint: token.mint,
          symbol: token.symbol,
          code: "ENTRY_SLIPPAGE",
          message: `Executor skipped ${token.symbol}. ${quote.message}`
        });
        return { ok: false, error: quote.message, code: "ENTRY_SLIPPAGE" };
      }
      const reason =
        source === "manual"
          ? sized.clampedFrom != null
            ? `Manual paper buy $${sized.sizeUsd.toFixed(2)} (requested $${sized.clampedFrom.toFixed(2)} cut to the ${pctLabel}% cap).`
            : `Manual paper buy $${sized.sizeUsd.toFixed(2)} at the ${pctLabel}% cap (planned $${plan.sizeUsd.toFixed(2)}).`
          : `Paper buy sized at the ${pctLabel}% cap.`;
      this.applyBuy(
        {
          id: randomUUID(),
          mint: token.mint,
          symbol: token.symbol,
          side: "buy",
          qty: quote.qty,
          priceUsd: quote.fillPrice,
          markUsd: token.priceUsd,
          slippage: quote.slippage,
          notionalUsd: sized.sizeUsd,
          feeUsd: quote.feeUsd,
          mode: "paper",
          at: Date.now(),
          reason,
          score
        },
        token,
        score,
        source,
        capPct,
        extra.tag,
        "paper",
        extra.strategy
      );
      return this.bought(token, sized, "paper", extra.warning);
    } finally {
      this.opening.delete(key);
    }
  }

  private applyBuy(
    fill: Fill,
    token: CandidateToken,
    score: number,
    entry: "manual" | "analyst",
    capPct: number = this.config.rules.maxPositionPct,
    tag?: string,
    kind: BookKind = "paper",
    strategy?: StrategyMeta
  ): void {
    const book = this.bk(kind);
    if (!(capPct > 0) || fill.notionalUsd > book.equity() * Math.min(capPct, SIZING_BAND.manualMaxPct) + 0.02) {
      throw new Error(`Position cap breached on ${token.symbol}`);
    }
    book.cashUsd = roundUsd(book.cashUsd - fill.notionalUsd);
    const position: Position = {
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      qty: fill.qty,
      entryPrice: fill.priceUsd,
      costUsd: fill.notionalUsd,
      openedAt: fill.at,
      peakPrice: Math.max(fill.priceUsd, fill.markUsd),
      trailArmed: false,
      score,
      source: token.source,
      entry,
      lpUnlocked: this.lpUnlockedMints.has(token.mint),
      liquidityUsd: token.liquidityUsd,
      decimals: token.decimals,
      priceFeed: token.priceFeed,
      pairAddress: token.priceFeed === "dexscreener" || token.priceFeed === "chain" ? token.pairAddress : undefined,
      dex: token.dex,
      tradeId: fill.id,
      ...(tag ? { tag } : entry === "manual" ? { tag: "manual" } : {}),
      ...(Number.isFinite(fill.slippage) ? { entrySlippage: fill.slippage } : {}),
      // Stop distance is from this mark, not the slipped fill. Live trail uses the same anchor.
      ...(fill.markUsd > 0 ? { entryMark: fill.markUsd, markPeak: fill.markUsd } : {}),
      ...(fill.mode === "live" ? { live: true } : {}),
      ...(strategy ? { strategy: { ...strategy } } : {})
    };
    book.positions.set(token.mint, position);
    this.noRoute.delete(bookKey(kind, token.mint));
    this.collapseStreak.delete(bookKey(kind, token.mint));
    book.noteMark(token.mint, fill.markUsd > 0 ? fill.markUsd : fill.priceUsd, fill.at);
    const sample = sampleOf(token, score);
    if (this.surfacedNearMiss.has(token.mint)) {
      sample.nearMiss = true;
      noteNearMissTaken(this.advisor.memory);
      this.surfacedNearMiss.delete(token.mint);
    }
    this.nearMissCards.delete(token.mint);
    noteEntry(this.advisor.memory, token.mint, token.symbol, sample);
    this.advisor.save();
    // Record the spot. Review waits for the next tick so a fill that is already through
    // the hard stop is closed by that tick, not erased inside the buy itself.
    book.mark(token.mint, fill.markUsd);
    this.pipeline.fills += 1;
    this.store.openTrade({
      id: fill.id,
      mint: fill.mint,
      symbol: fill.symbol,
      openedAt: fill.at,
      costUsd: fill.notionalUsd,
      score,
      mode: fill.mode
    });
    this.bus.emit("executor.fill", fill);
    this.log(
      {
        stage: "executor",
        kind: "fill",
        mint: fill.mint,
        symbol: fill.symbol,
        message: `Executor filled ${fill.symbol} buy ${money(fill.notionalUsd)} @ ${price(fill.priceUsd)} (${fill.mode}, slip ${(fill.slippage * 100).toFixed(2)}%).`,
        detail: money(fill.notionalUsd)
      },
      fill
    );
    this.publishAdvice(this.buildAdvice());
    this.persist();
    this.markEquity(true);
  }

  private async sell(order: ExitOrder): Promise<void> {
    const kind: BookKind = order.book === "live" ? "live" : "paper";
    const pos = kind === "live" ? this.liveBook?.positions.get(order.mint) : this.book.positions.get(order.mint);
    if (!pos) return;
    try {
      if (kind === "live") {
        const pending = await this.blockIfUnconfirmed(order.mint, "sell", pos.symbol);
        if (pending) {
          pos.closing = false;
          return;
        }
        const recent = this.recentLiveFill(pos);
        const read = await this.liveBalance("exit", false, recent ? RECENT_FILL_BALANCE_MS : LIVE_BALANCE_WAIT_MS);
        if ((!read || read.error != null || read.sol == null) && !recent) {
          throw new Error(`Wallet balance not current${read?.error ? ` (${read.error})` : ""}. Live sell refused. Nothing was sent.`);
        }
        if (this.sellUnverified(pos, order.markPrice)) throw new Error(UNVERIFIED_SELL);
        const live = await this.runLiveSwap({
          side: "sell",
          mint: order.mint,
          qty: pos.qty,
          decimals: pos.decimals,
          markPriceUsd: order.markPrice,
          dex: pos.dex,
          priceFeed: pos.priceFeed,
          exit: true,
          confirmedFill: recent,
          sellAnyway: order.reason.code === "MANUAL_CLOSE" && order.sellAnyway === true
        });
        void this.refreshWallet();
        this.applySell(pos, {
          id: randomUUID(),
          mint: pos.mint,
          symbol: pos.symbol,
          side: "sell",
          qty: pos.qty,
          priceUsd: live.fillPriceUsd,
          markUsd: order.markPrice,
          slippage: live.slippage,
          notionalUsd: live.notionalUsd,
          feeUsd: live.feeUsd,
          mode: "live",
          txSignature: live.signature,
          at: Date.now(),
          reason: order.reason.message,
          code: order.reason.code,
          score: pos.score
        }, order);
        return;
      }
      const mark = this.exitMark(pos, order.markPrice, kind);
      if (!(mark > 0) || this.sellUnverified(pos, mark) || this.sellUnverified(pos, order.markPrice)) throw new GateError(UNVERIFIED_SELL, "UNVERIFIED_SELL");
      const liquidity = this.markLiquidity.get(pos.mint) ?? pos.liquidityUsd;
      const manual = order.reason.code === "MANUAL_CLOSE";
      const impact = this.paperExitImpact(pos, mark, pos.qty, liquidity, manual, manual && order.sellAnyway === true);
      if (impact) throw new GateError(impact, impact === POOL_DRAINED_MESSAGE ? "NO_SELL_ROUTE" : "EXIT_IMPACT");
      const quote = quotePaperSell(mark, pos.qty, liquidity);
      this.applySell(
        pos,
        {
          id: randomUUID(),
          mint: pos.mint,
          symbol: pos.symbol,
          side: "sell",
          qty: pos.qty,
          priceUsd: quote.fillPrice,
          markUsd: mark,
          slippage: quote.slippage,
          notionalUsd: quote.notionalUsd,
          feeUsd: quote.feeUsd,
          mode: "paper",
          at: Date.now(),
          reason: order.reason.message,
          code: order.reason.code,
          score: pos.score
        },
        order,
        quote.proceedsUsd ?? 0
      );
    } catch (err) {
      pos.closing = false;
      if (err instanceof LiveSubmitError && err.submitState === "submitted_unknown") {
        this.rememberUnconfirmed({ mint: pos.mint, symbol: pos.symbol, side: "sell", signature: err.signature, at: Date.now(), message: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof LiveSubmitError ? err.code : err instanceof GateError ? err.code : "LIVE_SWAP_FAILED";
      this.closeRefusals.set(bookKey(kind, pos.mint), { code, error: message });
      this.log({
        stage: "executor",
        kind: "reject",
        mint: pos.mint,
        symbol: pos.symbol,
        code,
        message: `Executor could not close ${pos.symbol}. ${message}`
      });
      // v13.39: no route is not a write-off. The tokens stay in the wallet; a later retry can fill.
      // A healthy cached quote is not residual value. Only a quote we already know is drained counts.
      if (kind === "live" && isNoSellRouteMessage(message)) {
        const cached = this.lastQuoteUsd.get(pos.mint);
        const quoteUsd = cached != null && Number.isFinite(cached) && cached <= QUOTE_SIDE_GONE_USD ? cached : 0;
        const mid = pos.qty * this.bk(kind).price(pos.mint, pos.entryPrice);
        this.noteLiquidityGone(kind, pos.mint, residualExitUsd({ quoteUsd, midValueUsd: mid }), "no_routes");
      }
    }
  }

  private applySell(pos: Position, fill: Fill, order: ExitOrder, proceeds?: number): void {
    const book = this.bk(order.book === "live" ? "live" : "paper");
    if (!book.positions.has(pos.mint)) return;
    this.clearLiquidityGone(order.book === "live" ? "live" : "paper", pos.mint);
    this.noRoute.delete(bookKey(order.book === "live" ? "live" : "paper", pos.mint));
    this.collapseStreak.delete(bookKey(order.book === "live" ? "live" : "paper", pos.mint));
    const rawProceeds = proceeds ?? roundUsd(fill.notionalUsd - fill.feeUsd);
    const proceedsUsd = typeof rawProceeds === "number" && Number.isFinite(rawProceeds) && rawProceeds > 0 ? roundUsd(rawProceeds) : 0;
    if (fill.mode === "paper" && this.paperProceedsUnverified(pos, proceedsUsd, fill.priceUsd, pos.costUsd)) {
      throw new Error(UNVERIFIED_SELL);
    }
    const fillPrice = typeof fill.priceUsd === "number" && Number.isFinite(fill.priceUsd) && fill.priceUsd > 0 ? fill.priceUsd : 0;
    assertNonNegativeFinite("proceedsUsd", proceedsUsd);
    assertNonNegativeFinite("fillPrice", fillPrice);
    const booked: Fill = { ...fill, priceUsd: fillPrice };
    book.cashUsd = roundUsd(book.cashUsd + proceedsUsd);
    book.positions.delete(pos.mint);
    book.dropSeries(pos.mint);
    const pnlUsd = roundUsd(proceedsUsd - pos.costUsd);
    const pnlPct = pos.costUsd > 0 ? pnlUsd / pos.costUsd : order.pnlPct;
    const label = classifyStopExit({
      code: order.reason.code,
      entryPrice: pos.entryPrice,
      basisPrice: pos.entryMark != null && pos.entryMark > 0 ? pos.entryMark : pos.entryPrice,
      stopPct: this.config.rules.stopLossPct,
      fillPrice,
      triggerPrice: order.markPrice
    });
    const exitCode = label.code;
    const stopPrice = label.stopPrice;
    const closed: ClosedTrade = {
      id: pos.tradeId,
      mint: pos.mint,
      symbol: pos.symbol,
      openedAt: pos.openedAt,
      closedAt: booked.at,
      costUsd: pos.costUsd,
      proceedsUsd,
      pnlUsd,
      pnlPct,
      exitCode,
      score: pos.score,
      mode: booked.mode,
      entryPrice: pos.entryPrice,
      exitPrice: fillPrice,
      ...(stopPrice > 0 ? { stopPrice } : {}),
      ...(Number.isFinite(order.markPrice) && order.markPrice > 0 ? { triggerPrice: order.markPrice } : {})
    };
    const vsEntry = (p: number) => (pos.entryPrice > 0 ? ` (${signedPctText(p / pos.entryPrice - 1)})` : "");
    const compared =
      exitCode === "GAP_RUG"
        ? `Gap/${label.rug ? "rug" : "gap"}: stop line ${price(stopPrice)} (−${pctText(this.config.rules.stopLossPct)}), trigger mark ${price(order.markPrice)}${vsEntry(order.markPrice)}, true fill ${price(fillPrice)}${vsEntry(fillPrice)}. The price moved past the stop between marks; a stop cannot fill better than the market.`
        : `Stop trigger ${price(stopPrice)} vs fill ${price(fillPrice)}.`;
    this.store.closeTrade(closed);
    const lesson = noteOutcome(this.advisor.memory, pos.mint, pnlPct, pnlPct > 0);
    this.advisor.save();
    if (lesson) {
      this.log({
        stage: "system",
        kind: "info",
        mint: pos.mint,
        symbol: pos.symbol,
        message: `Advisor remembered ${lesson}`
      });
    }
    this.pipeline.fills += 1;
    if (order.reason.code === "STOP_LOSS") this.pipeline.riskExits += 1;
    if (exitCode === "GAP_RUG") this.pipeline.gapExits = (this.pipeline.gapExits ?? 0) + 1;
    this.bus.emit("executor.fill", booked);
    this.log(
      {
        stage: "risk",
        kind: "exit",
        mint: pos.mint,
        symbol: pos.symbol,
        code: exitCode,
        message: `Risk ${exitVerb(exitCode)} ${pos.symbol}. ${order.reason.message} ${compared} Realized ${signed(pnlUsd)}.`,
        detail: signed(pnlUsd)
      },
      { ...closed, fill: booked }
    );
    this.log(
      {
        stage: "executor",
        kind: "fill",
        mint: pos.mint,
        symbol: pos.symbol,
        code: exitCode,
        message: `Executor filled ${pos.symbol} sell ${money(proceedsUsd)} @ ${price(fillPrice)} (${booked.mode}). ${compared}`,
        detail: money(proceedsUsd)
      },
      booked
    );
    this.persist();
    this.markEquity(true);
  }

  private review(mint: string, mark: number, kind: BookKind = "paper", shockConfirmed = false): void {
    const pos = kind === "live" ? this.liveBook?.positions.get(mint) : this.book.positions.get(mint);
    if (!pos || pos.closing) return;
    // A spike that no other feed confirms is not a trail or a stop. A drop still is.
    if (this.sellUnverified(pos, mark)) return;
    // The first absurd post-fill mark is not a rug. A second agreeing print still stops.
    if (this.holdAbsurdStop(pos, mark, kind, shockConfirmed)) return;
    // The hard stop applies to every position. The desk's own trails do not apply to an engine position:
    // its variant's stop, target and trail decide the rest.
    const view = assessPosition(pos, mark, this.config.rules, { trailExits: this.trailTakeProfit && !pos.strategy, liveTrailPct: this.liveTrailFor(pos) });
    const peakRose = view.peakPrice > pos.peakPrice || (view.markPeak != null && view.markPeak > (pos.markPeak ?? 0));
    const armChanged = view.trailArmed !== pos.trailArmed;
    pos.peakPrice = view.peakPrice;
    if (view.markPeak != null) pos.markPeak = view.markPeak;
    pos.trailArmed = view.trailArmed;
    if (view.action === "hold" || !view.code) {
      if (peakRose || armChanged) this.persist();
      // The hard stop above always goes first. The engine's exits only apply to positions it opened.
      if (pos.strategy) this.strategyExit(pos, mark, kind);
      return;
    }
    pos.closing = true;
    if (view.code === "STOP_LOSS" && this.config.rules.revengeCooldownMs > 0) {
      this.cooldowns.set(bookKey(kind, mint), Date.now() + this.config.rules.revengeCooldownMs);
      this.persist();
    }
    const order: ExitOrder = {
      mint: pos.mint,
      symbol: pos.symbol,
      qty: pos.qty,
      markPrice: mark,
      liquidityUsd: pos.liquidityUsd,
      pnlPct: view.pnlPct,
      score: pos.score,
      reason: { code: view.code, message: view.message },
      ...(kind === "live" ? { book: "live" as const } : {})
    };
    this.bus.emit("risk.exit", order);
  }

  private skipLive(token: CandidateToken, score: number, message: string): void {
    this.pipeline.executorSkips += 1;
    this.log({
      stage: "executor",
      kind: "reject",
      mint: token.mint,
      symbol: token.symbol,
      code: message.startsWith("LIVE_NOT_ARMED") ? "LIVE_NOT_ARMED" : "LIVE_SWAP_FAILED",
      message: `Executor skipped live ${token.symbol}. ${message}`,
      detail: score.toFixed(2)
    });
  }

  /**
   * Card-only. A collapsed mark, or a quote that came back with no pool.
   * Does not write the book, the stop, settings, or the ledger, and does not exit.
   */
  private deadHolding(pos: Position, kind: BookKind): boolean {
    const key = bookKey(kind, pos.mint);
    if (this.noRoute.has(key)) return true;
    const shown = this.displayMark(pos, kind);
    const collapsed = noteCollapsedSample(this.collapseStreak.get(key), markCollapsed(pos.entryPrice, shown.price), shown.at);
    if (collapsed) this.collapseStreak.set(key, collapsed);
    else this.collapseStreak.delete(key);
    if ((collapsed?.n ?? 0) >= DEAD_MARKS) return true;
    return (
      deadFromMarks({
        entryPrice: pos.entryPrice,
        qty: pos.qty,
        markPrice: shown.price,
        marks: this.bk(kind).points(pos.mint).map((point) => point.priceUsd)
      }) != null
    );
  }

  /**
   * Ask whether a held coin still has a sell quote. GET only. Nothing is signed or sent.
   * No route sets the same card note a failed sell would. A quote clears only that flag.
   */
  async probeSellRoutes(fetchImpl?: typeof fetch): Promise<void> {
    const quoteUrl = this.config.jupiterQuoteUrl;
    if (!quoteUrl || this.routeProbeBusy) return;
    this.routeProbeBusy = true;
    try {
      // Priority 0 shares the Jupiter price/quote bucket. A passed fetch is for tests.
      const fetchUsed = fetchImpl ?? this.net.fetchAt(0);
      const held: Array<{ kind: BookKind; pos: Position }> = [];
      for (const pos of this.book.positions.values()) held.push({ kind: "paper", pos });
      for (const pos of this.liveBook?.positions.values() ?? []) held.push({ kind: "live", pos });
      const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const seenMint = new Set<string>();
      for (const { pos } of held) {
        if (seenMint.has(pos.mint) || sellsOnPump(pos)) continue;
        const decimals = pos.decimals ?? 6;
        const atoms = Math.floor(pos.qty * 10 ** decimals);
        if (!(atoms > 0) || !Number.isFinite(atoms)) continue;
        seenMint.add(pos.mint);
        const verdict = await readSellRoute({
          quoteUrl,
          inputMint: pos.mint,
          outputMint: usdc,
          amount: String(atoms),
          fetchImpl: fetchUsed
        });
        const same = held.filter((row) => row.pos.mint === pos.mint && !sellsOnPump(row.pos));
        let applied = false;
        for (const row of same) {
          const book = row.kind === "live" ? this.liveBook : this.book;
          const key = bookKey(row.kind, row.pos.mint);
          if (book?.positions.get(row.pos.mint) !== row.pos) {
            this.noRoute.delete(key);
            continue;
          }
          if (verdict === "no_route") this.noRoute.add(key);
          else if (verdict === "route") this.noRoute.delete(key);
          applied = verdict === "no_route" || verdict === "route";
        }
        if (applied) this.bus.emit("position.mark", { mint: pos.mint, at: Date.now() });
      }
    } finally {
      this.routeProbeBusy = false;
    }
  }

  private view(pos: Position, kind: BookKind = "paper"): PositionView {
    const book = this.bk(kind);
    const shown = this.displayMark(pos, kind);
    const markPrice = shown.price;
    const marketValueUsd = pos.qty * markPrice;
    const pnlUsd = marketValueUsd - pos.costUsd;
    // The stop and peak shown are the risk book's, never moved by a display-only mark.
    const assessment = assessPosition(pos, book.price(pos.mint, pos.entryPrice), this.config.rules, { liveTrailPct: this.liveTrailFor(pos) });
    return {
      ...(kind === "live" ? { book: "live" as const } : {}),
      mint: pos.mint,
      symbol: pos.symbol,
      name: pos.name,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      markPrice,
      costUsd: pos.costUsd,
      marketValueUsd,
      pnlUsd,
      pnlPct: pos.entryPrice > 0 ? (markPrice - pos.entryPrice) / pos.entryPrice : 0,
      peakPrice: assessment.peakPrice,
      trailArmed: assessment.trailArmed,
      // An engine position sells at its own tighter stop first; show the line that actually fires.
      stopPrice: pos.strategy ? Math.max(assessment.stopPrice, strategyLinePrice(pos.entryPrice, pos.entryMark, pos.strategy)) : assessment.stopPrice,
      trailHintPrice: assessment.trailHintPrice,
      score: pos.score,
      source: pos.source,
      entry: pos.entry ?? "analyst",
      lpUnlocked: pos.lpUnlocked === true,
      markAgeMs: Math.max(0, Date.now() - shown.at),
      markAt: shown.at,
      markFeed: shown.feed,
      riskMarkAgeMs: Math.max(0, Date.now() - (book.markedAt(pos.mint) ?? pos.openedAt)),
      openedAt: pos.openedAt,
      ...(pos.tag ? { tag: pos.tag } : pos.entry === "manual" ? { tag: "manual" } : {}),
      ...this.cardChips(pos.mint),
      ...this.netFields(pos, kind, shown, markPrice),
      ...(this.liquidityGone.has(bookKey(kind, pos.mint)) || this.deadHolding(pos, kind) ? { liquidityNote: LIQUIDITY_GONE_NOTE } : {})
    };
  }

  /** After-slippage P&L for the card. A restored or stale mark stays blank. */
  private netFields(pos: Position, kind: BookKind, shown: { price: number; at: number }, markPrice: number): Pick<PositionView, "netPnlUsd" | "netPnlPct" | "exitSlippage" | "entrySlippage" | "marks"> {
    const book = this.bk(kind);
    const gone = this.liquidityGone.get(bookKey(kind, pos.mint));
    if (gone) {
      const netPnl = gone.residualUsd - pos.costUsd;
      return {
        netPnlUsd: roundUsd(netPnl),
        netPnlPct: pos.costUsd > 0 ? netPnl / pos.costUsd : 0,
        exitSlippage: 1,
        entrySlippage: Number.isFinite(pos.entrySlippage) ? pos.entrySlippage! : null,
        marks: book.points(pos.mint).map((p) => ({ t: p.t, priceUsd: p.priceUsd }))
      };
    }
    const fresh = this.freshMark(kind, pos.mint, shown.at);
    const net = fresh
      ? realizablePnl({
          markPrice,
          qty: pos.qty,
          costUsd: pos.costUsd,
          liquidityUsd: this.markLiquidity.get(pos.mint) ?? pos.liquidityUsd,
          markAt: shown.at,
          now: Date.now()
        })
      : null;
    return {
      netPnlUsd: net?.netPnlUsd ?? null,
      netPnlPct: net?.netPnlPct ?? null,
      exitSlippage: net?.exitSlippage ?? null,
      entrySlippage: Number.isFinite(pos.entrySlippage) ? pos.entrySlippage! : null,
      marks: book.points(pos.mint).map((p) => ({ t: p.t, priceUsd: p.priceUsd }))
    };
  }

  private buildAdvice(): Advice[] {
    const stopLoss = this.config.rules.stopLossPct;
    const positions = [...this.book.positions.values()]
      .filter((pos) => !pos.closing)
      .map((pos) => {
        const markPrice = this.book.price(pos.mint, pos.entryPrice);
        return {
          mint: pos.mint,
          symbol: pos.symbol,
          pnlPct: pos.entryPrice > 0 ? (markPrice - pos.entryPrice) / pos.entryPrice : 0,
          markPrice,
          stopPrice: (pos.entryMark != null && pos.entryMark > 0 ? pos.entryMark : pos.entryPrice) * (1 - stopLoss),
          entryPrice: pos.entryPrice,
          entryLiquidityUsd: pos.liquidityUsd,
          markLiquidityUsd: this.markLiquidity.get(pos.mint) ?? pos.liquidityUsd,
          score: pos.score
        };
      });
    const notes = advise(this.advisor.memory, {
      positions,
      weak: this.weakSurvivor,
      sessionKills: this.killReasons
    });
    const cards = [...this.nearMissCards.values()].filter((card) => card.mint && !this.book.positions.has(card.mint));
    return [...cards, ...notes].slice(0, 8);
  }

  private publishAdvice(items: Advice[]): void {
    const now = Date.now();
    const notes: AdviceNote[] = items.map((item, index) => ({
      id: `${item.stance}:${item.mint ?? item.symbol ?? index}:${item.text}`,
      ts: now,
      stance: item.stance,
      symbol: item.symbol,
      mint: item.mint,
      text: item.text,
      ...(item.code ? { code: item.code } : {}),
      ...(item.score != null ? { score: item.score } : {})
    }));
    const fresh = notes.filter((note) => !this.lastNotes.has(note.text));
    for (const note of fresh) {
      this.log({
        stage: "system",
        kind: "info",
        mint: note.mint,
        symbol: note.symbol,
        message: note.text,
        detail: note.stance
      });
    }
    this.lastNotes = new Set(notes.map((note) => note.text));
    this.advice = notes;
  }

  /** v13.2: true when this mint/code already logged inside the throttle window. */
  private quiet(code: string, mint: string): boolean {
    const key = `${code}:${mint}`;
    const now = Date.now();
    const last = this.logGate.get(key);
    if (last != null && now - last < LOG_THROTTLE_MS) return true;
    this.logGate.set(key, now);
    return false;
  }

  /** v13.7 one feed print marks the paper book and, when held there, the live book. */
  /**
   * v13.39: the mid is no longer sellable value. Write the residual into the book so
   * equity and P&L see it. The position stays open for a later retry, so this does
   * not run the stop. A later drained tick with the same residual does not rewrite.
   */
  private noteLiquidityGone(kind: BookKind, mint: string, residualUsd: number, reason: string): void {
    const book = this.bk(kind);
    const pos = book.positions.get(mint);
    if (!pos) return;
    const key = bookKey(kind, mint);
    const residual = Math.max(0, Number.isFinite(residualUsd) ? residualUsd : 0);
    const prev = this.liquidityGone.get(key);
    const now = Date.now();
    const px = residualMarkPrice(residual, pos.qty);
    const current = book.price(mint, pos.entryPrice);
    const anchorPrice =
      prev?.anchorPrice && prev.anchorPrice > px * 1e6
        ? prev.anchorPrice
        : current > px * 1e6
          ? current
          : pos.entryMark != null && pos.entryMark > 0
            ? pos.entryMark
            : pos.entryPrice;
    this.liquidityGone.set(key, { at: now, residualUsd: residual, reason, anchorPrice });
    if (prev) {
      const last = book.price(mint, pos.entryPrice);
      if (last > 0 && Math.abs(last - px) / Math.max(last, px, 1e-18) < 0.05) return;
    }
    book.mark(mint, px);
    if (!pos.closing) book.noteMark(mint, px, now);
    this.riskFeed.set(key, "none");
    this.liveMarks.set(key, { price: px, at: now, feed: "none" });
    if (!this.quiet("LIQUIDITY_GONE", key)) {
      this.log({
        stage: "risk",
        kind: "reject",
        mint,
        symbol: pos.symbol,
        code: "LIQUIDITY_GONE",
        message: `${LIQUIDITY_GONE_NOTE}. ${pos.symbol} is still held — a later sell can retry if a route returns.`
      });
    }
    this.bus.emit("position.mark", { mint, at: now });
  }

  private clearLiquidityGone(kind: BookKind, mint: string): void {
    this.liquidityGone.delete(bookKey(kind, mint));
  }

  /** The residual mark is not a price. Put the pre-drain anchor back and drop the synthetic card mark. */
  private restoreLiquidityAnchor(kind: BookKind, mint: string): void {
    const key = bookKey(kind, mint);
    const gone = this.liquidityGone.get(key);
    if (!gone || !(gone.anchorPrice > 0)) return;
    this.bk(kind).mark(mint, gone.anchorPrice);
    const live = this.liveMarks.get(key);
    if (live && (live.feed === "none" || !(live.price > gone.anchorPrice / 1e6))) this.liveMarks.delete(key);
  }

  private applyMark(mint: string, priceUsd: number, origin?: MarkOrigin, advise = true): void {
    this.applyMarkIn("paper", mint, priceUsd, origin, advise);
    if (this.liveBook?.positions.has(mint)) this.applyMarkIn("live", mint, priceUsd, origin, false);
  }

  private applyMarkIn(kind: BookKind, mint: string, priceUsd: number, origin?: MarkOrigin, advise = true): void {
    const book = this.bk(kind);
    const key = bookKey(kind, mint);
    const pos = book.positions.get(mint);
    let reanchored = false;
    if (pos && !sameMarkSource(pos, origin)) {
      const now = Date.now();
      const lastGoodAt = book.markedAt(mint) ?? pos.openedAt;
      if (!pos.closing && origin && now - lastGoodAt >= REANCHOR_SILENT_MS) {
        const step = reanchorCandidate(this.reanchors.get(key), origin, priceUsd, book.price(mint, pos.entryPrice), now);
        if (step.verdict === "adopt") {
          const was = `${pos.priceFeed ?? pos.source}${pos.pairAddress ? ` pair ${pos.pairAddress.slice(0, 4)}` : ""}`;
          pos.priceFeed = origin.feed as Position["priceFeed"];
          if (origin.pairAddress) pos.pairAddress = origin.pairAddress;
          else delete pos.pairAddress;
          if (origin.dex) pos.dex = origin.dex;
          this.reanchors.delete(key);
          this.shocks.delete(key);
          reanchored = true;
          this.persist();
          this.log({
            stage: "risk",
            kind: "info",
            mint,
            symbol: pos.symbol,
            code: "PRICE_REANCHOR",
            message: `Risk moved ${pos.symbol} to ${originLabel(origin)}. ${was} had no price for ${Math.round((now - lastGoodAt) / 1000)}s and the new feed printed twice in agreement (${price(priceUsd)}). The stop now uses it.`
          });
        } else if (step.verdict === "wait" && step.next) {
          this.reanchors.set(key, step.next);
        }
      }
      if (!reanchored) {
        if (!this.quiet("PRICE_SOURCE", key)) {
          this.log({
            stage: "risk",
            kind: "reject",
            mint,
            symbol: pos.symbol,
            code: "PRICE_SOURCE",
            message: `Risk ignored a ${pos.symbol} mark of ${price(priceUsd)} from ${originLabel(origin)}. Entry was ${pos.priceFeed ?? pos.source}${pos.pairAddress ? ` pair ${pos.pairAddress.slice(0, 4)}` : ""}. Waiting for a valid mark.`
          });
        }
        return;
      }
    } else if (pos) {
      this.reanchors.delete(key);
    }
    if (origin?.quoteUsd != null && Number.isFinite(origin.quoteUsd) && origin.quoteUsd >= 0) {
      this.lastQuoteUsd.set(mint, origin.quoteUsd);
    }
    if (pos) {
      const midValue = pos.qty * priceUsd;
      const drained = quoteSideDrained({
        quoteUsd: origin?.quoteUsd,
        midValueUsd: midValue,
        liquidityUsd: origin?.liquidityUsd
      });
      const recovered =
        origin?.quoteUsd != null &&
        Number.isFinite(origin.quoteUsd) &&
        origin.quoteUsd > QUOTE_SIDE_GONE_USD &&
        !drained;
      if (recovered) {
        this.restoreLiquidityAnchor(kind, mint);
        this.clearLiquidityGone(kind, mint);
      } else if (drained) {
        this.noteLiquidityGone(kind, mint, residualExitUsd({ quoteUsd: origin?.quoteUsd, midValueUsd: midValue }), "quote_drained");
        if (advise) this.publishAdvice(this.buildAdvice());
        return;
      } else if (this.liquidityGone.has(key)) {
        // Still flagged (e.g. NO_ROUTES). A mid without a healthy quote side is not sellable value.
        return;
      }
    }
    if (markUnusable(priceUsd)) {
      if (pos && !pos.closing && !this.quiet("PRICE_UNUSABLE", key)) {
        this.log({
          stage: "risk",
          kind: "reject",
          mint,
          symbol: pos.symbol,
          code: "PRICE_UNUSABLE",
          message: `Risk ignored a ${pos.symbol} mark of ${price(priceUsd)} from ${origin?.feed ?? "unknown"}. A non-positive mark is invalid data. Waiting for a valid mark.`
        });
      }
      return;
    }
    if (pos && !pos.closing) {
      const lastGood = book.price(mint, pos.entryPrice);
      const anchor = entryAnchor(pos.entryPrice, lastGood);
      const why = outlierReason(anchor, priceUsd);
      // A Dex or Jupiter print this far above the entry is never equity. Only a chain mark
      // can pass, and only when an independent quote sits near it.
      const confirmed = origin?.feed === "chain" && quoteConfirms(priceUsd, this.otherQuotes(mint, "chain", Date.now()));
      if (why && !confirmed) {
        if (!this.quiet("PRICE_OUTLIER", key)) {
          const kindLabel = why === "unit" ? "a decimals or SOL/USD mix-up" : "an implausible jump";
          this.log({
            stage: "risk",
            kind: "reject",
            mint,
            symbol: pos.symbol,
            code: "PRICE_OUTLIER",
            message: `Risk ignored a ${pos.symbol} mark of ${price(priceUsd)} from ${originLabel(origin)} (${kindLabel} versus ${price(anchor)}). Equity, the stop and the card stay on the last mark that agrees with the entry, which goes stale until a sane print arrives.`
          });
        }
        return;
      }
    }
    const absurdDown = !!pos && !pos.closing && this.absurdUnverified(pos, priceUsd);
    const firstAbsurd = absurdDown && !this.absurdHeld.has(key);
    const shock = !!pos && !pos.closing && (needsShockConfirm(pos.entryPrice, priceUsd, pos.openedAt, Date.now()) || firstAbsurd);
    // Operator and replay marks carry no feed and are trusted as before; feed prints must repeat a >30% jump.
    const jump = !!pos && !pos.closing && !reanchored && !!origin?.feed && isJump(book.lastPrice.get(mint), priceUsd);
    let shockConfirmed = false;
    if (pos && (shock || jump)) {
      const feed = origin?.feed ?? pos.priceFeed ?? "mark";
      const pending = this.shocks.get(key);
      const agrees = pending?.price == null || Math.abs(priceUsd / pending.price - 1) <= SHOCK_MOVE;
      if (!pending || pending.feed !== feed || !agrees) {
        this.shocks.set(key, { feed, price: priceUsd });
        if (absurdDown) this.absurdHeld.add(key);
        const base = shock ? pos.entryPrice : book.price(mint, pos.entryPrice);
        const move = ((priceUsd - base) / base) * 100;
        const heldAbsurd = firstAbsurd && !needsShockConfirm(pos.entryPrice, priceUsd, pos.openedAt, Date.now());
        this.log({
          stage: "risk",
          kind: "info",
          mint,
          symbol: pos.symbol,
          code: "PRICE_UNCONFIRMED",
          message: shock
            ? heldAbsurd
              ? `Risk held a ${pos.symbol} mark of ${price(priceUsd)} from ${originLabel(origin)} (${move.toFixed(2)}% versus entry). One absurd print is not a rug. A second tick from the same source has to confirm it before the stop fires.`
              : `Risk held a ${pos.symbol} move of ${move.toFixed(2)}% from ${originLabel(origin)} inside 10s of entry. A second tick from the same source has to confirm it before the stop fires.`
            : `Risk held a ${pos.symbol} jump of ${move.toFixed(2)}% from ${originLabel(origin)}. A second tick from the same source has to confirm it before the stop fires.`
        });
        return;
      }
      this.shocks.delete(key);
      shockConfirmed = true;
    } else if (pos) {
      this.shocks.delete(key);
    }
    const seen = kind === "paper" ? this.sightings.get(mint) : undefined;
    if (seen) this.sightings.set(mint, { ...seen, priceUsd });
    if (origin?.liquidityUsd && origin.liquidityUsd > 0 && pos) this.markLiquidity.set(mint, origin.liquidityUsd);
    if (kind === "paper" || pos) book.mark(mint, priceUsd);
    if (pos && !pos.closing) book.noteMark(mint, priceUsd, Date.now());
    if (pos) {
      this.riskFeed.set(key, origin?.feed ?? pos.priceFeed ?? pos.source);
      this.bus.emit("position.mark", { mint, at: Date.now() });
    }
    this.review(mint, priceUsd, kind, shockConfirmed);
    if (advise) this.publishAdvice(this.buildAdvice());
    // v13.11: a held coin's order fires on the same confirmed mark the hard stop uses.
    if (this.orders.open().some((o) => o.mint === mint)) this.checkOrders(mint);
  }

  /**
   * v13.2 calibrated on-chain mark from the anchored pool. It updates the card, P&L and the
   * "updated" clock. It never moves the stop, the peak, or a fill. When it reaches the stop,
   * or runs 3% away from the risk mark, the entry feed is asked right away.
   */
  private liveMark(mint: string, priceUsd: number, origin: LiveOrigin): void {
    this.liveMarkIn("paper", mint, priceUsd, origin);
    if (this.liveBook?.positions.has(mint)) this.liveMarkIn("live", mint, priceUsd, origin);
  }

  private liveMarkIn(kind: BookKind, mint: string, priceUsd: number, origin: LiveOrigin): void {
    const book = this.bk(kind);
    const key = bookKey(kind, mint);
    const pos = book.positions.get(mint);
    if (!pos || pos.closing || markUnusable(priceUsd)) return;
    if (this.liquidityGone.has(key)) return;
    const lastGood = book.price(mint, pos.entryPrice);
    const anchor = entryAnchor(pos.entryPrice, lastGood);
    const quotes = [
      ...this.otherQuotes(mint, "chain", Date.now()),
      origin.dexUsd,
      origin.jupUsd
    ];
    if (outlierReason(anchor, priceUsd) && !quoteConfirms(priceUsd, quotes)) return;
    // v13.8: a migrated pool's successor is shown only while it agrees with the risk mark (±25%).
    // A drained successor pool (PEPPER: 0.0001 SOL left) can print any price.
    if (origin.pairAddress && pos.pairAddress && origin.pairAddress !== pos.pairAddress) {
      const riskNow = book.price(mint, pos.entryPrice);
      if (!(riskNow > 0) || Math.abs(priceUsd / riskNow - 1) > 0.25) return;
    }
    const now = Date.now();
    const prev = this.liveMarks.get(key);
    const last = prev?.price ?? book.lastPrice.get(mint);
    if (isJump(last, priceUsd)) {
      const pending = this.livePending.get(key);
      if (!pending || Math.abs(priceUsd / pending.price - 1) > 0.1) {
        this.livePending.set(key, { price: priceUsd, at: now });
        return;
      }
    }
    this.livePending.delete(key);
    this.liveMarks.set(key, { price: priceUsd, at: origin.at || now, feed: origin.feed });
    book.noteMark(mint, priceUsd, origin.at || now);
    if (pos.priceFeed === "chain" && pos.pairAddress && origin.pairAddress === pos.pairAddress) {
      // v13.6: the entry itself was priced from this curve/pool, so it is the stop source.
      this.applyMarkIn(kind, mint, priceUsd, { feed: "chain", pairAddress: origin.pairAddress, dex: origin.kind });
      return;
    }
    const risk = book.price(mint, pos.entryPrice);
    const seen = assessPosition(pos, risk, this.config.rules, { liveTrailPct: this.liveTrailFor(pos) });
    const stop = pos.live && seen.trailHintPrice != null ? Math.max(seen.stopPrice, seen.trailHintPrice) : seen.stopPrice;
    const drift = risk > 0 ? Math.abs(priceUsd / risk - 1) : 1;
    const lastAsk = this.lastConfirmAt.get(key) ?? 0;
    // v13.11: an instant on-chain mark across an order level asks the risk feed right away too.
    const orderNear = this.orders.open().some((o) => o.mint === mint && o.book === kind && crosses(o, priceUsd));
    if (((priceUsd <= stop || orderNear) && now - lastAsk >= 1_500) || (drift > 0.03 && now - lastAsk >= 5_000)) {
      this.lastConfirmAt.set(key, now);
      this.pricer.confirm(mint);
    }
    this.bus.emit("position.mark", { mint, at: now });
  }

  /** v13.2 what the card shows: a fresh live mark, else the latest of risk and live. */
  private displayMark(pos: Position, kind: BookKind = "paper"): { price: number; at: number; feed: string } {
    const book = this.bk(kind);
    const key = bookKey(kind, pos.mint);
    const gone = this.liquidityGone.get(key);
    if (gone) {
      return { price: residualMarkPrice(gone.residualUsd, pos.qty), at: gone.at, feed: "none" };
    }
    const riskAt = book.markedAt(pos.mint) ?? pos.openedAt;
    const risk = { price: book.price(pos.mint, pos.entryPrice), at: riskAt, feed: this.riskFeed.get(key) ?? pos.priceFeed ?? pos.source };
    const live = this.liveMarks.get(key);
    if (!live) return risk;
    const now = Date.now();
    if (now - live.at <= LIVE_FRESH_MS || live.at >= riskAt) return live;
    return risk;
  }

  /** v13.7 the live book's card: wallet USDC as cash, real positions only. Null when not armed. */
  private liveBookView(): LiveBookView | null {
    if (!this.liveBook) return null;
    const positions = [...this.liveBook.positions.values()].map((pos) => this.view(pos, "live"));
    const equityUsd = this.displayEquity("live");
    const startingUsd = this.liveStartingUsd;
    return {
      scope: this.liveScopeNow() ?? "manual",
      line: this.liveScopeLine(),
      cashUsd: roundUsd(this.liveBook.cashUsd),
      cashKnown: this.walletBalances != null && this.walletBalances.error == null && this.walletBalances.usdc != null,
      balanceError: this.walletBalances?.error ?? (this.walletBalances ? null : "Wallet balance has not been read."),
      equityUsd: roundUsd(equityUsd),
      startingUsd: roundUsd(startingUsd),
      pnlUsd: startingUsd > 0 ? roundUsd(equityUsd - startingUsd) : 0,
      openPnlUsd: roundUsd(positions.reduce((sum, p) => sum + p.pnlUsd, 0)),
      equity: this.store.liveEquityCurve(0),
      positions,
      tradeUsd: this.liveTradeUsd,
      trailPct: this.liveTrailPct,
      dailyCapUsd: this.liveDailyCapUsd
    };
  }

  /** v13.2 small WS payload: only what a position card needs. */
  marksDelta(): MarksDelta {
    this.healAbsurdMarks();
    const positions = [...this.book.positions.values()].map((pos) => this.view(pos));
    const livePositions = this.liveBook ? [...this.liveBook.positions.values()].map((pos) => this.view(pos, "live")) : [];
    const slim = (p: PositionView) => ({
      ...(p.book ? { book: p.book } : {}),
      mint: p.mint,
      markPrice: p.markPrice,
      marketValueUsd: p.marketValueUsd,
      pnlUsd: p.pnlUsd,
      pnlPct: p.pnlPct,
      stopPrice: p.stopPrice,
      peakPrice: p.peakPrice,
      trailArmed: p.trailArmed,
      trailHintPrice: p.trailHintPrice,
      markAgeMs: p.markAgeMs ?? 0,
      markAt: p.markAt ?? 0,
      markFeed: p.markFeed ?? "",
      netPnlUsd: p.netPnlUsd ?? null,
      netPnlPct: p.netPnlPct ?? null,
      exitSlippage: p.exitSlippage ?? null,
      marks: p.marks ?? [],
      safetyChip: p.safetyChip,
      bundleChip: p.bundleChip,
      liquidityNote: p.liquidityNote ?? null
    });
    return {
      now: Date.now(),
      cashUsd: roundUsd(this.book.cashUsd),
      equityUsd: roundUsd(this.displayEquity()),
      ...(this.liveBook
        ? {
            live: {
              cashUsd: roundUsd(this.liveBook.cashUsd),
              equityUsd: roundUsd(this.displayEquity("live")),
              cashKnown: this.walletBalances != null && this.walletBalances.error == null && this.walletBalances.usdc != null,
              balanceError: this.walletBalances?.error ?? (this.walletBalances ? null : "Wallet balance has not been read."),
              positions: livePositions.map(slim)
            }
          }
        : {}),
      positions: positions.map((p) => ({
        mint: p.mint,
        markPrice: p.markPrice,
        marketValueUsd: p.marketValueUsd,
        pnlUsd: p.pnlUsd,
        pnlPct: p.pnlPct,
        stopPrice: p.stopPrice,
        peakPrice: p.peakPrice,
        trailArmed: p.trailArmed,
        trailHintPrice: p.trailHintPrice,
        markAgeMs: p.markAgeMs ?? 0,
        markAt: p.markAt ?? 0,
        markFeed: p.markFeed ?? "",
        netPnlUsd: p.netPnlUsd ?? null,
        netPnlPct: p.netPnlPct ?? null,
        exitSlippage: p.exitSlippage ?? null,
        marks: p.marks ?? []
      }))
    };
  }

  private displayEquity(kind: BookKind = "paper"): number {
    const book = this.bk(kind);
    let total = book.cashUsd;
    for (const pos of book.positions.values()) total += pos.qty * this.displayMark(pos, kind).price;
    return total;
  }

  /** v13.8 mark loop + websocket stream + per-coin on-chain read status. */
  private markLoopView(): NonNullable<DeskSnapshot["markLoop"]> {
    const held = [...this.book.positions.values(), ...(this.liveBook?.positions.values() ?? [])];
    const seen = new Set<string>();
    const chain = held
      .filter((pos) => (seen.has(pos.mint) ? false : (seen.add(pos.mint), true)))
      .map((pos) => {
        const anchored = pos.pairAddress ?? (pos.mint.endsWith("pump") ? pumpCurveAddress(pos.mint) ?? "" : "");
        const target = anchored && this.chain ? this.chain.target(anchored) : anchored;
        const info = target && this.chain ? this.chain.info(target) : null;
        return {
          mint: pos.mint,
          symbol: pos.symbol,
          pool: info ? info.pair : null,
          kind: info ? info.kind : null,
          reason: info ? null : !this.chain ? "on-chain reads are off" : !anchored ? "no pool known yet" : this.chain.reason(pos.mint) ?? "not resolved yet"
        };
      });
    return { ...this.pricer.stats(), stream: this.stream?.stats() ?? null, chain };
  }

  /** v13.2 fast-loop health for the feed panel. */
  pricerStats() {
    return this.pricer.stats();
  }

  /** Paper exits price off the last accepted mark when the trigger itself is unusable. An unverified spike is not a fill. */
  private exitMark(pos: Position, trigger: number, kind: BookKind = "paper"): number {
    if (this.sellUnverified(pos, trigger)) return Number.NaN;
    if (!markUnusable(trigger)) return trigger;
    const last = this.bk(kind).price(pos.mint, pos.entryPrice);
    if (this.sellUnverified(pos, last)) return Number.NaN;
    return !markUnusable(last) ? last : pos.entryPrice;
  }

  /** Absurd versus entry and not confirmed by another feed. */
  private absurdUnverified(pos: Position, mark: number): boolean {
    if (!(pos.entryPrice > 0) || !(mark > 0) || absurdScale(pos.entryPrice, mark) < ABSURD_RISE) return false;
    return !quoteConfirms(mark, this.otherQuotes(pos.mint, undefined, Date.now()));
  }

  /**
   * The first absurd post-fill mark does not fire a stop.
   * A second agreeing print (shockConfirmed, or a later print after one was held) still can.
   */
  private holdAbsurdStop(pos: Position, mark: number, kind: BookKind, shockConfirmed: boolean): boolean {
    if (!this.absurdUnverified(pos, mark) || mark >= pos.entryPrice) return false;
    if (shockConfirmed) return false;
    const key = bookKey(kind, pos.mint);
    if (this.absurdHeld.has(key)) return false;
    this.absurdHeld.add(key);
    return true;
  }

  /** Mark is dozens of times entry and no fresh Dex or Jupiter print sits near it. Drops are never this. */
  private sellUnverified(pos: Position, mark: number): boolean {
    if (!(pos.entryPrice > 0) || !(mark > 0) || !Number.isFinite(mark)) return false;
    if (mark / pos.entryPrice < ABSURD_RISE) return false;
    return !quoteConfirms(mark, this.otherQuotes(pos.mint, undefined, Date.now()));
  }

  /**
   * Flat or rising automatic sells still have to fit the exit cap. A falling mark is a rug and the engine must be able to leave.
   * A manual sell over the cap waits for sellAnyway. No measurable pool is a hard stop, even then.
   */
  private paperExitImpact(pos: Position, mark: number, qty: number, liquidityUsd: number, manual = false, sellAnyway = false): string | null {
    if (!manual && pos.entryPrice > 0 && mark < pos.entryPrice) return null;
    const notional = mark * qty;
    const gate = exitImpactAllowed(notional, liquidityUsd, this.config.rules.maxEntrySlippage, this.maxExitSlippage);
    if (gate.ok) return null;
    if (!Number.isFinite(gate.slippage)) return POOL_DRAINED_MESSAGE;
    if (manual && sellAnyway) return null;
    return gate.message.replace(/Buy refused/g, "Sell refused");
  }

  private sellRefusal(error: string): { ok: false; error: string; code: string; allowSellAnyway?: boolean } {
    const code = error === POOL_DRAINED_MESSAGE ? "NO_SELL_ROUTE" : "EXIT_IMPACT";
    return { ok: false, error, code, ...(offersSellAnyway(error) ? { allowSellAnyway: true } : {}) };
  }

  private paperProceedsUnverified(pos: Position, proceedsUsd: number, fillPrice: number, costUsd: number): boolean {
    if (!(costUsd > 0) || !(proceedsUsd > 0)) return false;
    if (proceedsUsd / costUsd < ABSURD_RISE) return false;
    return !quoteConfirms(fillPrice, this.otherQuotes(pos.mint, undefined, Date.now()));
  }

  private noteFeedQuote(mint: string, feed: string | undefined, priceUsd: number, at: number): void {
    if (!(priceUsd > 0) || (feed !== "dexscreener" && feed !== "jupiter")) return;
    const row = this.quotePrints.get(mint) ?? {};
    if (feed === "dexscreener") row.dex = { price: priceUsd, at };
    else row.jup = { price: priceUsd, at };
    this.quotePrints.set(mint, row);
  }

  private otherQuotes(mint: string, feed: string | undefined, now: number): number[] {
    const row = this.quotePrints.get(mint);
    const out: number[] = [];
    const take = (slot: "dex" | "jup", src: string) => {
      if (feed === src) return;
      const q = row?.[slot];
      if (q && now - q.at <= QUOTE_CONFIRM_MS && q.price > 0) out.push(q.price);
    };
    take("dex", "dexscreener");
    take("jup", "jupiter");
    return out;
  }

  /**
   * A saved or streamed mark dozens of times the entry, with no other feed near it,
   * is not part of equity, PnL, or the sparkline. The entry price stays in its place.
   */
  private healAbsurdMarks(): void {
    const now = Date.now();
    for (const kind of ["paper", "live"] as const) {
      const book = kind === "live" ? this.liveBook : this.book;
      if (!book) continue;
      for (const pos of book.positions.values()) {
        const key = bookKey(kind, pos.mint);
        const live = this.liveMarks.get(key);
        if (live && outlierReason(entryAnchor(pos.entryPrice, live.price), live.price) && !quoteConfirms(live.price, [...this.otherQuotes(pos.mint, "chain", now)])) {
          this.liveMarks.delete(key);
        }
        const px = book.lastPrice.get(pos.mint);
        if (px != null && pos.entryPrice > 0 && px / pos.entryPrice >= ABSURD_RISE && !quoteConfirms(px, this.otherQuotes(pos.mint, undefined, now))) {
          book.lastPrice.set(pos.mint, pos.entryPrice);
        }
        const series = book.series.get(pos.mint);
        if (series && pos.entryPrice > 0) {
          const kept = series.filter((point) => !(point.priceUsd / pos.entryPrice >= ABSURD_RISE) || quoteConfirms(point.priceUsd, this.otherQuotes(pos.mint, undefined, now)));
          if (kept.length !== series.length) book.series.set(pos.mint, kept);
        }
      }
    }
  }

  private markEquity(force = false): void {
    this.healAbsurdMarks();
    const now = Date.now();
    if (!force && now - this.lastEquityAt < 1_800) return;
    this.lastEquityAt = now;
    const equity = roundUsd(this.book.equity());
    const cash = roundUsd(this.book.cashUsd);
    const prev = this.lastEquitySample;
    const prevMv = prev ? Math.max(0, prev.equity - prev.cash) : 0;
    const mv = Math.max(0, equity - cash);
    const cashUp = prev != null && cash > prev.cash + 500;
    if (prev && !cashUp && equity > prev.equity * 1.02 && prevMv > 1 && mv > prevMv * 25 && mv - prevMv > 500) return;
    this.lastEquitySample = { equity, cash };
    this.store.insertEquity({ t: now, equity, cash });
    this.markLiveEquity(now);
  }

  /**
   * The live book's curve. Sampled only while the wallet read is good, so a failed read never
   * draws a fall to zero. A changed value is saved at most every 10 s, an unchanged one once a minute.
   */
  private markLiveEquity(now: number): void {
    if (!this.liveBook) return;
    const known = this.walletBalances != null && this.walletBalances.error == null && this.walletBalances.usdc != null;
    if (!known) return;
    const equity = roundUsd(this.displayEquity("live"));
    if (!Number.isFinite(equity) || equity < 0) return;
    const gap = now - this.lastLiveEquityAt;
    if (gap < 10_000) return;
    if (this.lastLiveEquity != null && equity === this.lastLiveEquity && gap < 60_000) return;
    this.lastLiveEquityAt = now;
    this.lastLiveEquity = equity;
    this.store.insertLiveEquity({ t: now, equity, cash: roundUsd(this.liveBook.cashUsd) });
  }

  /** v13.41 saved market data for analysis. */
  recorderStats(): RecorderStats {
    return this.recorder.stats();
  }

  marketQuotes(opts: { since?: number; until?: number; mint?: string; limit?: number }): { rows: RecordedQuote[]; more: boolean } {
    return this.recorder.quotesBetween(opts);
  }

  marketSignals(opts: { since?: number; until?: number; limit?: number }): RecordedSignal[] {
    return this.recorder.signalsBetween(opts);
  }

  private replayRunning: Promise<ReplayResult> | null = null;

  /**
   * Tries a grid of exit rules against the saved quotes and signals of the last `days` days.
   * Read-only: it changes no setting and no book. One replay runs at a time.
   */
  marketReplay(days = 3): Promise<ReplayResult> {
    if (this.replayRunning) return this.replayRunning;
    const span = Math.max(1, Math.min(this.recorder.days || 1, Math.floor(days)));
    const since = Date.now() - span * 86_400_000;
    const run = (async () => {
      const quotes = await this.recorder.latestQuotes(since);
      const from = quotes.length ? quotes[0]!.t : since;
      const signals = this.recorder.signalsBetween({ since: from, limit: 50_000 });
      return replaySaved(quotes, signals, { targetNetUsd: this.strategy.settings.targetNetUsd, tradeUsd: this.strategy.settings.tradeUsd, until: Date.now() });
    })().finally(() => {
      this.replayRunning = null;
    });
    this.replayRunning = run;
    return run;
  }

  private remember(token: CandidateToken, fresh?: ReadonlySet<ChainFactField>): void {
    this.sightings.set(token.mint, { ...token, social: { ...token.social } });
    this.rememberChain(token, Date.now(), fresh);
    // v13.11 supply from the first sighting where price and market cap came from the same read.
    if (!this.supplyByMint.has(token.mint) && (token.marketCapUsd ?? 0) > 0 && token.priceUsd > 0) {
      const supply = (token.marketCapUsd as number) / token.priceUsd;
      if (Number.isFinite(supply) && supply > 0) this.supplyByMint.set(token.mint, supply);
    }
    this.momentum.note(token.mint, token.priceUsd, token.liquidityUsd);
  }

  /**
   * Keep each verified chain field for 30 minutes from the read that produced it.
   * Copying a stored field into a later lookup does not renew that field.
   * A null read does not erase a field that is still inside its own window.
   */
  private rememberChain(token: CandidateToken, at = Date.now(), fresh?: ReadonlySet<ChainFactField>): void {
    const prev = this.chainFacts.get(token.mint);
    const refresh = fresh ?? chainFactFieldSet(token);
    const ages: Partial<Record<ChainFactField, number>> = {};
    const merged: CandidateToken = { ...token, social: { ...token.social } };
    for (const field of CHAIN_FACT_FIELDS) {
      const priorAt = prev?.ages[field];
      const priorFresh = priorAt != null && priorAt <= at && at - priorAt <= CHAIN_FACT_MAX_AGE_MS;
      const observedNow = refresh.has(field) && chainFieldPresent(token, field);
      if (observedNow) {
        ages[field] = at;
      } else if (priorFresh && prev && chainFieldPresent(prev.token, field)) {
        ages[field] = priorAt;
        if (!chainFieldPresent(merged, field)) copyChainField(merged, prev.token, field);
      } else {
        clearChainField(merged, field);
      }
    }
    if (!chainVerified(merged)) {
      this.chainFacts.delete(token.mint);
      return;
    }
    const oldest = Math.min(...CHAIN_FACT_FIELDS.map((field) => ages[field] ?? Number.POSITIVE_INFINITY));
    this.chainFacts.set(token.mint, { at: oldest, ages, token: merged });
    if (this.chainFacts.size > 400) {
      const first = this.chainFacts.keys().next().value;
      if (first) this.chainFacts.delete(first);
    }
  }

  /** Copy still-missing chain fields whose own verification is under 30 minutes. Age is the oldest field copied. */
  private fillChainFromFacts(token: CandidateToken, now = Date.now()): { ageMs: number } | null {
    const saved = this.chainFacts.get(token.mint);
    if (!saved) return null;
    let oldest = Number.POSITIVE_INFINITY;
    let filled = false;
    for (const field of CHAIN_FACT_FIELDS) {
      const seen = saved.ages[field];
      if (seen == null || seen > now || now - seen > CHAIN_FACT_MAX_AGE_MS) continue;
      if (chainFieldPresent(token, field) || !chainFieldPresent(saved.token, field)) continue;
      copyChainField(token, saved.token, field);
      filled = true;
      if (seen < oldest) oldest = seen;
    }
    if (!filled) return null;
    return { ageMs: now - oldest };
  }

  /**
   * Floor for recaps. A missing marker is filled from the equity series
   * (the $10,000 book stamped down to $100) and then saved.
   * A later book start wins, so a starting-balance change is included.
   */
  private ensureResetAt(): number {
    const saved = this.store.readJson("resetAt");
    const stored = typeof saved === "number" && Number.isFinite(saved) ? saved : null;
    const jump = stored == null ? resetAtFromEquity(this.store.equitySince(0), this.config.startingBalanceUsd) : null;
    let floor = stored ?? jump ?? this.startedAt;
    if (this.startedAt > floor) floor = this.startedAt;
    if (stored !== floor) this.store.writeJson("resetAt", floor);
    return floor;
  }

  private readSettings(): DeskSettings {
    const saved = this.store.readJson("settings");
    if (!saved || typeof saved !== "object") return {};
    return saved as DeskSettings;
  }

  private applySaved(saved: DeskSettings): void {
    if (typeof saved.minVolume1hUsd === "number") this.config.rules.minVolume1hUsd = clampVolumeUsd(saved.minVolume1hUsd);
    if (typeof saved.analystMinScore === "number") this.config.rules.analystMinScore = clampScore(saved.analystMinScore);
    if (typeof saved.volumeBoost === "number") this.config.rules.volumeBoost = clampVolumeBoost(saved.volumeBoost);
    if (typeof saved.maxTop10Pct === "number") this.config.rules.maxTop10Pct = clampTop10(saved.maxTop10Pct);
    if (typeof saved.maxPositionPct === "number") this.config.rules.maxPositionPct = clampPositionPct(saved.maxPositionPct, this.config.rules.maxPositionPct, SIZING_BAND.autoMaxPct);
    if (typeof saved.maxEntrySlippage === "number") this.config.rules.maxEntrySlippage = clampEntrySlippage(saved.maxEntrySlippage);
    if ("defaultBuyUsd" in saved) this.defaultBuyUsd = clampBuyUsd(saved.defaultBuyUsd ?? null);
    if (typeof saved.maxOpenPositions === "number") this.maxOpenPositions = clampOpenPositions(saved.maxOpenPositions);
    if (typeof saved.positionRefreshMs === "number") this.positionRefreshMs = clampPositionRefreshMs(saved.positionRefreshMs);
    if ("maxExitSlippage" in saved) {
      this.maxExitSlippage =
        typeof saved.maxExitSlippage === "number" ? clampExitSlippage(saved.maxExitSlippage, this.config.rules.maxEntrySlippage + HARD_RULES.exitImpactSlack) : null;
    }
    if (typeof saved.allowUnlockedLp === "boolean") this.allowUnlockedLp = saved.allowUnlockedLp;
    this.absorbGates(saved);
    if (typeof saved.operatorReady === "boolean") this.operatorReady = saved.operatorReady;
    this.scout.setSources(this.scoutSources);
  }

  private positionCapUsd(equityUsd = this.book.equity(), pct = Math.min(this.config.rules.maxPositionPct, SIZING_BAND.autoMaxPct)): number {
    const cap = floorUsd(Math.max(0, equityUsd) * pct);
    const cash = floorUsd(Math.max(0, this.book.cashUsd));
    const room = this.exposureRoomUsd(equityUsd);
    return Math.max(0, Math.min(cap, cash, room == null ? Number.POSITIVE_INFINITY : floorUsd(Math.max(0, room))));
  }

  /**
   * v13.6 Which limit sets positionCapUsd, in words. The cap is the smallest of the
   * per-position % of equity, cash, and the max-exposure room left.
   */
  capWhy(equityUsd = this.book.equity(), pct = Math.min(this.config.rules.maxPositionPct, SIZING_BAND.autoMaxPct)): CapWhy {
    const eq = Math.max(0, equityUsd);
    const pctCapUsd = floorUsd(eq * pct);
    const cashUsd = floorUsd(Math.max(0, this.book.cashUsd));
    const room = this.exposureRoomUsd(equityUsd);
    const roomUsd = room == null ? null : floorUsd(Math.max(0, room));
    const capUsd = Math.max(0, Math.min(pctCapUsd, cashUsd, roomUsd ?? Number.POSITIVE_INFINITY));
    const binding: CapWhy["binding"] = roomUsd != null && roomUsd <= pctCapUsd && roomUsd <= cashUsd ? "exposure" : cashUsd < pctCapUsd ? "cash" : "position";
    const m = (n: number) => `$${n.toFixed(2)}`;
    const exposureUsd = roundUsd(this.exposureUsd());
    const line =
      binding === "exposure"
        ? `exposure cap: max exposure ${(this.maxExposurePct * 100).toFixed(0)}% × ${m(eq)} equity = ${m(eq * this.maxExposurePct)}, minus ${m(exposureUsd)} already in open positions = ${m(capUsd)} room`
        : binding === "cash"
          ? `cash: only ${m(cashUsd)} cash left (per-position cap ${(pct * 100).toFixed(1)}% would be ${m(pctCapUsd)})`
          : `per-position cap: ${(pct * 100).toFixed(1)}% × ${m(eq)} equity = ${m(pctCapUsd)}`;
    return { capUsd, binding, pctCapUsd, cashUsd, exposureRoomUsd: roomUsd, maxExposurePct: this.maxExposurePct, exposureUsd, equityUsd: roundUsd(eq), line };
  }

  /** Market value of open positions. */
  private exposureUsd(): number {
    let total = 0;
    for (const pos of this.book.positions.values()) total += pos.qty * this.book.price(pos.mint, pos.entryPrice);
    return Number.isFinite(total) ? total : Number.POSITIVE_INFINITY;
  }

  /** New exposure still allowed, or undefined when the cap is 100% (the v11 behavior: cash is the limit). */
  private exposureRoomUsd(equityUsd = this.book.equity()): number | undefined {
    if (this.maxExposurePct >= SIZING_BAND.exposureMaxPct) return undefined;
    const room = Math.max(0, equityUsd) * this.maxExposurePct - this.exposureUsd();
    return Number.isFinite(room) ? Math.max(0, room) : 0;
  }

  private bought(
    token: CandidateToken,
    sized: { sizeUsd: number; clampedFrom?: number },
    mode: "paper" | "live",
    warning?: string
  ): ManualBuyResult {
    return {
      ok: true,
      mint: token.mint,
      symbol: token.symbol,
      sizeUsd: sized.sizeUsd,
      mode,
      ...(sized.clampedFrom != null ? { clampedFrom: sized.clampedFrom } : {}),
      ...(this.bk(mode).positions.get(token.mint)?.entryPrice ? { fillPriceUsd: this.bk(mode).positions.get(token.mint)!.entryPrice } : {}),
      ...(warning ? { warning } : {})
    };
  }

  private settingsView(): DeskSettingsView {
    return {
      positionRefreshMs: this.positionRefreshMs,
      maxExitSlippage: this.maxExitSlippage,
      minVolume1hUsd: this.config.rules.minVolume1hUsd,
      analystMinScore: this.config.rules.analystMinScore,
      volumeBoost: this.config.rules.volumeBoost ?? 0,
      maxTop10Pct: this.config.rules.maxTop10Pct,
      maxPositionPct: this.config.rules.maxPositionPct,
      stopLossPct: this.config.rules.stopLossPct,
      defaultBuyUsd: this.defaultBuyUsd,
      maxOpenPositions: this.maxOpenPositions,
      allowUnlockedLp: this.allowUnlockedLp,
      maxEntrySlippage: this.config.rules.maxEntrySlippage,
      minLiquidityUsd: this.minLiquidityUsd,
      minTokenAgeMin: this.minTokenAgeMin,
      maxTokenAgeMin: this.maxTokenAgeMin,
      minHolderCount: this.minHolderCount,
      maxDevHoldingPct: this.maxDevHoldingPct,
      maxTradesPerHour: this.maxTradesPerHour,
      dailyMaxLossUsd: this.dailyMaxLossUsd,
      cooldownHours: Math.round(this.config.rules.revengeCooldownMs / 3_600_000),
      trailTakeProfit: this.trailTakeProfit,
      trailArmPct: this.config.rules.trailArmPct,
      trailGapPct: this.config.rules.trailGapPct,
      autoBuy: this.autoBuy,
      scoutDexscreener: this.scoutSources.dexscreener,
      scoutGecko: this.scoutSources.gecko,
      scoutJupiter: this.scoutSources.jupiter,
      scoutDexpaprika: this.scoutSources.dexpaprika,
      scoutBitquery: this.scoutSources.bitquery,
      scoutPumpApi: this.scoutSources.pumpapi,
      scoutLaunchLab: this.scoutSources.launchlab,
      notifyNearMiss: this.notifyNearMiss,
      notifyFills: this.notifyFills,
      notifyStops: this.notifyStops,
      pnlAlertPct: this.pnlAlertPct,
      positionSizeUsd: this.positionSizeUsd,
      maxExposurePct: this.maxExposurePct,
      paperResetUsd: this.paperResetUsd,
      liveTradeUsd: this.liveTradeUsd,
      liveDailyCapUsd: this.liveDailyCapUsd,
      liveTrailPct: this.liveTrailPct,
      liveAutoBuy: this.liveAutoBuy,
      senderTipSol: this.senderTipSol
    };
  }

  private assignGates(patch: SettingsPatch, next: DeskSettings): { ok: false; error: string } | null {
    const num = (key: keyof DeskSettings): number => Number(patch[key]);
    if ("minLiquidityUsd" in patch) {
      if (!Number.isFinite(num("minLiquidityUsd"))) return { ok: false, error: "Min liquidity must be a dollar amount, or 0 to leave it off." };
      next.minLiquidityUsd = clampLiquidityUsd(num("minLiquidityUsd"));
    }
    if ("minTokenAgeMin" in patch) {
      if (!Number.isFinite(num("minTokenAgeMin"))) return { ok: false, error: "Min token age must be minutes, or 0 to leave it off." };
      next.minTokenAgeMin = clampAgeMinutes(num("minTokenAgeMin"));
    }
    if ("maxTokenAgeMin" in patch) {
      if (!Number.isFinite(num("maxTokenAgeMin"))) return { ok: false, error: "Max token age must be minutes, or 0 to leave it off." };
      next.maxTokenAgeMin = clampAgeMinutes(num("maxTokenAgeMin"));
    }
    if ("minHolderCount" in patch) {
      if (!Number.isFinite(num("minHolderCount"))) return { ok: false, error: "Min holder count must be a whole number, or 0 to leave it off." };
      next.minHolderCount = clampHolderCount(num("minHolderCount"));
    }
    if ("maxDevHoldingPct" in patch) {
      if (!Number.isFinite(num("maxDevHoldingPct"))) return { ok: false, error: "Max dev holding must be a percent, or 0 to leave it off." };
      next.maxDevHoldingPct = clampDevHoldingPct(num("maxDevHoldingPct"));
    }
    if ("maxTradesPerHour" in patch) {
      if (!Number.isFinite(num("maxTradesPerHour"))) return { ok: false, error: "Max trades per hour must be a whole number, or 0 for no cap." };
      next.maxTradesPerHour = clampTradesPerHour(num("maxTradesPerHour"));
    }
    if ("dailyMaxLossUsd" in patch) {
      if (!Number.isFinite(num("dailyMaxLossUsd"))) return { ok: false, error: "Daily max loss must be a dollar amount, or 0 to leave it off." };
      next.dailyMaxLossUsd = clampDailyLossUsd(num("dailyMaxLossUsd"));
    }
    if ("cooldownHours" in patch) {
      const raw = num("cooldownHours");
      if (!Number.isFinite(raw) || raw < 0) return { ok: false, error: "Cooldown hours must be 0 (off) through 72." };
      next.cooldownHours = clampCooldownHours(raw);
      next.cooldownRetired = true;
    }
    if ("stopLossPct" in patch) {
      const raw = num("stopLossPct");
      // 1 means 1% here (a 100% stop is never valid), so the phone's "1" is not refused.
      const fraction = raw >= 1 ? raw / 100 : raw;
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction > HARD_RULES.stopLossPct + 1e-9) {
        return { ok: false, error: "Hard stop cannot be loosened past 6%. Tighter is allowed." };
      }
      next.stopLossPct = clampStopLossPct(fraction);
      // v13.8 audit line: a stop change is always logged with old → new (it can only tighten).
      const before = this.config.rules.stopLossPct;
      if (Math.abs(next.stopLossPct - before) > 1e-9) {
        this.log({
          stage: "system",
          kind: "info",
          code: "SETTINGS",
          message: `Hard stop set to −${(next.stopLossPct * 100).toFixed(1)}% (was −${(before * 100).toFixed(1)}%; the −6% default can only be tightened). Applies to every position, paper and live.`
        });
      }
    }
    if ("trailArmPct" in patch) {
      const raw = num("trailArmPct");
      const fraction = raw > 1 ? raw / 100 : raw;
      if (!Number.isFinite(fraction) || fraction < HARD_RULES.trailArmPct - 1e-9) {
        return { ok: false, error: "Trail arm cannot be easier than 12%." };
      }
      if (fraction > TRAIL_ARM_MAX + 1e-9) return { ok: false, error: "Trail arm can be at most 600%." };
      next.trailArmPct = clampTrailArmPct(raw);
    }
    if ("trailGapPct" in patch) {
      const raw = num("trailGapPct");
      const fraction = raw >= 1 ? raw / 100 : raw;
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction > HARD_RULES.trailGapPct + 1e-9) {
        return { ok: false, error: "Trail gap cannot be wider than 4%." };
      }
      next.trailGapPct = clampTrailGapPct(fraction);
    }
    if ("positionSizeUsd" in patch) {
      const raw = patch.positionSizeUsd;
      if (raw == null || raw === "" || raw === 0) next.positionSizeUsd = null;
      else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Position size $ must be a dollar amount, or blank to size from the % cap." };
        next.positionSizeUsd = clampPositionUsd(n);
      }
    }
    if ("maxExposurePct" in patch) {
      const raw = num("maxExposurePct");
      if (!Number.isFinite(raw) || raw <= 0) return { ok: false, error: "Max total exposure must be a percent from 10 to 100." };
      next.maxExposurePct = clampExposurePct(raw);
    }
    if ("paperResetUsd" in patch) {
      const raw = num("paperResetUsd");
      if (!Number.isFinite(raw) || raw <= 0) return { ok: false, error: "Paper reset amount must be $100 to $10,000." };
      next.paperResetUsd = clampResetUsd(raw);
    }
    if ("liveTradeUsd" in patch) {
      const raw = num("liveTradeUsd");
      if (!Number.isFinite(raw) || raw < LIVE_BAND.tradeUsd.min || raw > LIVE_BAND.tradeUsd.max) {
        return { ok: false, error: `Live trade size must be $${LIVE_BAND.tradeUsd.min} to $${LIVE_BAND.tradeUsd.max}.` };
      }
      next.liveTradeUsd = clampLiveTradeUsd(raw);
    }
    if ("liveDailyCapUsd" in patch) {
      const raw = patch.liveDailyCapUsd;
      if (raw == null || raw === "" || raw === 0) next.liveDailyCapUsd = null;
      else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Live daily cap must be a dollar amount, or blank for no cap." };
        next.liveDailyCapUsd = clampLiveDailyCapUsd(n);
      }
    }
    if ("senderTipSol" in patch) {
      const raw = num("senderTipSol");
      if (!Number.isFinite(raw) || raw < 0.000005 - 1e-12 || raw > 0.01) {
        return { ok: false, error: "Sender tip must be from 0.000005 to 0.01 SOL." };
      }
      next.senderTipSol = clampSenderTipSol(raw);
    }
    if ("liveTrailPct" in patch) {
      const fraction = liveTrailFromWire(num("liveTrailPct"));
      if (!Number.isFinite(fraction)) return { ok: false, error: "Live trailing stop must be a percent from 0.5 to 20." };
      next.liveTrailPct = fraction;
    }
    if ("pnlAlertPct" in patch) {
      if (!Number.isFinite(num("pnlAlertPct"))) return { ok: false, error: "PnL alert must be a percent, or 0 to leave it off." };
      next.pnlAlertPct = clampPnlAlertPct(num("pnlAlertPct"));
    }
    const flags: Array<keyof DeskSettings> = [
      "trailTakeProfit",
      "autoBuy",
      "scoutDexscreener",
      "scoutGecko",
      "scoutJupiter",
      "scoutDexpaprika",
      "scoutBitquery",
      "scoutPumpApi",
      "scoutLaunchLab",
      "notifyNearMiss",
      "notifyFills",
      "notifyStops"
    ];
    if ("liveAutoBuy" in patch) {
      if (patch.liveAutoBuy !== false) {
        return { ok: false, error: "AI auto-buys stay on the paper book. The server refuses to let them spend real money." };
      }
      next.liveAutoBuy = false;
    }
    for (const key of flags) {
      if (!(key in patch)) continue;
      if (typeof patch[key] !== "boolean") return { ok: false, error: `${key} must be true or false.` };
      next[key] = patch[key] as never;
    }
    return null;
  }

  /**
   * v13.20 the stored 6h ban is retired once. A later save of 0 stays off.
   * A later save above 0 is the operator turning the slider back on, and is the only way it blocks.
   */
  private applyCooldown(saved: DeskSettings): void {
    if (saved.cooldownRetired === true) {
      const hours = typeof saved.cooldownHours === "number" ? clampCooldownHours(saved.cooldownHours) : 0;
      this.config.rules.revengeCooldownMs = hours * 3_600_000;
    } else {
      this.config.rules.revengeCooldownMs = 0;
      this.store.writeJson("settings", { ...saved, cooldownHours: 0, cooldownRetired: true });
    }
    if (this.config.rules.revengeCooldownMs <= 0) this.cooldowns.clear();
  }

  private absorbGates(saved: DeskSettings): void {
    if (typeof saved.minLiquidityUsd === "number") this.minLiquidityUsd = clampLiquidityUsd(saved.minLiquidityUsd);
    if (typeof saved.minTokenAgeMin === "number") this.minTokenAgeMin = clampAgeMinutes(saved.minTokenAgeMin);
    if (typeof saved.maxTokenAgeMin === "number") this.maxTokenAgeMin = clampAgeMinutes(saved.maxTokenAgeMin);
    if (typeof saved.minHolderCount === "number") this.minHolderCount = clampHolderCount(saved.minHolderCount);
    if (typeof saved.maxDevHoldingPct === "number") this.maxDevHoldingPct = clampDevHoldingPct(saved.maxDevHoldingPct);
    if (typeof saved.maxTradesPerHour === "number") this.maxTradesPerHour = clampTradesPerHour(saved.maxTradesPerHour);
    if (typeof saved.dailyMaxLossUsd === "number") this.dailyMaxLossUsd = clampDailyLossUsd(saved.dailyMaxLossUsd);
    this.applyCooldown(saved);
    if (typeof saved.stopLossPct === "number" && saved.stopLossPct > 0 && saved.stopLossPct <= HARD_RULES.stopLossPct + 1e-9) {
      this.config.rules.stopLossPct = clampStopLossPct(saved.stopLossPct);
    }
    if (typeof saved.trailArmPct === "number") this.config.rules.trailArmPct = clampTrailArmFraction(saved.trailArmPct);
    if (typeof saved.trailGapPct === "number") this.config.rules.trailGapPct = clampTrailGapPct(saved.trailGapPct);
    if (typeof saved.trailTakeProfit === "boolean") this.trailTakeProfit = saved.trailTakeProfit;
    if (typeof saved.autoBuy === "boolean") this.autoBuy = saved.autoBuy;
    // A saved true from an older build cannot put the AI on the live book.
    this.liveAutoBuy = false;
    this.scoutSources = {
      dexscreener: saved.scoutDexscreener !== false,
      gecko: saved.scoutGecko !== false,
      jupiter: saved.scoutJupiter !== false,
      dexpaprika: saved.scoutDexpaprika === true,
      bitquery: saved.scoutBitquery !== false,
      pumpapi: saved.scoutPumpApi !== false,
      launchlab: saved.scoutLaunchLab !== false
    };
    if (typeof saved.notifyNearMiss === "boolean") this.notifyNearMiss = saved.notifyNearMiss;
    if (typeof saved.notifyFills === "boolean") this.notifyFills = saved.notifyFills;
    if (typeof saved.notifyStops === "boolean") this.notifyStops = saved.notifyStops;
    if (typeof saved.pnlAlertPct === "number") this.pnlAlertPct = clampPnlAlertPct(saved.pnlAlertPct);
    if ("positionSizeUsd" in saved) this.positionSizeUsd = clampPositionUsd(saved.positionSizeUsd ?? null);
    if (typeof saved.maxExposurePct === "number") this.maxExposurePct = clampExposurePct(saved.maxExposurePct);
    if (typeof saved.paperResetUsd === "number") this.paperResetUsd = clampResetUsd(saved.paperResetUsd);
    if (typeof saved.liveTradeUsd === "number") this.liveTradeUsd = clampLiveTradeUsd(saved.liveTradeUsd);
    if ("liveDailyCapUsd" in saved) this.liveDailyCapUsd = clampLiveDailyCapUsd(saved.liveDailyCapUsd ?? null);
    if (typeof saved.liveTrailPct === "number") {
      const trail = liveTrailFromWire(saved.liveTrailPct);
      if (Number.isFinite(trail)) this.liveTrailPct = trail;
    }
    if (typeof saved.senderTipSol === "number") this.senderTipSol = clampSenderTipSol(saved.senderTipSol);
  }

  /** Buy fills in the last hour. `liveOnly` counts real-money buys only: paper engine buys must not use up the live budget. */
  private buysInLastHour(liveOnly = false): number {
    const since = Date.now() - 3_600_000;
    return this.store
      .recentEvents(500)
      .filter((event) => event.kind === "fill" && event.ts >= since && / buy /.test(event.message) && (!liveOnly || /\(live,/.test(event.message))).length;
  }

  private lossSoFarUsd(): number {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    let loss = 0;
    for (const trade of this.store.closedSince(start.getTime())) {
      if (trade.pnlUsd < 0) loss += -trade.pnlUsd;
    }
    for (const pos of this.book.positions.values()) {
      const mark = this.book.price(pos.mint, pos.entryPrice);
      const pnl = pos.qty * mark - pos.costUsd;
      if (pnl < 0) loss += -pnl;
    }
    return loss;
  }

  private prefsView() {
    const view = this.settingsView();
    return {
      defaultBuyUsd: view.defaultBuyUsd,
      maxOpenPositions: view.maxOpenPositions,
      allowUnlockedLp: view.allowUnlockedLp,
      autoBuy: view.autoBuy,
      minLiquidityUsd: view.minLiquidityUsd,
      minTokenAgeMin: view.minTokenAgeMin,
      maxTokenAgeMin: view.maxTokenAgeMin,
      minHolderCount: view.minHolderCount,
      maxDevHoldingPct: view.maxDevHoldingPct,
      maxTradesPerHour: view.maxTradesPerHour,
      dailyMaxLossUsd: view.dailyMaxLossUsd,
      cooldownHours: view.cooldownHours,
      trailTakeProfit: view.trailTakeProfit,
      notifyNearMiss: view.notifyNearMiss,
      notifyFills: view.notifyFills,
      notifyStops: view.notifyStops,
      pnlAlertPct: view.pnlAlertPct,
      scoutDexscreener: view.scoutDexscreener,
      scoutGecko: view.scoutGecko,
      scoutJupiter: view.scoutJupiter,
      scoutDexpaprika: view.scoutDexpaprika,
      scoutBitquery: view.scoutBitquery,
      scoutPumpApi: view.scoutPumpApi,
      scoutLaunchLab: view.scoutLaunchLab,
      positionSizeUsd: view.positionSizeUsd,
      maxExposurePct: view.maxExposurePct,
      paperResetUsd: view.paperResetUsd,
      positionRefreshMs: view.positionRefreshMs,
      maxExitSlippage: view.maxExitSlippage,
      liveTradeUsd: view.liveTradeUsd,
      liveDailyCapUsd: view.liveDailyCapUsd,
      liveTrailPct: view.liveTrailPct,
      liveAutoBuy: view.liveAutoBuy,
      senderTipSol: view.senderTipSol
    };
  }

  private persist(): void {
    const cooldowns = [...this.cooldowns.entries()];
    this.store.saveBook(
      {
        cashUsd: this.book.cashUsd,
        startingBalanceUsd: this.config.startingBalanceUsd,
        startedAt: this.startedAt,
        positions: [...this.book.positions.values()].map((pos) => ({ ...pos, closing: false })),
        cooldowns: cooldowns.filter(([key]) => !key.startsWith(LIVE_KEY)),
        lastPrices: [...this.book.lastPrice.entries()],
        markSeries: [...this.book.series.entries()]
      },
      "book"
    );
    if (this.liveBook) {
      this.store.saveBook(
        {
          cashUsd: this.liveBook.cashUsd,
          startingBalanceUsd: this.liveStartingUsd,
          startedAt: this.liveStartedAt,
          positions: [...this.liveBook.positions.values()].map((pos) => ({ ...pos, closing: false })),
          cooldowns: cooldowns.filter(([key]) => key.startsWith(LIVE_KEY)).map(([key, until]) => [key.slice(LIVE_KEY.length), until] as [string, number]),
          lastPrices: [...this.liveBook.lastPrice.entries()],
          markSeries: [...this.liveBook.series.entries()]
        },
        "book:live"
      );
    }
  }

  /** v13.7 the book a kind names. "live" is only asked for when the live book exists. */
  private bk(kind: BookKind): PaperBook {
    if (kind === "live") {
      if (!this.liveBook) throw new Error("Live book is not open (desk is not armed).");
      return this.liveBook;
    }
    return this.book;
  }

  /** v13.7 plain words for the live scope, shown on the wallet card, readiness and the log. */
  /** "all" while the engine has a live variant and is on: real swaps can be sent without a tap. */
  private liveScopeNow(): "manual" | "all" | null {
    if (!this.liveBook) return null;
    return this.strategy.settings.enabled && this.strategy.settings.liveVariant ? "all" : "manual";
  }

  private liveScopeLine(): string {
    if (!this.liveBook) return "Live trading is off. Everything is paper.";
    if (this.liveScopeNow() === "all") {
      return `Live: you and the engine (${this.strategy.settings.liveVariant}). The engine buys with real money on its own at the live size. Other AI buys stay on the paper book.`;
    }
    return "Live: manual only · AI: paper. Your buys, limits and stops can send real swaps. AI auto-buys stay on the paper book.";
  }

  /** v13.5 the live trail applies to live positions only. */
  /** The manual live trail. An engine position is sold by its variant's rules, so it has none. */
  private liveTrailFor(pos: Position): number | null {
    return pos.live === true && !pos.strategy ? this.liveTrailPct : null;
  }

  /** v13.5 read-only SOL / USDC balance. In live mode the wallet's USDC is the book's cash. */
  async refreshWallet(): Promise<WalletBalances | null> {
    if (this.walletInflight) return this.walletInflight;
    let job: Promise<WalletBalances | null>;
    job = this.readWalletOnce().finally(() => {
      if (this.walletInflight === job) this.walletInflight = null;
    });
    this.walletInflight = job;
    return job;
  }

  private async readWalletOnce(): Promise<WalletBalances | null> {
    const read = await this.walletReader();
    if (read.error != null || read.usdc == null || read.sol == null) {
      const prev = this.walletBalances;
      this.walletBalances = {
        sol: prev?.sol ?? null,
        usdc: prev?.usdc ?? null,
        at: prev?.at ?? read.at,
        error: read.error ?? "Wallet balance unknown"
      };
      return this.walletBalances;
    }
    this.walletBalances = read;
    if (this.liveBook && read.usdc != null) {
      this.liveBook.cashUsd = roundUsd(read.usdc);
      if (!(this.liveStartingUsd > 0)) {
        let held = 0;
        for (const pos of this.liveBook.positions.values()) held += pos.qty * this.liveBook.price(pos.mint, pos.entryPrice);
        this.liveStartingUsd = roundUsd(read.usdc + held);
      }
      this.persist();
    }
    return read;
  }

  /**
   * v13.33 the wallet card starts a read and returns. The HTTP handler must not wait on Helius.
   * At most one read per 10s when the last one succeeded.
   */
  refreshWalletInBackground(): void {
    if (!this.walletStatus.walletPublicKey && this.config.mode !== "live") return;
    const bal = this.walletBalances;
    if (bal && bal.error == null && Date.now() - bal.at < 10_000) return;
    void this.refreshWallet().catch((err) => console.error("[desk] wallet refresh", err));
  }

  /** v13.5 the wallet card's refresh button. v13.33 does not block the caller on the RPC. */
  async refreshWalletThrottled(): Promise<void> {
    this.refreshWalletInBackground();
  }

  /** How long a live buy waits for a fresh balance before it uses a recent cache or refuses. */
  private async refreshWalletBounded(ms: number): Promise<WalletBalances | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.refreshWallet().catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * A live check still reads the wallet. The wait is bounded so a full Helius queue cannot
   * hold the order open. Buys fall back only to a successful cache younger than 60s, and the
   * dollar and SOL checks still run. Exits may use an older successful SOL figure so a stop
   * is not left open when the last good read is past that window. An error or an empty cache refuses.
   */
  /** A live position that filled moments ago. Its booked qty is the amount the sell may send. */
  private recentLiveFill(pos: { live?: boolean; openedAt: number } | undefined, now = Date.now()): boolean {
    if (!pos?.live) return false;
    const age = now - pos.openedAt;
    return age >= 0 && age <= RECENT_LIVE_FILL_MS;
  }

  private async liveBalance(kind: "buy" | "exit", pump = false, waitMs = LIVE_BALANCE_WAIT_MS): Promise<WalletBalances | null> {
    const read = await this.refreshWalletBounded(waitMs);
    const usable = (row: WalletBalances | null): row is WalletBalances =>
      !!row && row.error == null && row.sol != null && (kind === "exit" || pump || row.usdc != null);
    if (usable(read)) return read;
    const cached = this.walletBalances;
    if (!usable(cached)) return null;
    if (kind === "buy" && Date.now() - cached.at > LIVE_BALANCE_CACHE_MS) return null;
    return cached;
  }

  /** v13.5 USD spent on live buys today (desk-host local day). */
  liveSpentTodayUsd(now = Date.now()): number {
    const saved = this.store.readJson("liveSpend") as { day?: string; usd?: number } | null;
    return saved && saved.day === localDay(now) && typeof saved.usd === "number" && Number.isFinite(saved.usd) ? saved.usd : 0;
  }

  private noteLiveSpend(usd: number): void {
    const day = localDay(Date.now());
    this.store.writeJson("liveSpend", { day, usd: roundUsd(this.liveSpentTodayUsd() + usd) });
  }

  /**
   * Fail-closed live pre-checks. Jupiter buys need USDC plus fee SOL.
   * A pump.fun curve or PumpSwap buy spends SOL, so it checks SOL against the $ size.
   * The live daily cap still counts dollars. An unknown balance refuses the buy.
   */
  private async liveBuyReady(sizeUsd: number, pump = false): Promise<{ ok: true } | { ok: false; error: string; code: "LIVE_WALLET" | "LIVE_DAILY_CAP" | "LIVE_NOT_ARMED" }> {
    if (this.liveDailyCapUsd != null) {
      const spent = this.liveSpentTodayUsd();
      if (spent + sizeUsd > this.liveDailyCapUsd + 1e-9) {
        return {
          ok: false,
          error: `Live daily cap ${money(this.liveDailyCapUsd)} reached (${money(spent)} spent today).`,
          code: "LIVE_DAILY_CAP"
        };
      }
    }
    const read = await this.liveBalance("buy", pump);
    if (!read || read.error != null || read.sol == null || (!pump && read.usdc == null)) {
      return { ok: false, error: `Wallet balance unknown${read?.error ? ` (${read.error})` : ""}. Live buy refused.`, code: "LIVE_WALLET" };
    }
    if (pump) {
      const solPx = await this.solUsd();
      if (!solPx) return { ok: false, error: "No fresh SOL/USD price. Live pump buy refused. Nothing was sent.", code: "LIVE_WALLET" };
      const need = sizeUsd / solPx + MIN_FEE_SOL;
      if (read.sol < need) {
        return { ok: false, error: `Wallet has ${read.sol.toFixed(4)} SOL. This pump buy needs about ${need.toFixed(4)} SOL (${money(sizeUsd)} plus fees).`, code: "LIVE_WALLET" };
      }
      return { ok: true };
    }
    if (read.sol < MIN_FEE_SOL) {
      return { ok: false, error: `Wallet has ${read.sol.toFixed(4)} SOL. Keep at least ${MIN_FEE_SOL} SOL for fees.`, code: "LIVE_WALLET" };
    }
    if ((read.usdc ?? 0) < sizeUsd) {
      return { ok: false, error: `Wallet has ${money(read.usdc ?? 0)} USDC. A live buy spends ${money(sizeUsd)} USDC.`, code: "LIVE_WALLET" };
    }
    return { ok: true };
  }

  private persistUnconfirmed(): void {
    this.store.writeJson("liveUnconfirmed", [...this.unconfirmedLive.values()]);
  }

  private rememberUnconfirmed(row: UnconfirmedLive): void {
    this.unconfirmedLive.set(`${row.side}:${row.mint}`, row);
    this.persistUnconfirmed();
    this.log({
      stage: "executor",
      kind: "reject",
      mint: row.mint,
      symbol: row.symbol,
      code: "LIVE_UNCONFIRMED",
      message: row.message,
      detail: row.signature ?? "no signature"
    });
  }

  /**
   * A previous live swap for this mint may already be on the network.
   * Failed on chain: drop the hold and let this request continue.
   * Confirmed or still unknown: do not send another swap and do not invent a fill.
   */
  private async blockIfUnconfirmed(mint: string, side: "buy" | "sell", symbol: string): Promise<ManualBuyRefusal | null> {
    const key = `${side}:${mint}`;
    const held = this.unconfirmedLive.get(key);
    if (!held) return null;
    if (held.signature && !held.landed) {
      const status = await this.lookupSignature(held.signature);
      if (status === "failed") {
        this.unconfirmedLive.delete(key);
        this.persistUnconfirmed();
        this.log({
          stage: "executor",
          kind: "reject",
          mint,
          symbol,
          code: "LIVE_SWAP_FAILED",
          message: `Signature ${held.signature} failed on chain. Nothing was filled.`,
          detail: held.signature
        });
        return null;
      }
      if (status === "confirmed") {
        held.landed = true;
        this.persistUnconfirmed();
      }
    }
    const sig = held.signature ? ` Signature ${held.signature}.` : "";
    const landed = held.landed
      ? " It has since confirmed on chain. The desk did not book a fill from that and did not send another swap."
      : " Confirmation is still unknown.";
    return {
      ok: false,
      error: `A live ${side} for ${symbol} was already submitted.${landed}${sig} Nothing new was sent.`,
      code: "LIVE_UNCONFIRMED",
      signature: held.signature ?? undefined,
      submitState: "submitted_unknown"
    };
  }

  private async lookupSignature(signature: string): Promise<"confirmed" | "failed" | "unknown"> {
    if (this.signatureStatus) return this.signatureStatus(signature);
    try {
      const web3 = await import("@solana/web3.js");
      const connection = new web3.Connection(this.config.walletRpcUrl, { commitment: "confirmed", fetch: this.net.fetchAt(1) });
      const rows = await connection.getSignatureStatuses([signature]);
      const row = rows.value[0];
      if (!row) return "unknown";
      if (row.err) return "failed";
      if (row.confirmationStatus === "confirmed" || row.confirmationStatus === "finalized") return "confirmed";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Jupiter for listed coins. The official pump SDK for a pump.fun curve or PumpSwap coin. */
  private async runLiveSwap(input: {
    side: "buy" | "sell";
    mint: string;
    sizeUsd?: number;
    qty?: number;
    decimals?: number | null;
    markPriceUsd?: number;
    dex?: string;
    priceFeed?: string;
    exit?: boolean;
    /** The qty is the amount the just-confirmed buy booked. A missing token-account read must not refuse the sell. */
    confirmedFill?: boolean;
    /** Manual close that the operator confirmed past the exit cap. Engine exits never set this. */
    sellAnyway?: boolean;
  }): Promise<LiveSwapResult> {
    const slip = input.exit ? (this.maxExitSlippage ?? this.config.rules.maxEntrySlippage + HARD_RULES.exitImpactSlack) : this.config.rules.maxEntrySlippage;
    if (usesPumpRoute(input)) {
      const sol = await this.solUsd();
      if (!sol) throw new Error("LIVE_SWAP_FAILED: no fresh SOL/USD price. Nothing was sent.");
      if (!this.config.walletRpcUrl?.trim()) throw new Error("LIVE_SWAP_FAILED: SOLANA_RPC_URL is missing. Nothing was sent.");
      const { executePumpLiveSwap } = await import("../market/pump-live.js");
      return executePumpLiveSwap({
        side: input.side,
        mint: input.mint,
        sizeUsd: input.sizeUsd,
        qty: input.qty,
        decimals: input.decimals,
        solPriceUsd: sol,
        markPriceUsd: input.markPriceUsd,
        slippageFraction: input.sellAnyway === true ? 0.5 : slip,
        exitCap: slip,
        sellAnyway: input.sellAnyway === true,
        keypairPath: this.config.walletKeypairPath,
        readEnvSecret: this.config.readWalletSecret,
        rpcUrl: this.config.walletRpcUrl,
        rpcFetch: this.net.fetchAt(1),
        senderTipLamports: tipLamports(this.senderTipSol),
        idemKey: randomUUID()
      });
    }
    const { executeLiveSwap } = await import("../market/live-broker.js");
    return executeLiveSwap({
      side: input.side,
      mint: input.mint,
      sizeUsd: input.sizeUsd,
      qty: input.qty,
      decimals: input.decimals,
      keypairPath: this.config.walletKeypairPath,
      readEnvSecret: this.config.readWalletSecret,
      rpcUrl: this.config.walletRpcUrl,
      quoteUrl: this.config.jupiterQuoteUrl,
      swapUrl: this.config.jupiterSwapUrl,
      markPriceUsd: input.markPriceUsd,
      maxEntrySlippage: this.config.rules.maxEntrySlippage,
      maxExitSlippage: input.exit ? slip : undefined,
      confirmedFill: input.confirmedFill === true,
      sellAnyway: input.exit === true && input.sellAnyway === true,
      rpcFetch: this.net.fetchAt(1),
      senderTipLamports: tipLamports(this.senderTipSol),
      idemKey: randomUUID()
    });
  }

  /** v13.5 wallet card. Public address and balances only. */
  walletView(): WalletView {
    const bal = this.walletBalances;
    const sol = this.displaySolUsd();
    return {
      keyLoaded: this.walletStatus.keypairPresent,
      keySource: this.walletStatus.keySource,
      keyInvalid: this.walletStatus.keyInvalid,
      publicKey: this.walletStatus.walletPublicKey,
      solBalance: bal?.sol ?? null,
      usdcBalance: bal?.usdc ?? null,
      // Display only. Jupiter wrapped SOL, or a Dex SOL-quoted pool, cached with solPriceAt. No extra Helius read.
      solPriceUsd: sol?.value ?? null,
      solPriceAt: sol?.at ?? null,
      balanceAt: bal?.at ?? null,
      balanceAgeMs: bal ? Math.max(0, Date.now() - bal.at) : null,
      balanceStale: bal == null || bal.error != null || Date.now() - bal.at > LIVE_BALANCE_CACHE_MS,
      balanceError: bal?.error ?? null,
      live: this.config.mode === "live",
      liveScope: this.liveScopeNow(),
      liveScopeLine: this.liveScopeLine(),
      liveAutoBuy: this.liveAutoBuy,
      liveRequested: this.config.liveRequested,
      rpcPublic: isPublicRpc(this.config.walletRpcUrl),
      liveTradeUsd: this.liveTradeUsd,
      liveDailyCapUsd: this.liveDailyCapUsd,
      liveTrailPct: this.liveTrailPct,
      liveSpentTodayUsd: this.liveSpentTodayUsd(),
      minFeeSol: MIN_FEE_SOL
    };
  }

  private log(event: Omit<FeedEvent, "id" | "ts">, payload?: unknown): void {
    const full: FeedEvent = { ...event, id: randomUUID(), ts: Date.now() };
    this.store.appendEvent(full, payload ?? null);
    this.bus.emit("log.event", full);
  }

  /** AI buys stop on a blocked mint, an unread mint, or a flagged launch bundle. */
  private async buyIfSafe(
    report: { token: import("../types.js").CandidateToken; score: number; breakdown: import("../types.js").ScoreFactor[]; decision: "trade" | "reject"; reason?: import("../types.js").Rejection },
    order?: { sizeUsd: number; tag: string; meta: StrategyMeta }
  ): Promise<void> {
    // Priority -1 is the manual-buy priority, so a paper engine buy is not buried behind mark polls.
    const safety = await this.tokenSafety(report.token.mint, -1, true);
    if (safety.status !== "safe") {
      this.pipeline.executorSkips += 1;
      this.log({
        stage: "executor",
        kind: "reject",
        mint: report.token.mint,
        symbol: report.token.symbol,
        code: "TOKEN_SAFETY",
        message: `AI buy skipped ${report.token.symbol}. ${safety.chip}.`
      });
      return;
    }
    if (isPumpCoin(report.token)) {
      const bundle = await this.launchBundle(report.token.mint, safety.supply);
      if (bundle && "flagged" in bundle && bundle.flagged) {
        this.pipeline.executorSkips += 1;
        this.log({
          stage: "executor",
          kind: "reject",
          mint: report.token.mint,
          symbol: report.token.symbol,
          code: "BUNDLED",
          message: `AI buy skipped ${report.token.symbol}. ${bundle.label ?? "Bundled"}.`
        });
        return;
      }
    }
    await this.buy(report, order);
  }

  private cardChips(mint: string): { safetyChip: string; bundleChip: string | null } {
    void this.tokenSafety(mint);
    if (isPumpCoin({ source: this.sightings.get(mint)?.source, dex: this.sightings.get(mint)?.dex })) {
      void this.launchBundle(mint, this.peekSafety(mint).supply);
    }
    const bundle = this.bundleCache.get(mint)?.result;
    return { safetyChip: this.peekSafety(mint).chip, bundleChip: bundle?.label ?? null };
  }

  private safetyChipList(): Array<{ mint: string; safety: string; bundle?: string }> {
    const mints = new Set<string>([
      ...this.book.positions.keys(),
      ...(this.liveBook ? this.liveBook.positions.keys() : []),
      ...this.watchlist.map((item) => item.mint),
      ...this.safetyCache.keys()
    ]);
    const out: Array<{ mint: string; safety: string; bundle?: string }> = [];
    for (const mint of mints) {
      if (out.length >= 80) break;
      const safety = this.safetyCache.get(mint)?.result;
      const bundle = this.bundleCache.get(mint)?.result;
      if (!safety && !bundle?.label) continue;
      out.push({ mint, safety: safety?.chip ?? "Unknown", ...(bundle?.label ? { bundle: bundle.label } : {}) });
    }
    return out;
  }

  private peekSafety(mint: string): MintSafety {
    return this.safetyCache.get(mint)?.result ?? SAFETY_UNKNOWN;
  }

  private async tokenSafety(mint: string, priority: -1 | 0 | 1 | 2 = 2, readLane = false): Promise<MintSafety> {
    const front = priority === -1;
    // readLane is the engine entry (paper buyIfSafe and the live engine buy). Manual buys stay on MINT_SAFETY_MS.
    const budgetMs = readLane ? ENGINE_SAFETY_MS : MINT_SAFETY_MS;
    const hit = this.safetyCache.get(mint);
    // A front-of-queue caller (a buy) does not settle for a cached "unknown": that is usually a
    // background read that timed out in the queue, and this caller can jump that queue.
    if (hit && Date.now() - hit.at < hit.ttl && !(front && hit.result.status === "unknown")) return hit.result;
    const pending = this.safetyInflight.get(mint);
    if (pending && pending.priority <= priority) {
      if (pending.budgetMs > budgetMs) return this.capSafety(pending.job, budgetMs);
      if (pending.budgetMs === budgetMs) return pending.job;
      // A shorter in-flight read may already be holding the lane slot. Keep its answer when it
      // is Safe or Blocked. Unknown is that read's own timeout, so this caller starts its longer one.
      return pending.job.then((result) => (result.status === "unknown" ? this.tokenSafety(mint, priority, readLane) : result));
    }
    pending?.abort();
    const flight: { priority: -1 | 0 | 1 | 2; budgetMs: number; job: Promise<MintSafety>; abort: () => void } = {
      priority,
      budgetMs,
      job: Promise.resolve(SAFETY_UNKNOWN),
      abort: () => {}
    };
    flight.job = this.readMintSafety(mint, priority, readLane, budgetMs, flight).finally(() => {
      if (this.safetyInflight.get(mint) === flight) this.safetyInflight.delete(mint);
    });
    this.safetyInflight.set(mint, flight);
    return flight.job;
  }

  /** A caller with a shorter budget does not abort a longer in-flight read, and does not wait past its own budget. */
  private capSafety(job: Promise<MintSafety>, budgetMs: number): Promise<MintSafety> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(SAFETY_UNKNOWN), budgetMs);
      job.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        () => {
          clearTimeout(timer);
          resolve(SAFETY_UNKNOWN);
        }
      );
    });
  }

  private async readMintSafety(
    mint: string,
    priority: -1 | 0 | 1 | 2,
    readLane: boolean,
    budgetMs: number,
    flight: { job: Promise<MintSafety>; abort: () => void }
  ): Promise<MintSafety> {
    const ac = new AbortController();
    flight.abort = () => ac.abort();
    const timer = setTimeout(() => ac.abort(), budgetMs);
    let account: MintAccountBytes | null = null;
    try {
      const read = this.mintAccounts ? this.mintAccounts(mint) : this.rpcMintAccount(mint, priority, ac.signal, readLane);
      account = await Promise.race([
        read.catch(() => null),
        new Promise<null>((resolve) => ac.signal.addEventListener("abort", () => resolve(null), { once: true }))
      ]);
    } catch {
      account = null;
    } finally {
      clearTimeout(timer);
    }
    const result = decodeMintSafety(account);
    // A superseded chip read must not cache Unknown over the engine read that replaced it.
    if (this.safetyInflight.get(mint)?.job !== flight.job) return result;
    const ttl = result.status === "unknown" ? 15_000 : 10 * 60_000;
    this.safetyCache.set(mint, { at: Date.now(), ttl, result });
    return result;
  }

  private async rpcMintAccount(mint: string, priority: -1 | 0 | 1 | 2 = 2, signal?: AbortSignal, readLane = false): Promise<MintAccountBytes | null> {
    const rpc = (this.config.walletRpcUrl || this.config.rpcUrl || "").trim();
    if (!rpc) return null;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [mint, { encoding: "base64", commitment: "confirmed" }]
    });
    const res = await this.net.fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body, signal, ndPriority: priority, ndReadLane: readLane });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: { value?: { owner?: string; data?: [string, string] } | null } };
    const value = json.result?.value;
    if (!value?.owner || !value.data?.[0]) return null;
    return { owner: value.owner, data: Buffer.from(value.data[0], "base64") };
  }

  private async launchBundleSoon(mint: string, supply: bigint | null): Promise<BundleResult | null> {
    const cached = this.bundleCache.get(mint);
    if (cached && (cached.forever || Date.now() - cached.at < 10 * 60_000)) return cached.result;
    const result = await Promise.race([
      this.launchBundle(mint, supply),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500))
    ]);
    if (result == null || isBundleFailure(result)) return null;
    return result;
  }

  /**
   * Engine live buy only. Priority -1 on the read lane, then fail closed.
   * ENGINE_LIVE_BUNDLE_MS covers two read-lane calls. A timeout and an RPC error are logged apart.
   * Manual buys keep the 1.5s launchBundleSoon budget.
   */
  private async engineLiveBundle(mint: string, supply: bigint | null): Promise<BundleResult | BundleFailure | null> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const result = await Promise.race([
        this.launchBundle(mint, supply, { priority: -1, signal: ac.signal, failClosed: true }).catch((): BundleFailure => ({
          reason: "rpc"
        })),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            ac.abort();
            resolve(null);
          }, ENGINE_LIVE_BUNDLE_MS);
        })
      ]);
      if (result && "flagged" in result) return result;
      if (timedOut) return { reason: "timeout" };
      if (result && "reason" in result) return result;
      return null;
    } catch {
      return { reason: timedOut ? "timeout" : "rpc" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async launchBundle(
    mint: string,
    supply: bigint | null,
    opts?: { priority?: -1 | 0 | 1 | 2; signal?: AbortSignal; failClosed?: boolean }
  ): Promise<BundleResult | BundleFailure | null> {
    const cached = this.bundleCache.get(mint);
    // A failed paper read is cached as not-bundled for ten minutes. A live buy must not treat that as verified.
    if (cached && (cached.forever || (!opts?.failClosed && Date.now() - cached.at < 10 * 60_000))) return cached.result;
    if (this.launchBundleFn) {
      const injected = await this.launchBundleFn(mint);
      const result = injected ?? { flagged: false, pct: 0, label: null, acquired: 0n };
      this.bundleCache.set(mint, { at: Date.now(), forever: injected != null, result });
      return result;
    }
    if (process.env.VITEST) {
      const result = { flagged: false, pct: 0, label: null, acquired: 0n };
      this.bundleCache.set(mint, { at: Date.now(), forever: true, result });
      return result;
    }
    const raw = await this.rpcBundle(mint, supply, opts?.priority ?? 2, opts?.signal);
    const result = isBundleFailure(raw) ? null : raw;
    if (!result) {
      if (opts?.failClosed || opts?.signal?.aborted) {
        if (isBundleFailure(raw)) return raw;
        if (opts?.signal?.aborted) return { reason: "timeout" };
        return null;
      }
      const kept = this.bundleCache.get(mint);
      if (kept?.forever) return kept.result;
      const empty: BundleResult = { flagged: false, pct: 0, label: null, acquired: 0n };
      this.bundleCache.set(mint, { at: Date.now(), forever: false, result: empty });
      return empty;
    }
    this.bundleCache.set(mint, { at: Date.now(), forever: true, result });
    return result;
  }

  /** Set once the RPC has refused a batched request. The bundle check then reads the slot directly. */
  private bundleBatchOff = false;

  private async rpcBundle(mint: string, supply: bigint | null, priority: -1 | 0 | 1 | 2 = 2, signal?: AbortSignal): Promise<BundleResult | BundleFailure | null> {
    if (supply == null || supply <= 0n) return null;
    const rpc = (this.config.walletRpcUrl || this.config.rpcUrl || "").trim();
    if (!rpc) return null;
    const front = priority === -1;
    let upper: BundleResult | null = null;
    try {
      const sigBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [mint, { limit: 1000, commitment: "confirmed" }]
      });
      const sigRes = await this.net.fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sigBody,
        signal,
        ndPriority: priority,
        ndReadLane: front,
        ...(front ? { timeoutMs: ENGINE_LIVE_BUNDLE_MS } : {})
      });
      if (signal?.aborted) return { reason: "timeout" };
      if (!sigRes.ok) return { reason: "rpc" };
      const sigJson = (await sigRes.json()) as { error?: unknown; result?: Array<{ slot?: number; signature?: string; err?: unknown }> };
      if (sigJson.error) return { reason: "rpc" };
      const rows = sigJson.result ?? [];
      if (!rows.length || rows.length >= 1000) return null;
      const slot = rows[rows.length - 1]?.slot;
      if (slot == null) return null;
      // Every launch-slot buy of this coin names the mint, so it is already in the list above.
      // Reading just those transactions is a few kilobytes. The whole slot is megabytes.
      // Failed transactions moved no tokens and are left out.
      const launchRows = rows.filter((row) => row.slot === slot);
      const launchSigs = launchRows.filter((row) => row.err == null && typeof row.signature === "string").map((row) => row.signature!);
      const listed = launchRows.every((row) => typeof row.signature === "string");
      // A launch-slot transfer that moves the coin between wallets without naming the mint is not
      // in that list, so the batch can count a share too high, never too low. A clean batch is
      // therefore final. A flagged one is checked against the whole slot before it is believed.
      if (!this.bundleBatchOff && listed && launchSigs.length > 0 && launchSigs.length <= BUNDLE_TX_BATCH_MAX) {
        const txBody = JSON.stringify(
          launchSigs.map((signature, id) => ({
            jsonrpc: "2.0",
            id,
            method: "getTransaction",
            params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]
          }))
        );
        const txRes = await this.net.fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: txBody,
          signal,
          ndPriority: priority,
          ndReadLane: front,
          ...(front ? { timeoutMs: ENGINE_LIVE_BUNDLE_MS } : {})
        });
        if (signal?.aborted) return { reason: "timeout" };
        const txJson = txRes.ok ? ((await txRes.json().catch(() => null)) as unknown) : null;
        // An RPC that answers a batch with a single error object does not take batches. Stop
        // asking, so every later check is two requests again and not three.
        if (!Array.isArray(txJson) && (txRes.status === 400 || (txRes.ok && txJson != null))) this.bundleBatchOff = true;
        const txs = Array.isArray(txJson) ? txJson.map((row) => (row as { result?: SlotTransaction | null })?.result ?? null) : [];
        // All of them or none: a missing transaction could be the bundled buy.
        if (txs.length === launchSigs.length && txs.every((tx) => tx != null)) {
          const activity = slotActivity(mint, txs as SlotTransaction[]);
          const share = bundleShare({ supply, deltas: activity.deltas, excluded: pumpExcluded(mint), funders: activity.funders });
          if (!share.flagged) return share;
          upper = share;
        }
        // Flagged, refused or incomplete: fall through to the whole-slot read.
      }
      // Accounts, not full transactions: token balances and account keys are enough to
      // measure the launch share. Rewards and decoded instructions stay off so the slot is small.
      const blockBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBlock",
        params: [slot, { encoding: "jsonParsed", transactionDetails: "accounts", rewards: false, maxSupportedTransactionVersion: 0, commitment: "confirmed" }]
      });
      const blockRes = await this.net.fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: blockBody,
        signal,
        ndPriority: priority,
        ndReadLane: front,
        ...(front ? { timeoutMs: ENGINE_LIVE_BUNDLE_MS } : {})
      });
      // With no slot read to check it against, a flagged batch stands: it errs toward not buying.
      if (signal?.aborted) return upper ?? { reason: "timeout" };
      if (!blockRes.ok) return upper ?? { reason: "rpc" };
      const blockJson = (await blockRes.json()) as { error?: unknown; result?: { transactions?: SlotTransaction[] } | null };
      if (blockJson.error || blockJson.result == null) return upper ?? { reason: "rpc" };
      const txs = blockJson.result.transactions ?? [];
      const activity = slotActivity(mint, txs);
      return bundleShare({ supply, deltas: activity.deltas, excluded: pumpExcluded(mint), funders: activity.funders });
    } catch (err) {
      if (upper) return upper;
      if (signal?.aborted || isAbortError(err)) return { reason: "timeout" };
      return { reason: "rpc" };
    }
  }

  private track(job: Promise<unknown>): void {
    const guarded = job.catch((err) => {
      console.error("[desk] stage failed", err);
    });
    this.inflight.add(guarded);
    void guarded.finally(() => this.inflight.delete(guarded));
  }

  private async drain(): Promise<void> {
    while (this.inflight.size) {
      await Promise.all([...this.inflight]);
    }
  }
}

function clampSenderTipSol(raw: number): number {
  const lamports = Math.round(raw * 1_000_000_000);
  const clamped = Math.min(10_000_000, Math.max(5_000, lamports));
  return clamped / 1_000_000_000;
}

function sampleOf(token: { volume1hUsd: number; top10HolderPct: number | null; liquidityUsd: number; ageSeconds: number; onBondingCurve?: boolean }, score?: number): FeatureSample {
  return {
    volume1hUsd: token.volume1hUsd,
    top10HolderPct: token.top10HolderPct,
    liquidityUsd: token.liquidityUsd,
    ageSeconds: token.ageSeconds,
    onBondingCurve: token.onBondingCurve === true,
    score
  };
}

export function watchChange(addedPriceUsd: number, lastPriceUsd: number): number | null {
  if (!(addedPriceUsd > 0) || !(lastPriceUsd > 0) || !Number.isFinite(addedPriceUsd) || !Number.isFinite(lastPriceUsd)) return null;
  return (lastPriceUsd - addedPriceUsd) / addedPriceUsd;
}

/** Reads the stored watchlist. Rows without a mint or a positive added price are dropped. */
export function loadWatchlist(raw: unknown): WatchItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Partial<WatchItem>;
    if (typeof r.mint !== "string" || !r.mint || !(typeof r.addedPriceUsd === "number" && r.addedPriceUsd > 0)) continue;
    const last = typeof r.lastPriceUsd === "number" && r.lastPriceUsd > 0 ? r.lastPriceUsd : null;
    out.push({
      mint: r.mint,
      symbol: typeof r.symbol === "string" ? r.symbol : r.mint.slice(0, 4),
      name: typeof r.name === "string" ? r.name : "",
      platform: typeof r.platform === "string" ? r.platform : "Mint",
      addedAt: typeof r.addedAt === "number" ? r.addedAt : Date.now(),
      addedPriceUsd: r.addedPriceUsd,
      lastPriceUsd: last,
      lastAt: typeof r.lastAt === "number" ? r.lastAt : null,
      changePct: last == null ? null : watchChange(r.addedPriceUsd, last),
      dexscreenerUrl: typeof r.dexscreenerUrl === "string" ? r.dexscreenerUrl : dexscreenerUrl(r.mint)
    });
  }
  return out.slice(0, WATCHLIST_MAX);
}

function exitVerb(code: string): string {
  if (code === "STOP_LOSS") return "stopped";
  if (code === "TRAIL_STOP") return "trailed";
  if (code === "GAP_RUG") return "gapped through the stop on";
  if (code === "MANUAL_CLOSE") return "closed";
  if (code === "PARTIAL_SELL") return "trimmed";
  return "exited";
}

/** v13.1 tape extras: 5m volume and 1h price change, only when the feed gave real numbers. */
export function scoutExtras(token: { volume5mUsd?: number; priceChange1hPct?: number }): string {
  let out = "";
  const v5 = token.volume5mUsd;
  if (typeof v5 === "number" && Number.isFinite(v5) && v5 > 0) out += `, 5m volume ${money(v5)}`;
  const ch = token.priceChange1hPct;
  if (typeof ch === "number" && Number.isFinite(ch)) out += `, 1h change ${ch > 0 ? "+" : ch < 0 ? "-" : ""}${Math.abs(ch).toFixed(1)}%`;
  return out;
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedPctText(f: number): string {
  if (!Number.isFinite(f)) return "—";
  const v = f * 100;
  const digits = Math.abs(v) >= 99 && Math.abs(v) < 100 ? 1 : Math.abs(v) < 10 ? 1 : 0;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
}

function signed(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function originLabel(origin?: MarkOrigin): string {
  if (!origin?.feed && !origin?.pairAddress) return "an unmarked tick";
  const pair = origin.pairAddress ? ` pair ${origin.pairAddress.slice(0, 4)}` : "";
  return `${origin.feed ?? "unknown"}${pair}`;
}

function price(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0";
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return tinyPx(n);
}

function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(rows[Math.round(i * step)]!);
  return out;
}

export { entryAllowed };
export type { CoinLookup, CoinLookupError } from "../types.js";

/** Max gap between DexScreener's curve price and Jupiter's before a lookup refuses to price. */
export const LOOKUP_PRICE_AGREEMENT = 0.25;

/** Search must answer before the phone's lookup client gives up and prints "timeout". */
const LOOKUP_PRICE_MS = 3_500;
const LOOKUP_CURVE_MS = 1_500;
/** Android Search uses lookupHttp, whose call timeout is 8s. The 12s client is the paper-buy path. */
const LOOKUP_CLIENT_MS = 8_000;
/** Room to write the response after price, chain, safety, and the bundle check. */
const LOOKUP_TAIL_MS = 700;
/** A scout or lookup this fresh can fill chain fields a later read did not get. */
export const CHAIN_FACT_MAX_AGE_MS = 30 * 60_000;

/**
 * Time left for Alchemy and RugCheck after the price feeds, inside the 8s lookup client.
 * Safety and the bundle check are already in flight, so the tail is only the response.
 * A test may set NIGHT_DESK_LOOKUP_CHAIN_MS so a hung provider does not wait out the phone budget.
 */
export function lookupChainBudgetMs(elapsedMs: number): number {
  if (process.env.VITEST) {
    const override = Number(process.env.NIGHT_DESK_LOOKUP_CHAIN_MS);
    if (Number.isFinite(override) && override >= 0) return override;
  }
  return Math.max(0, LOOKUP_CLIENT_MS - LOOKUP_TAIL_MS - elapsedMs);
}

interface LookupAudit {
  providerNote?: string;
  chainTimedOut: boolean;
  providers: string[];
  checks: Array<{ code: string; pass: boolean; message: string }>;
}

function auditText(audit: LookupAudit): string {
  const checks = audit.checks.map((check) => `${check.code}:${check.pass ? "pass" : "fail"}`).join(",");
  const note = audit.providerNote ? ` Note: ${audit.providerNote}` : "";
  return ` chainTimedOut=${audit.chainTimedOut} providers=${audit.providers.join("|") || "none"} checks=${checks}.${note}`;
}

const CHAIN_FACT_FIELDS = ["mintAuthorityRevoked", "freezeAuthorityRevoked", "top10HolderPct", "holderCount", "lpLockedOrBurned", "devHoldingPct"] as const;
type ChainFactField = (typeof CHAIN_FACT_FIELDS)[number];

function chainFieldPresent(token: CandidateToken, field: ChainFactField): boolean {
  if (field === "devHoldingPct") return typeof token.devHoldingPct === "number" && Number.isFinite(token.devHoldingPct);
  return token[field] != null;
}

function chainFactFieldSet(token: CandidateToken): Set<ChainFactField> {
  return new Set(CHAIN_FACT_FIELDS.filter((field) => chainFieldPresent(token, field)));
}

function copyChainField(target: CandidateToken, source: CandidateToken, field: ChainFactField): void {
  if (field === "mintAuthorityRevoked") target.mintAuthorityRevoked = source.mintAuthorityRevoked;
  else if (field === "freezeAuthorityRevoked") target.freezeAuthorityRevoked = source.freezeAuthorityRevoked;
  else if (field === "top10HolderPct") target.top10HolderPct = source.top10HolderPct;
  else if (field === "holderCount") {
    target.holderCount = source.holderCount;
    target.holderCountAtLeast = source.holderCountAtLeast;
  } else if (field === "lpLockedOrBurned") {
    target.lpLockedOrBurned = source.lpLockedOrBurned;
    if (target.lpLockPct == null && source.lpLockPct != null) target.lpLockPct = source.lpLockPct;
    if (!target.lpLockPool && source.lpLockPool) target.lpLockPool = source.lpLockPool;
  } else {
    target.devHoldingPct = source.devHoldingPct;
    target.devHoldingUpperBound = source.devHoldingUpperBound;
  }
}

function clearChainField(target: CandidateToken, field: ChainFactField): void {
  if (field === "mintAuthorityRevoked") target.mintAuthorityRevoked = null;
  else if (field === "freezeAuthorityRevoked") target.freezeAuthorityRevoked = null;
  else if (field === "top10HolderPct") target.top10HolderPct = null;
  else if (field === "holderCount") target.holderCount = null;
  else if (field === "lpLockedOrBurned") target.lpLockedOrBurned = null;
  else target.devHoldingPct = null;
}

function chainVerified(token: CandidateToken): boolean {
  return (
    token.mintAuthorityRevoked != null ||
    token.top10HolderPct != null ||
    token.holderCount != null ||
    token.lpLockedOrBurned != null ||
    (typeof token.devHoldingPct === "number" && Number.isFinite(token.devHoldingPct))
  );
}

function fillMissingChain(target: CandidateToken, chain: CandidateToken): void {
  if (target.mintAuthorityRevoked == null && chain.mintAuthorityRevoked != null) target.mintAuthorityRevoked = chain.mintAuthorityRevoked;
  if (target.top10HolderPct == null && chain.top10HolderPct != null) target.top10HolderPct = chain.top10HolderPct;
  if (target.holderCount == null && chain.holderCount != null) {
    target.holderCount = chain.holderCount;
    target.holderCountAtLeast = chain.holderCountAtLeast;
  }
  if (target.freezeAuthorityRevoked == null && chain.freezeAuthorityRevoked != null) target.freezeAuthorityRevoked = chain.freezeAuthorityRevoked;
  if (target.lpLockedOrBurned == null && chain.lpLockedOrBurned != null) {
    target.lpLockedOrBurned = chain.lpLockedOrBurned;
    if (target.lpLockPct == null && chain.lpLockPct != null) target.lpLockPct = chain.lpLockPct;
    if (!target.lpLockPool && chain.lpLockPool) target.lpLockPool = chain.lpLockPool;
  }
  if (!target.devWallet && chain.devWallet) target.devWallet = chain.devWallet;
  if (!(typeof target.devHoldingPct === "number" && Number.isFinite(target.devHoldingPct)) && chain.devHoldingPct != null) {
    target.devHoldingPct = chain.devHoldingPct;
    target.devHoldingUpperBound = chain.devHoldingUpperBound;
  }
  if (!target.poolAddresses?.length && chain.poolAddresses?.length) target.poolAddresses = chain.poolAddresses;
  if (!target.holderSample && chain.holderSample) target.holderSample = chain.holderSample;
  if (!target.devRug && chain.devRug) target.devRug = chain.devRug;
  if (target.decimals == null && chain.decimals != null) target.decimals = chain.decimals;
  if (target.onBondingCurve == null && chain.onBondingCurve != null) target.onBondingCurve = chain.onBondingCurve;
}

function applyChainFields(target: CandidateToken, chain: CandidateToken): void {
  if (chain.mintAuthorityRevoked != null) target.mintAuthorityRevoked = chain.mintAuthorityRevoked;
  if (chain.top10HolderPct != null) target.top10HolderPct = chain.top10HolderPct;
  if (chain.holderCount != null) {
    target.holderCount = chain.holderCount;
    target.holderCountAtLeast = chain.holderCountAtLeast;
  }
  if (chain.freezeAuthorityRevoked != null) target.freezeAuthorityRevoked = chain.freezeAuthorityRevoked;
  if (chain.lpLockedOrBurned != null) target.lpLockedOrBurned = chain.lpLockedOrBurned;
  if (chain.lpLockPct != null) target.lpLockPct = chain.lpLockPct;
  if (chain.lpLockPool) target.lpLockPool = chain.lpLockPool;
  target.devWallet = target.devWallet ?? chain.devWallet;
  if (chain.devHoldingPct != null) {
    target.devHoldingPct = chain.devHoldingPct;
    target.devHoldingUpperBound = chain.devHoldingUpperBound;
  }
  if (chain.poolAddresses?.length) target.poolAddresses = chain.poolAddresses;
  if (chain.holderSample) target.holderSample = chain.holderSample;
  if (chain.devRug) target.devRug = chain.devRug;
  target.decimals = target.decimals ?? chain.decimals;
  if (chain.onBondingCurve != null) target.onBondingCurve = chain.onBondingCurve;
  if (chain.symbol && target.symbol === target.mint.slice(0, 4)) target.symbol = chain.symbol;
  if (chain.name && target.name === target.mint.slice(0, 6)) target.name = chain.name;
}

function blankLookupToken(mint: string): CandidateToken {
  return {
    mint,
    symbol: mint.slice(0, 4),
    name: mint.slice(0, 6),
    source: "raydium",
    discoveredAt: Date.now(),
    priceUsd: 0,
    liquidityUsd: 0,
    volume1hUsd: 0,
    ageSeconds: 0,
    mintAuthorityRevoked: null,
    lpLockedOrBurned: null,
    top10HolderPct: null,
    holderCount: null,
    devWallet: null,
    social: { mentions1h: 0, hasWebsite: false, hasTelegram: false, hasTwitter: false }
  };
}

/** Resolve with `fallback` when `work` is still pending. A late result is ignored. */
function takeFirst<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(fallback), ms);
    work.then(
      (value) => done(value),
      () => done(fallback)
    );
  });
}

/**
 * Dex with price and depth wins immediately. Otherwise wait until Jupiter has also
 * settled, or until `ms`. A hung provider does not hold the other one.
 */
async function lookupPriceFeeds(
  dex: Promise<CandidateToken | null>,
  jup: Promise<{ ok: true; priceUsd: number; liquidityUsd: number } | { ok: false; error?: string }>,
  ms: number
): Promise<{ token: CandidateToken | null; jup: { ok: true; priceUsd: number; liquidityUsd: number } | { ok: false; error?: string } }> {
  return new Promise((resolve) => {
    let token: CandidateToken | null | undefined;
    let quote: { ok: true; priceUsd: number; liquidityUsd: number } | { ok: false; error?: string } | undefined;
    let done = false;
    const finish = (force: boolean) => {
      if (done) return;
      const dexReady = !!token && token.priceFeed === "dexscreener" && token.priceUsd > 0 && token.liquidityUsd > 0;
      const jupReady = !!quote?.ok;
      if (!force && !dexReady && !(token !== undefined && quote !== undefined) && !(jupReady && token !== undefined)) return;
      if (!force && jupReady && token === undefined) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(jupGrace);
      resolve({ token: token ?? null, jup: quote ?? { ok: false } });
    };
    const timer = setTimeout(() => finish(true), ms);
    // Jupiter answered and Dex is still queued: don't wait out the whole budget.
    const jupGrace = setTimeout(() => {
      if (quote?.ok) finish(true);
    }, Math.min(1_500, ms));
    dex.then(
      (value) => {
        token = value;
        finish(false);
      },
      () => {
        token = null;
        finish(false);
      }
    );
    jup.then(
      (value) => {
        quote = value;
        finish(false);
      },
      () => {
        quote = { ok: false };
        finish(false);
      }
    );
    void jupGrace;
  });
}

/**
 * Jupiter price + liquidity for one mint. ok=false with no error means "Jupiter has nothing",
 * ok=false with an error means the two feeds disagree, which blocks the buy.
 */
export async function jupiterLookupQuote(
  mint: string,
  dexPriceUsd: number,
  fetchImpl: typeof fetch
): Promise<{ ok: true; priceUsd: number; liquidityUsd: number } | { ok: false; error?: string }> {
  let quote: { priceUsd: number; liquidityUsd: number } | undefined;
  try {
    quote = (await fetchJupiterQuotes([mint], fetchImpl)).get(mint);
  } catch {
    return { ok: false };
  }
  if (!quote || !(quote.priceUsd > 0) || !Number.isFinite(quote.priceUsd) || !(quote.liquidityUsd > 0)) return { ok: false };
  if (dexPriceUsd > 0 && Math.abs(quote.priceUsd / dexPriceUsd - 1) > LOOKUP_PRICE_AGREEMENT) {
    return {
      ok: false,
      error: `Prices disagree (DexScreener ${dexPriceUsd.toPrecision(4)} vs Jupiter ${quote.priceUsd.toPrecision(4)}). No reliable price, so Buy is off.`
    };
  }
  return { ok: true, priceUsd: quote.priceUsd, liquidityUsd: quote.liquidityUsd };
}

/** v13.5 YYYY-MM-DD on the desk host's clock (Austin is US Eastern). */
function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
