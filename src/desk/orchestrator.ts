import { tinyPx } from "../price-text.js";
import { NetLimiter } from "../market/net.js";
import { BANNER_AFTER_MS } from "../agents/feed-health.js";
import { fetchJupiterQuotes } from "../market/dex-prices.js";
import { randomUUID } from "node:crypto";
import { assessPosition, entryAllowed } from "../agents/risk.js";
import { HARD_RULES, SCORE_BAND, clampAgeMinutes, clampBuyUsd, clampCooldownHours, clampDailyLossUsd, clampDevHoldingPct, clampEntrySlippage, clampExitSlippage, slippageFromWire, clampHolderCount, clampLiquidityUsd, clampOpenPositions, clampPnlAlertPct, clampPositionPct, clampExposurePct, clampPositionUsd, clampResetUsd, SIZING_BAND, clampScore, clampStopLossPct, clampTop10, clampTradesPerHour, clampTrailArmPct, clampTrailGapPct, clampVolumeUsd, OPEN_POSITION_BAND, VOLUME_BOOST_BAND, clampVolumeBoost, POSITION_REFRESH_BAND, clampPositionRefreshMs, LIVE_BAND, clampLiveTradeUsd, clampLiveDailyCapUsd, liveTrailFromWire } from "../rules.js";
import { autoBuyBlock } from "./auto-gates.js";
import { classifyStopExit } from "./gap.js";
import { MomentumTracker } from "../market/momentum.js";
import { DEFAULT_SCOUT_SOURCES, type ScoutSources } from "../agents/scout.js";
import { evaluateFilter } from "../agents/filter.js";
import { scoreToken } from "../agents/analyst.js";
import { assertNonNegativeFinite, entryPriceAllowed, exitImpactAllowed, floorUsd, maxSizeForPool, planOrder, quotePaperBuy, quotePaperSell, resolveManualSize, roundUsd, splitPosition } from "../agents/execution-math.js";
import { dexscreenerUrl, parseCoinInput, positionTag } from "../market/coin-input.js";
import { resolveCoinMint } from "../market/coin-lookup.js";
import { DexSearchClient, matchLocal, rankDexSearch, tickerQuery, type LocalCoin, type TickerCandidate } from "../market/ticker-search.js";
import { enrichSighting } from "../market/enrich.js";
import { fetchDexQuotes } from "../market/dex-prices.js";
import { Scout } from "../agents/scout.js";
import { EventBus } from "../bus.js";
import type { MarksDelta } from "../types.js";
import type { DeskConfig } from "../config.js";
import { ReplayFeed } from "../demo/replay.js";
import { advise, AdvisorBook, noteEntry, noteKill, noteNearMissSurface, noteNearMissTaken, noteOutcome, notePass, type Advice, type FeatureSample, type WeakSurvivor } from "./advisor.js";
import { classifyNearMiss } from "./near-miss.js";
import { phraseAdvice } from "./commentary.js";
import { LOG_THROTTLE_MS, LIVE_FRESH_MS, REANCHOR_SILENT_MS, SHOCK_MOVE, isJump, markUnusable, needsShockConfirm, reanchorCandidate, sameMarkSource, type MarkOrigin, type ReanchorCandidate } from "../market/mark-guard.js";
import { buildRecap, recapReport, resetAtFromEquity, resolveRecapSince, type RecapReport } from "./recap.js";
import { PositionPricer, type LiveOrigin } from "../market/position-pricer.js";
import { ChainMarkReader, WSOL_MINT as SOL_MINT_ADDR, pumpCurveAddress } from "../market/chain-marks.js";
import { ChainStream, wsUrlFor } from "../market/chain-stream.js";
import { MIN_FEE_SOL, fetchWalletBalances, inspectDeskWallet, isPublicRpc, type DeskWalletStatus, type WalletBalances } from "../market/wallet-status.js";
import { LayeredRugRegistry, loadRugWalletMap, StaticRugRegistry } from "../market/rug-registry.js";
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
  WatchItem,
  WalletView,
  CoinLookup,
  CoinLookupError,
  BookKind,
  LiveBookView
} from "../types.js";
import { PaperBook } from "./book.js";

/** v13.7 per-book state maps (cooldowns, opening, marks) key live positions with this prefix. */
const LIVE_KEY = "live:";
function bookKey(kind: BookKind, mint: string): string {
  return kind === "live" ? `${LIVE_KEY}${mint}` : mint;
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
export class Desk {
  readonly bus = new EventBus<DeskEvents>();
  readonly book: PaperBook;
  readonly store: DeskStore;
  readonly config: DeskConfig;
  private readonly scout: Scout;
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
  private readonly lookups = new Map<string, { at: number; platform: string; token: CandidateToken }>();
  private watchlist: WatchItem[] = [];
  /** v13.6 ticker search (own spacing, cache and 429 backoff). */
  private dexSearch: DexSearchClient | null = null;
  private solUsdCache: { value: number; at: number } | null = null;
  private readonly curveQueue = new Set<string>();
  private curveTimer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private lastClientCrash: { at: number; version: string; brief: string } | null = null;
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
  /** v13.5 live daily spend cap. null = off (the default). */
  private liveDailyCapUsd: number | null = null;
  /** v13.5 live trailing stop, fraction. Armed from entry. */
  private liveTrailPct: number = LIVE_BAND.trailPct.fallback;
  /**
   * v13.7 live book. Exists only when the desk is armed (LIVE_TRADING=true + a valid key). The paper
   * book (`this.book`) always keeps running the AI; live holds real-money positions only.
   */
  liveBook: PaperBook | null = null;
  private liveStartingUsd = 0;
  private liveStartedAt = Date.now();
  /** v13.7 false (default): only Dirk's manual buys go live; the AI keeps buying on paper. */
  private liveAutoBuy = false;
  /** v13.5 last read-only wallet balance read. */
  private walletBalances: WalletBalances | null = null;
  private walletTimer: NodeJS.Timeout | null = null;
  private readonly walletReader: () => Promise<WalletBalances>;
  private readonly inflight = new Set<Promise<unknown>>();
  private cooldowns = new Map<string, number>();
  /** First >30% print inside 10s of entry, keyed by mint. The feed has to repeat it. */
  private shocks = new Map<string, { feed: string; price?: number }>();
  /** v13.2 calibrated on-chain marks. Display and stop confirmation only. */
  private liveMarks = new Map<string, { price: number; at: number; feed: string }>();
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
  private startedAt = Date.now();
  /** Earliest instant the current paper book owns. Recaps never look past it. */
  private resetAt = 0;
  /** Bumped by a paper reset so a fill already in flight cannot reopen the book. */
  private bookEpoch = 0;
  private equityTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private commentTimer: NodeJS.Timeout | null = null;
  private lastNotes = new Set<string>();
  private lastEquityAt = 0;
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
  /** v13.3 recent marks and liquidity per mint for the pre-buy crash guard. */
  readonly momentum = new MomentumTracker();
  private feed: FeedStatus;

  constructor(
    config: DeskConfig,
    deps: { priceFetch?: typeof fetch; lookupFetch?: typeof fetch; chainFetch?: typeof fetch; walletBalances?: () => Promise<WalletBalances>; depthFetch?: typeof fetch } = {}
  ) {
    this.config = config;
    // v13.8: re-read pool depth before a buy when the sighting has none. Live feeds only (tests inject).
    this.depthFetch = deps.depthFetch ?? (config.feedMode !== "replay" && !config.demoFeed && !deps.priceFetch ? deps.lookupFetch ?? this.net.fetchAt(0) : undefined);
    this.lookupFetch = deps.lookupFetch ?? deps.priceFetch ?? this.net.fetchAt(0);
    this.watchFetch = deps.lookupFetch ?? deps.priceFetch ?? this.net.fetchAt(1);
    this.store = new DeskStore(config.dbPath, config.jsonlPath, config.logPath);
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
    this.walletStatus = inspectDeskWallet({ readEnvSecret: config.readWalletSecret, keypairPath: config.walletKeypairPath });
    const owner = this.walletStatus.walletPublicKey;
    this.walletReader =
      deps.walletBalances ??
      (async () =>
        owner
          ? fetchWalletBalances(this.net.fetchAt(0), config.walletRpcUrl, owner)
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
      for (const [mint, priceUsd] of liveSaved?.lastPrices ?? []) if (this.liveBook.positions.has(mint)) this.liveBook.mark(mint, priceUsd);
      for (const [mint, until] of liveSaved?.cooldowns ?? []) if (until > Date.now()) this.cooldowns.set(bookKey("live", mint), until);
    }
    if (restored) {
      this.startedAt = restored.startedAt;
      for (const pos of restored.positions) {
        pos.closing = false;
        this.book.positions.set(pos.mint, pos);
        this.book.mark(pos.mint, pos.entryPrice);
      }
      for (const [mint, priceUsd] of restored.lastPrices ?? []) this.book.mark(mint, priceUsd);
      for (const [mint, until] of restored.cooldowns) if (until > Date.now() && !mint.startsWith(LIVE_KEY)) this.cooldowns.set(mint, until);
    }
    this.resetAt = this.ensureResetAt();
    this.watchlist = loadWatchlist(this.store.readJson("watchlist"));
    const crash = this.store.readJson("lastClientCrash") as { at?: unknown; version?: unknown; brief?: unknown } | null;
    if (crash && typeof crash.at === "number" && typeof crash.brief === "string") {
      this.lastClientCrash = { at: crash.at, version: typeof crash.version === "string" ? crash.version : "unknown", brief: crash.brief };
    }
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
    this.chain =
      deps.chainFetch || (config.feedMode !== "replay" && !config.demoFeed && !deps.priceFetch)
        ? new ChainMarkReader(config.walletRpcUrl || config.rpcUrl, deps.chainFetch ?? this.net.fetchAt(0), POSITION_REFRESH_BAND.min)
        : undefined;
    // v13.8: the same RPC's websocket endpoint pushes every held pool change. Poll stays as fallback.
    const wsUrl = this.chain && !deps.chainFetch ? wsUrlFor(config.walletRpcUrl || config.rpcUrl) : null;
    this.stream = wsUrl ? new ChainStream(wsUrl, (key, data, at) => this.pricer.onStreamAccount(key, data, at)) : undefined;
    this.pricer = new PositionPricer({
      heldMints: () => [
        ...new Set([...this.book.positions.values(), ...(this.liveBook?.positions.values() ?? [])].filter((pos) => pos.source !== "replay").map((pos) => pos.mint))
      ],
      tick: (mint, priceUsd, quote) =>
        this.scout.tick(mint, priceUsd, {
          feed: quote?.feed,
          pairAddress: quote?.pairAddress,
          dex: quote?.dex,
          liquidityUsd: quote?.liquidityUsd
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
        this.review(pos.mint, this.book.price(pos.mint, pos.entryPrice));
      }
    } else {
      this.persist();
    }
    if (this.liveBook) {
      for (const pos of [...this.liveBook.positions.values()]) this.review(pos.mint, this.liveBook.price(pos.mint, pos.entryPrice), "live");
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
      setTimeout(() => void this.refreshWatchlist(), 3_000);
    }
    this.equityTimer = setInterval(() => this.markEquity(), 2_000);
    // v13.5 read-only wallet balance for the card (and the live cash line). Never signs.
    if (this.walletStatus.walletPublicKey && this.config.feedMode !== "replay") {
      this.walletTimer = setInterval(() => void this.refreshWallet(), this.config.mode === "live" ? 20_000 : 60_000);
      setTimeout(() => void this.refreshWallet(), 2_000);
    }
    this.commentTimer = setInterval(() => void this.commentOnce(), 60_000);
    setTimeout(() => void this.commentOnce(), 8_000);
    this.heartbeat = setInterval(() => {
      const snap = this.snapshot();
      console.log(
        `[desk] ${snap.mode} equity ${money(snap.equityUsd)} cash ${money(snap.cashUsd)} open ${snap.positions.length} kills ${snap.pipeline.filteredKill} fills ${snap.pipeline.fills}`
      );
    }, 30_000);
    this.markEquity();
    console.log(
      `[desk] ${this.config.mode.toUpperCase()} feed=${this.config.feedMode} demo=${this.config.demoFeed} cap=${(this.config.rules.maxPositionPct * 100).toFixed(0)}% stop=-${(this.config.rules.stopLossPct * 100).toFixed(0)}% winners=manual`
    );
  }

  stop(): void {
    this.replay.stop();
    this.scout.stop();
    this.pricer.stop();
    this.stream?.stop();
    if (this.equityTimer) clearInterval(this.equityTimer);
    if (this.commentTimer) clearInterval(this.commentTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.walletTimer) clearInterval(this.walletTimer);
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
      equity: this.store.equitySince(this.resetAt),
      pipeline: { ...this.pipeline },
      settings: this.readSettings(),
      nextStartingUsd: starting
    });
    this.bookEpoch += 1;
    this.config.startingBalanceUsd = starting;
    this.book.positions.clear();
    this.book.lastPrice.clear();
    this.book.cashUsd = starting;
    this.cooldowns.clear();
    this.shocks.clear();
    this.markLiquidity.clear();
    this.startedAt = Date.now();
    this.resetAt = this.startedAt;
    this.store.writeJson("resetAt", this.resetAt);
    for (const key of Object.keys(this.pipeline) as Array<keyof PipelineCounts>) this.pipeline[key] = 0;
    this.killReasons = {};
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
    this.lastClientCrash = { at: Date.now(), version: label, brief };
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
        equity: this.store.equitySince(since),
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
    bookArg?: BookKind
  ): Promise<
    | { ok: true; soldFraction?: number; proceedsUsd?: number; symbol?: string; pnlUsd?: number; pnlPct?: number; exitPrice?: number; exitCode?: string }
    | { ok: false; error: string }
  > {
    // v13.7: a sell names its book. No book = the paper book, so an old client can never sell real coins by accident.
    const kind: BookKind = bookArg === "live" ? "live" : "paper";
    if (kind === "live" && !this.liveBook) return { ok: false, error: "No open position for that mint. Live trading is not armed." };
    const book = this.bk(kind);
    const pos = book.positions.get(mint);
    if (!pos) {
      const elsewhere = kind === "paper" && this.liveBook?.positions.has(mint);
      return { ok: false, error: elsewhere ? "No open position for that mint in the paper book. It is held live; sell it from the Live section." : "No open position for that mint." };
    }
    if (pos.closing) return { ok: false, error: "Close already in progress." };
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || !(fraction > 0) || fraction > 1) {
      return { ok: false, error: "Sell fraction must be 25%, 50% or 100% (a number above 0 and at most 1)." };
    }
    const mark = book.price(mint, pos.entryPrice);
    if (!(mark > 0)) return { ok: false, error: "No mark to close against." };
    if (fraction < 1 && kind === "live") return { ok: false, error: "Partial sells are paper-only. Use a full close for a live position." };
    if (fraction < 1) {
      const split = splitPosition(pos.qty, pos.costUsd, fraction);
      // A remainder worth under a cent is closed in full instead of leaving dust.
      if (split.ok && split.remainQty * mark >= 0.01) return this.partialSell(pos, mark, split);
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
      ...(kind === "live" ? { book: "live" as const } : {})
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
    if (book.positions.has(mint)) return { ok: false, error: `Close of ${pos.symbol} did not complete. Position is still open.` };
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
    split: { sellQty: number; soldCostUsd: number; remainQty: number; remainCostUsd: number; fraction: number }
  ): { ok: true; soldFraction: number; proceedsUsd: number } | { ok: false; error: string } {
    const liquidity = this.markLiquidity.get(pos.mint) ?? pos.liquidityUsd;
    const quote = quotePaperSell(mark, split.sellQty, liquidity);
    const proceedsUsd = roundUsd(quote.proceedsUsd ?? 0);
    assertNonNegativeFinite("proceedsUsd", proceedsUsd);
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
      const curve = await this.curvePrice(token.mint);
      if (curve.ok) {
        const next: CandidateToken = { ...token, priceUsd: curve.priceUsd, liquidityUsd: curve.liquidityUsd, priceFeed: "chain", pairAddress: curve.curve, dex: "pump.fun curve" };
        this.remember(next);
        return { token: next, tried };
      }
      tried.push(`pump.fun curve: ${curve.reason}`);
    }
    const jup = await jupiterLookupQuote(token.mint, token.priceUsd, fetchImpl);
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

  /** SOL/USD no older than 2 minutes: the held-mark loop's, else one Jupiter call. */
  private async solUsd(): Promise<number | null> {
    const held = this.pricer.quotes.solUsd;
    if (held && Date.now() - held.at <= 120_000 && held.value > 0) return held.value;
    if (this.solUsdCache && Date.now() - this.solUsdCache.at <= 60_000) return this.solUsdCache.value;
    try {
      const quotes = await fetchJupiterQuotes([SOL_MINT_ADDR], this.lookupFetch);
      const v = quotes.get(SOL_MINT_ADDR)?.priceUsd;
      if (v && v > 0 && Number.isFinite(v)) {
        this.solUsdCache = { value: v, at: Date.now() };
        return v;
      }
    } catch {
      /* fail closed */
    }
    return null;
  }

  /** v13.6 Tape: pump.fun sightings printed with "Mark 0" get priced from their curve. */
  private queueCurvePrice(mint: string): void {
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
   * v13.6 Add coin by ticker or name ($ optional, any case). Held and traded coins first,
   * then the Tape, then DexScreener search. One coin → the normal lookup card;
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
    if (local2.length) return pick(local2.slice(0, 8), "on the Tape");
    this.dexSearch ??= new DexSearchClient(this.lookupFetch);
    const searched = await this.dexSearch.search(query);
    if (!searched.ok) return { ok: false, error: searched.error, code: "LOOKUP_FAILED" };
    const ranked = rankDexSearch(query, searched.body, heldMints);
    if (!ranked.length) {
      return { ok: false, error: `No Solana coin called “${query}” in your positions, trades, the Tape or DexScreener search. Paste the mint or a link.`, code: "LOOKUP_FAILED" };
    }
    if (!ranked.some((r) => r.exact)) return { ok: false, code: "AMBIGUOUS", query, error: `No exact “${query}” on Solana. Close matches below; tap one.`, candidates: ranked };
    return pick(ranked, "DexScreener search");
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
    let token: CandidateToken;
    try {
      token = await enrichSighting(
        { mint, source: "raydium", observedAt: Date.now() },
        { rpcUrl: this.config.rpcUrl || undefined, rugcheckUrl: this.config.rugcheckUrl, fetchImpl: this.lookupFetch, holderPagesMax: 0 }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Could not read that coin (${message}). Buy is off.`, code: "LOOKUP_FAILED", platform: parsed.platform, mint };
    }
    let priceSource: "dexscreener" | "jupiter" | "chain" = "dexscreener";
    let curveWhy: string | null = null;
    if (token.priceFeed !== "dexscreener" || !(token.liquidityUsd > 0)) {
      // Pump curve coins: DexScreener shows a price but no pool depth. Jupiter (the same feed
      // the desk marks held coins with) gives both. Fail closed when the two disagree.
      const fallback = await jupiterLookupQuote(mint, token.priceFeed === "dexscreener" ? token.priceUsd : 0, this.lookupFetch);
      if (fallback.ok) {
        token.priceUsd = fallback.priceUsd;
        token.liquidityUsd = fallback.liquidityUsd;
        token.priceFeed = "jupiter";
        priceSource = "jupiter";
      } else if (fallback.error) {
        return { ok: false, error: fallback.error, code: "PRICE_UNAVAILABLE", platform: parsed.platform, mint };
      } else if (!(token.priceUsd > 0) || !(token.liquidityUsd > 0)) {
        // v13.6: a brand-new pump.fun coin: price it from its bonding curve on-chain.
        const curve = await this.curvePrice(mint);
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
        mint
      };
    }
    this.lookups.set(mint, { at: Date.now(), platform: parsed.platform, token: { ...token, social: { ...token.social } } });
    if (this.lookups.size > 200) {
      const first = this.lookups.keys().next().value;
      if (first) this.lookups.delete(first);
    }
    const held = this.book.positions.has(mint) || this.liveBook?.positions.has(mint) === true;
    if (!held) {
      this.remember(token);
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
    const hardKills = filter.checks.filter((c) => !c.pass && HARD_KILL_CODES.has(c.code)).map((c) => ({ code: c.code, message: c.message }));
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
    this.log({
      stage: "system",
      kind: "info",
      mint,
      symbol: token.symbol,
      code: "MANUAL_BUY",
      message: `Add coin looked up ${token.symbol} from ${parsed.platform}. Mark ${price(token.priceUsd)}, liquidity ${money(token.liquidityUsd)}, 1h volume ${money(token.volume1hUsd)}. Filter ${filter.decision === "pass" ? "pass" : `kill (${filter.reasons.map((r) => r.code).join(", ")})`}, Analyst ${report.score.toFixed(2)}.`
    });
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
      checks: filter.checks.map((c) => ({ code: c.code, pass: c.pass, message: c.message })),
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
      buyBlockedReason: blocked ?? (cooldownUntil > Date.now() ? `Hard-stop cooldown for ${Math.ceil((cooldownUntil - Date.now()) / 60_000)} more minutes. Buy anyway overrides it.` : null)
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
    // v13.7: on an armed desk Dirk's manual buys go live by default; the AI stays on paper.
    const kind: BookKind = opts?.book === "paper" ? "paper" : opts?.book === "live" || this.liveBook ? "live" : "paper";
    if (kind === "live" && !this.liveBook) {
      const error = "Live trading is not armed on the desk. Buy refused (nothing was sent).";
      this.log({ stage: "executor", kind: "reject", mint: cleaned, code: "LIVE_NOT_ARMED", message: `Manual buy refused. ${error}` });
      return { ok: false, error, code: "LIVE_NOT_ARMED" };
    }
    const looked = this.lookups.get(cleaned);
    if (looked && !this.sightings.has(cleaned)) this.remember(looked.token);
    const seen = this.sightings.get(cleaned);
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
    const priceUsd = this.book.price(cleaned, seen.priceUsd);
    const liquidityUsd = this.markLiquidity.get(cleaned) ?? seen.liquidityUsd;
    let token: CandidateToken = { ...seen, priceUsd, liquidityUsd };
    if (!(token.priceUsd > 0) || !Number.isFinite(token.priceUsd)) {
      // v13.6: brand-new pump.fun coins have no DexScreener pair and no Jupiter quote yet.
      // Read the bonding curve on-chain; fail closed if it is missing, complete or empty.
      const tried: string[] = [];
      const jup = await jupiterLookupQuote(cleaned, 0, this.lookupFetch);
      if (jup.ok) {
        token = { ...token, priceUsd: jup.priceUsd, liquidityUsd: jup.liquidityUsd, priceFeed: "jupiter", pairAddress: undefined };
      } else {
        tried.push(`Jupiter has no quote${jup.error ? ` (${jup.error})` : ""}`);
        const curve = await this.curvePrice(cleaned);
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
    this.log({
      stage: "system",
      kind: "info",
      mint: token.mint,
      symbol: token.symbol,
      code: "MANUAL_BUY",
      message: `Manual buy requested for ${token.symbol} at mark ${price(token.priceUsd)}.`
    });
    // Hard kills (mint authority not revoked, dev rug link) need the operator's "Buy anyway".
    if (!this.bk(kind).positions.has(token.mint)) {
      const rug = await this.rugs.lookup(token.devWallet);
      const kills = evaluateFilter(token, rug, this.config.rules, { allowUnlockedLp: this.allowUnlockedLp }).checks.filter(
        (check) => !check.pass && HARD_KILL_CODES.has(check.code)
      );
      if (kills.length && opts?.confirmHardKill !== true) {
        const message = `Hard kill on ${token.symbol}: ${kills.map((k) => k.message).join(" ")} Tap Buy anyway to ${kind === "live" ? "buy it with real money" : "paper-buy it"} regardless.`;
        this.log({ stage: "executor", kind: "reject", mint: token.mint, symbol: token.symbol, code: "HARD_KILL", message: `Manual buy held. ${message}` });
        return { ok: false, error: message, code: "HARD_KILL" };
      }
      if (kills.length) {
        this.log({
          stage: "system",
          kind: "info",
          mint: token.mint,
          symbol: token.symbol,
          code: "HARD_KILL",
          message: `Operator chose Buy anyway on ${token.symbol} past ${kills.map((k) => k.code).join(", ")}. ${kind === "live" ? "Live buy." : "Paper only."}`
        });
      }
    }
    const cached = this.analystScores.get(token.mint);
    const score = cached != null && Number.isFinite(cached) ? cached : scoreToken(token, this.config.rules).score;
    this.analystScores.set(token.mint, score);
    const tag = looked ? positionTag(looked.platform) : undefined;
    return this.executeBuy(token, score, sizeUsd, "manual", opts?.ignoreCooldown === true, {
      confirmSize: opts?.confirmSize === true,
      tag,
      book: kind
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
        ? "Operator marked the live checklist ready. Mode is unchanged. LIVE_TRADING is not set from the phone. The keypair stays on the Austin desk host."
        : "Operator cleared the live-checklist mark. Mode is unchanged."
    });
    return { ok: true, readiness: this.readiness() };
  }

  readiness(): LiveReadiness {
    const mode = this.config.mode;
    const liveTradingFlag = this.config.liveRequested;
    const { keypairPresent, walletPublicKey } = this.walletStatus;
    const rpcPresent = this.config.rpcUrl.trim().length > 0;
    const operatorReady = this.operatorReady;
    const lines = [
      `Mode ${mode}.`,
      `LIVE_TRADING is ${liveTradingFlag ? "true" : "off"}. The phone cannot turn this flag on.`,
      keypairPresent
        ? `Wallet key on the Austin desk host is loaded (${this.walletStatus.keySource === "env" ? "WALLET_PRIVATE_KEY" : "WALLET_KEYPAIR_PATH"})${walletPublicKey ? `. Public address ${walletPublicKey}` : ""}. The secret stays on that host.`
        : this.walletStatus.keyInvalid
          ? "WALLET_PRIVATE_KEY in Austin's .env is not a valid Solana private key (base58 from Phantom, or a JSON byte array)."
          : "No wallet key on the Austin desk host. Paste the wallet's private key into WALLET_PRIVATE_KEY= in C:\\Users\\Austin\\ndesk2\\.env on that machine. Never into the phone or a chat.",
      rpcPresent ? "RPC is set on the desk host. The URL is not shown here." : "SOLANA_RPC_URL is missing on the desk host.",
      mode === "live"
        ? `Live swaps are on. Austin restarted with LIVE_TRADING=true and a wallet key. ${this.liveScopeLine()}`
        : "Still paper. Real money starts only after Austin sets LIVE_TRADING=true (with WALLET_PRIVATE_KEY filled) in .env, then restarts the desk.",
      operatorReady
        ? "Operator marked this checklist ready. That mark does not arm live trading and does not store a wallet."
        : "Operator has not marked this checklist ready."
    ];
    return { mode, liveTradingFlag, keypairPresent, walletPublicKey, rpcPresent, operatorReady, liveScope: this.liveBook ? (this.liveAutoBuy ? "all" : "manual") : null, lines };
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
    const riskEquityUsd = this.book.equity();
    const equityUsd = this.displayEquity();
    const sessionPnlUsd = equityUsd - this.config.startingBalanceUsd;
    const positions = [...this.book.positions.values()].map((pos) => this.view(pos));
    return {
      liveScope: this.liveBook ? (this.liveAutoBuy ? "all" : "manual") : null,
      liveBook: this.liveBookView(),
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
      pipeline: { ...this.pipeline },
      killReasons: { ...this.killReasons },
      positions,
      closed: this.store
        .recentClosed(40)
        .filter((trade) => trade.closedAt >= this.startedAt)
        .slice(-20),
      equity: downsample(this.store.equitySince(this.startedAt), 240),
      events: this.store.recentEvents(180),
      advice: this.advice,
      watchlist: this.watchlist.map((item) => ({ ...item })),
      exposureUsd: roundUsd(this.exposureUsd()),
      manualMaxUsd: this.positionCapUsd(riskEquityUsd, SIZING_BAND.manualMaxPct),
      capWhy: this.capWhy(riskEquityUsd),
      lastClientCrash: this.lastClientCrash,
      markLoop: this.markLoopView()
    };
  }

  private wire(): void {
    this.bus.on("scout.candidate", (token) => {
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
          message: `Analyst scored ${report.token.symbol} ${report.score.toFixed(2)}. Handing to Executor.`,
          detail: report.score.toFixed(2)
        },
        { breakdown: report.breakdown }
      );
      const job = this.buy(report);
      this.track(job);
    });

    this.bus.on("market.tick", (tick) => {
      this.pricer.noteTick(tick.mint);
      if (!markUnusable(tick.priceUsd)) this.momentum.note(tick.mint, tick.priceUsd, tick.liquidityUsd, tick.at);
      this.applyMark(tick.mint, tick.priceUsd, {
        feed: tick.feed,
        pairAddress: tick.pairAddress,
        dex: tick.dex,
        liquidityUsd: tick.liquidityUsd
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
    const rug = await this.rugs.lookup(token.devWallet);
    const result = evaluateFilter(token, rug, this.config.rules, {
      allowUnlockedLp: this.allowUnlockedLp,
      minLiquidityUsd: this.minLiquidityUsd,
      minAgeSeconds: this.minTokenAgeMin > 0 ? this.minTokenAgeMin * 60 : 0,
      maxAgeSeconds: this.maxTokenAgeMin > 0 ? this.maxTokenAgeMin * 60 : 0,
      minHolderCount: this.minHolderCount,
      maxDevHoldingPct: this.maxDevHoldingPct
    });
    if (result.decision === "reject") this.considerNearMiss(result, prior);
    this.bus.emit("filter.result", result);
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

  private async buy(report: AnalystReport): Promise<void> {
    await this.executeBuy(report.token, report.score, this.positionSizeUsd ?? undefined, "analyst");
  }

  private async executeBuy(
    token: CandidateToken,
    score: number,
    requestedUsd: number | undefined,
    source: "analyst" | "manual",
    ignoreCooldown = false,
    extra: { confirmSize?: boolean; tag?: string; book?: BookKind } = {}
  ): Promise<ManualBuyResult | ManualBuyRefusal> {
    const epoch = this.bookEpoch;
    // v13.7: AI entries go live only when Dirk turned on "AI buys live" (liveAutoBuy). Default: paper.
    const kind: BookKind = extra.book ?? (source === "analyst" && this.liveBook && this.liveAutoBuy ? "live" : "paper");
    if (kind === "live" && !this.liveBook) {
      const error = "Live trading is not armed on the desk. Buy refused (nothing was sent).";
      return { ok: false, error, code: "LIVE_NOT_ARMED" };
    }
    const book = this.bk(kind);
    const key = bookKey(kind, token.mint);
    const isLive = kind === "live";
    // A confirmed manual buy may use up to 100% of the book. Everything else uses the saved cap (≤ 50%).
    // v13.5 live: the wallet's USDC is the book and the live per-trade size is the limit.
    const capPct =
      isLive || (source === "manual" && extra.confirmSize === true)
        ? SIZING_BAND.manualMaxPct
        : Math.min(this.config.rules.maxPositionPct, SIZING_BAND.autoMaxPct);
    if (isLive) {
      // v13.5: every live buy uses the live size. A larger request (e.g. the phone's
      // paper one-tap amount) is cut to it. Never the paper position size.
      requestedUsd = requestedUsd != null && requestedUsd > 0 ? Math.min(requestedUsd, this.liveTradeUsd) : this.liveTradeUsd;
      const ready = await this.liveBuyReady(requestedUsd);
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
        buysLastHour: this.buysInLastHour(),
        dailyMaxLossUsd: this.dailyMaxLossUsd,
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
          const { executeLiveSwap } = await import("../market/live-broker.js");
          const live = await executeLiveSwap({
            side: "buy",
            mint: token.mint,
            sizeUsd: sized.sizeUsd,
            decimals: token.decimals,
            keypairPath: this.config.walletKeypairPath,
            readEnvSecret: this.config.readWalletSecret,
            rpcUrl: this.config.walletRpcUrl,
            quoteUrl: this.config.jupiterQuoteUrl,
            swapUrl: this.config.jupiterSwapUrl,
            markPriceUsd: token.priceUsd,
            maxEntrySlippage: this.config.rules.maxEntrySlippage
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
              : `Live AI buy at the live size $${sized.sizeUsd.toFixed(2)}.`;
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
            "live"
          );
          return this.bought(token, sized, "live");
        } catch (err) {
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
        extra.tag
      );
      return this.bought(token, sized, "paper");
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
    kind: BookKind = "paper"
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
      ...(fill.mode === "live" ? { live: true, entryMark: fill.markUsd, markPeak: fill.markUsd } : {})
    };
    book.positions.set(token.mint, position);
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
        const { executeLiveSwap } = await import("../market/live-broker.js");
        const live = await executeLiveSwap({
          side: "sell",
          mint: order.mint,
          qty: pos.qty,
          decimals: pos.decimals,
          keypairPath: this.config.walletKeypairPath,
          readEnvSecret: this.config.readWalletSecret,
          rpcUrl: this.config.walletRpcUrl,
          quoteUrl: this.config.jupiterQuoteUrl,
          swapUrl: this.config.jupiterSwapUrl,
          maxEntrySlippage: this.config.rules.maxEntrySlippage,
          maxExitSlippage: this.maxExitSlippage ?? undefined
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
      const mark = this.exitMark(pos, order.markPrice);
      const quote = quotePaperSell(mark, pos.qty, pos.liquidityUsd);
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
      const message = err instanceof Error ? err.message : String(err);
      this.log({
        stage: "executor",
        kind: "reject",
        mint: pos.mint,
        symbol: pos.symbol,
        code: "LIVE_SWAP_FAILED",
        message: `Executor could not close ${pos.symbol}. ${message}`
      });
    }
  }

  private applySell(pos: Position, fill: Fill, order: ExitOrder, proceeds?: number): void {
    const book = this.bk(order.book === "live" ? "live" : "paper");
    if (!book.positions.has(pos.mint)) return;
    const rawProceeds = proceeds ?? roundUsd(fill.notionalUsd - fill.feeUsd);
    const proceedsUsd = typeof rawProceeds === "number" && Number.isFinite(rawProceeds) && rawProceeds > 0 ? roundUsd(rawProceeds) : 0;
    const fillPrice = typeof fill.priceUsd === "number" && Number.isFinite(fill.priceUsd) && fill.priceUsd > 0 ? fill.priceUsd : 0;
    assertNonNegativeFinite("proceedsUsd", proceedsUsd);
    assertNonNegativeFinite("fillPrice", fillPrice);
    const booked: Fill = { ...fill, priceUsd: fillPrice };
    book.cashUsd = roundUsd(book.cashUsd + proceedsUsd);
    book.positions.delete(pos.mint);
    const pnlUsd = roundUsd(proceedsUsd - pos.costUsd);
    const pnlPct = pos.costUsd > 0 ? pnlUsd / pos.costUsd : order.pnlPct;
    const label = classifyStopExit({
      code: order.reason.code,
      entryPrice: pos.entryPrice,
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
        ? `Gap/${label.rug ? "rug" : "gap"}: stop line ${price(stopPrice)} (−${(this.config.rules.stopLossPct * 100).toFixed(0)}%), trigger mark ${price(order.markPrice)}${vsEntry(order.markPrice)}, true fill ${price(fillPrice)}${vsEntry(fillPrice)}. The price moved past the stop between marks; a stop cannot fill better than the market.`
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

  private review(mint: string, mark: number, kind: BookKind = "paper"): void {
    const pos = kind === "live" ? this.liveBook?.positions.get(mint) : this.book.positions.get(mint);
    if (!pos || pos.closing) return;
    const view = assessPosition(pos, mark, this.config.rules, { trailExits: this.trailTakeProfit, liveTrailPct: this.liveTrailFor(pos) });
    const peakRose = view.peakPrice > pos.peakPrice || (view.markPeak != null && view.markPeak > (pos.markPeak ?? 0));
    const armChanged = view.trailArmed !== pos.trailArmed;
    pos.peakPrice = view.peakPrice;
    if (view.markPeak != null) pos.markPeak = view.markPeak;
    pos.trailArmed = view.trailArmed;
    if (view.action === "hold" || !view.code) {
      if (peakRose || armChanged) this.persist();
      return;
    }
    pos.closing = true;
    if (view.code === "STOP_LOSS") {
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
      stopPrice: assessment.stopPrice,
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
      ...(pos.tag ? { tag: pos.tag } : pos.entry === "manual" ? { tag: "manual" } : {})
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
          stopPrice: pos.entryPrice * (1 - stopLoss),
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
  private applyMark(mint: string, priceUsd: number, origin?: MarkOrigin, advise = true): void {
    this.applyMarkIn("paper", mint, priceUsd, origin, advise);
    if (this.liveBook?.positions.has(mint)) this.applyMarkIn("live", mint, priceUsd, origin, false);
  }

  private applyMarkIn(kind: BookKind, mint: string, priceUsd: number, origin?: MarkOrigin, advise = true): void {
    const book = this.bk(kind);
    const key = bookKey(kind, mint);
    const pos = book.positions.get(mint);
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
    const shock = !!pos && !pos.closing && needsShockConfirm(pos.entryPrice, priceUsd, pos.openedAt, Date.now());
    // Operator and replay marks carry no feed and are trusted as before; feed prints must repeat a >30% jump.
    const jump = !!pos && !pos.closing && !reanchored && !!origin?.feed && isJump(book.lastPrice.get(mint), priceUsd);
    if (pos && (shock || jump)) {
      const feed = origin?.feed ?? pos.priceFeed ?? "mark";
      const pending = this.shocks.get(key);
      const agrees = pending?.price == null || Math.abs(priceUsd / pending.price - 1) <= SHOCK_MOVE;
      if (!pending || pending.feed !== feed || !agrees) {
        this.shocks.set(key, { feed, price: priceUsd });
        const base = shock ? pos.entryPrice : book.price(mint, pos.entryPrice);
        const move = ((priceUsd - base) / base) * 100;
        this.log({
          stage: "risk",
          kind: "info",
          mint,
          symbol: pos.symbol,
          code: "PRICE_UNCONFIRMED",
          message: shock
            ? `Risk held a ${pos.symbol} move of ${move.toFixed(2)}% from ${originLabel(origin)} inside 10s of entry. A second tick from the same source has to confirm it before the stop fires.`
            : `Risk held a ${pos.symbol} jump of ${move.toFixed(2)}% from ${originLabel(origin)}. A second tick from the same source has to confirm it before the stop fires.`
        });
        return;
      }
      this.shocks.delete(key);
    } else if (pos) {
      this.shocks.delete(key);
    }
    const seen = kind === "paper" ? this.sightings.get(mint) : undefined;
    if (seen) this.sightings.set(mint, { ...seen, priceUsd });
    if (origin?.liquidityUsd && origin.liquidityUsd > 0 && pos) this.markLiquidity.set(mint, origin.liquidityUsd);
    if (kind === "paper" || pos) book.mark(mint, priceUsd);
    if (pos) {
      this.riskFeed.set(key, origin?.feed ?? pos.priceFeed ?? pos.source);
      this.bus.emit("position.mark", { mint, at: Date.now() });
    }
    this.review(mint, priceUsd, kind);
    if (advise) this.publishAdvice(this.buildAdvice());
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
    if ((priceUsd <= stop && now - lastAsk >= 1_500) || (drift > 0.03 && now - lastAsk >= 5_000)) {
      this.lastConfirmAt.set(key, now);
      this.pricer.confirm(mint);
    }
    this.bus.emit("position.mark", { mint, at: now });
  }

  /** v13.2 what the card shows: a fresh live mark, else the latest of risk and live. */
  private displayMark(pos: Position, kind: BookKind = "paper"): { price: number; at: number; feed: string } {
    const book = this.bk(kind);
    const key = bookKey(kind, pos.mint);
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
      scope: this.liveAutoBuy ? "all" : "manual",
      line: this.liveScopeLine(),
      cashUsd: roundUsd(this.liveBook.cashUsd),
      equityUsd: roundUsd(equityUsd),
      startingUsd: roundUsd(startingUsd),
      pnlUsd: startingUsd > 0 ? roundUsd(equityUsd - startingUsd) : 0,
      openPnlUsd: roundUsd(positions.reduce((sum, p) => sum + p.pnlUsd, 0)),
      positions,
      tradeUsd: this.liveTradeUsd,
      trailPct: this.liveTrailPct,
      dailyCapUsd: this.liveDailyCapUsd
    };
  }

  /** v13.2 small WS payload: only what a position card needs. */
  marksDelta(): MarksDelta {
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
      markFeed: p.markFeed ?? ""
    });
    return {
      now: Date.now(),
      cashUsd: roundUsd(this.book.cashUsd),
      equityUsd: roundUsd(this.displayEquity()),
      ...(this.liveBook
        ? { live: { cashUsd: roundUsd(this.liveBook.cashUsd), equityUsd: roundUsd(this.displayEquity("live")), positions: livePositions.map(slim) } }
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
        markFeed: p.markFeed ?? ""
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

  /** Paper exits price off the last accepted mark when the trigger itself is unusable. */
  private exitMark(pos: Position, trigger: number): number {
    if (!markUnusable(trigger)) return trigger;
    const last = this.book.price(pos.mint, pos.entryPrice);
    return !markUnusable(last) ? last : pos.entryPrice;
  }

  private markEquity(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEquityAt < 1_800) return;
    this.lastEquityAt = now;
    this.store.insertEquity({ t: now, equity: roundUsd(this.book.equity()), cash: roundUsd(this.book.cashUsd) });
  }

  private remember(token: CandidateToken): void {
    this.sightings.set(token.mint, { ...token, social: { ...token.social } });
    this.momentum.note(token.mint, token.priceUsd, token.liquidityUsd);
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
    mode: "paper" | "live"
  ): ManualBuyResult {
    return {
      ok: true,
      mint: token.mint,
      symbol: token.symbol,
      sizeUsd: sized.sizeUsd,
      mode,
      ...(sized.clampedFrom != null ? { clampedFrom: sized.clampedFrom } : {}),
      ...(this.bk(mode).positions.get(token.mint)?.entryPrice ? { fillPriceUsd: this.bk(mode).positions.get(token.mint)!.entryPrice } : {})
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
      liveAutoBuy: this.liveAutoBuy
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
      if (!Number.isFinite(raw) || raw < 6) return { ok: false, error: "Per-mint cooldown cannot be under 6 hours." };
      next.cooldownHours = clampCooldownHours(raw);
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
      "notifyStops",
      "liveAutoBuy"
    ];
    for (const key of flags) {
      if (!(key in patch)) continue;
      if (typeof patch[key] !== "boolean") return { ok: false, error: `${key} must be true or false.` };
      next[key] = patch[key] as never;
    }
    return null;
  }

  private absorbGates(saved: DeskSettings): void {
    if (typeof saved.minLiquidityUsd === "number") this.minLiquidityUsd = clampLiquidityUsd(saved.minLiquidityUsd);
    if (typeof saved.minTokenAgeMin === "number") this.minTokenAgeMin = clampAgeMinutes(saved.minTokenAgeMin);
    if (typeof saved.maxTokenAgeMin === "number") this.maxTokenAgeMin = clampAgeMinutes(saved.maxTokenAgeMin);
    if (typeof saved.minHolderCount === "number") this.minHolderCount = clampHolderCount(saved.minHolderCount);
    if (typeof saved.maxDevHoldingPct === "number") this.maxDevHoldingPct = clampDevHoldingPct(saved.maxDevHoldingPct);
    if (typeof saved.maxTradesPerHour === "number") this.maxTradesPerHour = clampTradesPerHour(saved.maxTradesPerHour);
    if (typeof saved.dailyMaxLossUsd === "number") this.dailyMaxLossUsd = clampDailyLossUsd(saved.dailyMaxLossUsd);
    if (typeof saved.cooldownHours === "number" && saved.cooldownHours >= 6) {
      this.config.rules.revengeCooldownMs = clampCooldownHours(saved.cooldownHours) * 3_600_000;
    }
    if (typeof saved.stopLossPct === "number" && saved.stopLossPct > 0 && saved.stopLossPct <= HARD_RULES.stopLossPct + 1e-9) {
      this.config.rules.stopLossPct = clampStopLossPct(saved.stopLossPct);
    }
    if (typeof saved.trailArmPct === "number") this.config.rules.trailArmPct = clampTrailArmPct(saved.trailArmPct);
    if (typeof saved.trailGapPct === "number") this.config.rules.trailGapPct = clampTrailGapPct(saved.trailGapPct);
    if (typeof saved.trailTakeProfit === "boolean") this.trailTakeProfit = saved.trailTakeProfit;
    if (typeof saved.autoBuy === "boolean") this.autoBuy = saved.autoBuy;
    if (typeof saved.liveAutoBuy === "boolean") this.liveAutoBuy = saved.liveAutoBuy;
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
  }

  private buysInLastHour(): number {
    const since = Date.now() - 3_600_000;
    return this.store.recentEvents(500).filter((event) => event.kind === "fill" && event.ts >= since && / buy /.test(event.message)).length;
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
      liveAutoBuy: view.liveAutoBuy
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
        lastPrices: [...this.book.lastPrice.entries()]
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
          lastPrices: [...this.liveBook.lastPrice.entries()]
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
  private liveScopeLine(): string {
    if (!this.liveBook) return "Live trading is off. Everything is paper.";
    return this.liveAutoBuy
      ? "Live: manual + AI. Your buys and the AI's auto-buys send real swaps."
      : "Live: manual only · AI: paper. Your one-tap and Add coin buys send real swaps; the AI keeps buying on the paper book.";
  }

  /** v13.5 the live trail applies to live positions only. */
  private liveTrailFor(pos: Position): number | null {
    return pos.live === true ? this.liveTrailPct : null;
  }

  /** v13.5 read-only SOL / USDC balance. In live mode the wallet's USDC is the book's cash. */
  async refreshWallet(): Promise<WalletBalances | null> {
    const read = await this.walletReader();
    this.walletBalances = read;
    if (this.liveBook && read.error == null && read.usdc != null) {
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

  /** v13.5 the wallet card's refresh button: at most one RPC read per 10 s. */
  async refreshWalletThrottled(): Promise<void> {
    if (!this.walletStatus.walletPublicKey && this.config.mode !== "live") return;
    if (this.walletBalances && Date.now() - this.walletBalances.at < 10_000) return;
    await this.refreshWallet();
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
   * v13.5 fail-closed live pre-checks: a fresh wallet read, enough USDC for the trade and SOL for
   * fees, and the optional live daily cap. Any unknown refuses the buy.
   */
  private async liveBuyReady(sizeUsd: number): Promise<{ ok: true } | { ok: false; error: string; code: "LIVE_WALLET" | "LIVE_DAILY_CAP" | "LIVE_NOT_ARMED" }> {
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
    const read = await this.refreshWallet();
    if (!read || read.error != null || read.sol == null || read.usdc == null) {
      return { ok: false, error: `Wallet balance unknown${read?.error ? ` (${read.error})` : ""}. Live buy refused.`, code: "LIVE_WALLET" };
    }
    if (read.sol < MIN_FEE_SOL) {
      return { ok: false, error: `Wallet has ${read.sol.toFixed(4)} SOL. Keep at least ${MIN_FEE_SOL} SOL for fees.`, code: "LIVE_WALLET" };
    }
    if (read.usdc < sizeUsd) {
      return { ok: false, error: `Wallet has ${money(read.usdc)} USDC. A live buy spends ${money(sizeUsd)} USDC.`, code: "LIVE_WALLET" };
    }
    return { ok: true };
  }

  /** v13.5 wallet card. Public address and balances only. */
  walletView(): WalletView {
    const bal = this.walletBalances;
    return {
      keyLoaded: this.walletStatus.keypairPresent,
      keySource: this.walletStatus.keySource,
      keyInvalid: this.walletStatus.keyInvalid,
      publicKey: this.walletStatus.walletPublicKey,
      solBalance: bal?.sol ?? null,
      usdcBalance: bal?.usdc ?? null,
      balanceAt: bal?.at ?? null,
      balanceError: bal?.error ?? null,
      live: this.config.mode === "live",
      liveScope: this.liveBook ? (this.liveAutoBuy ? "all" : "manual") : null,
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
