import { randomUUID } from "node:crypto";
import { assessPosition, entryAllowed } from "../agents/risk.js";
import { HARD_RULES, SCORE_BAND, clampAgeMinutes, clampBuyUsd, clampCooldownHours, clampDailyLossUsd, clampDevHoldingPct, clampEntrySlippage, clampHolderCount, clampLiquidityUsd, clampOpenPositions, clampPnlAlertPct, clampPositionPct, clampScore, clampStopLossPct, clampTop10, clampTradesPerHour, clampTrailArmPct, clampTrailGapPct, clampVolumeUsd, OPEN_POSITION_BAND } from "../rules.js";
import { autoBuyBlock } from "./auto-gates.js";
import { DEFAULT_SCOUT_SOURCES, type ScoutSources } from "../agents/scout.js";
import { evaluateFilter } from "../agents/filter.js";
import { scoreToken } from "../agents/analyst.js";
import { assertNonNegativeFinite, entryPriceAllowed, exitImpactAllowed, floorUsd, planOrder, quotePaperBuy, quotePaperSell, resolveManualSize, roundUsd } from "../agents/execution-math.js";
import { Scout } from "../agents/scout.js";
import { EventBus } from "../bus.js";
import type { DeskConfig } from "../config.js";
import { ReplayFeed } from "../demo/replay.js";
import { advise, AdvisorBook, noteEntry, noteKill, noteNearMissSurface, noteNearMissTaken, noteOutcome, notePass, type Advice, type FeatureSample, type WeakSurvivor } from "./advisor.js";
import { classifyNearMiss } from "./near-miss.js";
import { phraseAdvice } from "./commentary.js";
import { markUnusable, needsShockConfirm, sameMarkSource, type MarkOrigin } from "../market/mark-guard.js";
import { buildRecap, recapReport, resetAtFromEquity, resolveRecapSince, type RecapReport } from "./recap.js";
import { PositionPricer } from "../market/position-pricer.js";
import { inspectDeskKeypair } from "../market/wallet-status.js";
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
  PositionView
} from "../types.js";
import { PaperBook } from "./book.js";

type SettingsPatch = {
  [K in keyof DeskSettings]?: unknown;
};

interface DeskSettings {
  minVolume1hUsd?: number;
  analystMinScore?: number;
  maxTop10Pct?: number;
  maxPositionPct?: number;
  defaultBuyUsd?: number | null;
  maxOpenPositions?: number;
  allowUnlockedLp?: boolean;
  maxEntrySlippage?: number;
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
  notifyNearMiss?: boolean;
  notifyFills?: boolean;
  notifyStops?: boolean;
  pnlAlertPct?: number;
}

interface DeskSettingsView {
  minVolume1hUsd: number;
  analystMinScore: number;
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
  notifyNearMiss: boolean;
  notifyFills: boolean;
  notifyStops: boolean;
  pnlAlertPct: number;
}

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
  private readonly lpUnlockedMints = new Set<string>();
  private readonly analystScores = new Map<string, number>();
  /** Near-miss cards still waiting on a one-tap buy. One card per mint until it is taken. */
  private readonly nearMissCards = new Map<string, Advice>();
  /** Mints already shown as a near miss that have not been entered yet. */
  private readonly surfacedNearMiss = new Set<string>();
  private readonly walletStatus: { keypairPresent: boolean; walletPublicKey: string | null };
  private readonly inflight = new Set<Promise<unknown>>();
  private cooldowns = new Map<string, number>();
  /** First >30% print inside 10s of entry, keyed by mint. The feed has to repeat it. */
  private shocks = new Map<string, { feed: string }>();
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
    executorSkips: 0
  };
  private killReasons: Record<string, number> = {};
  private feed: FeedStatus;

  constructor(config: DeskConfig, deps: { priceFetch?: typeof fetch } = {}) {
    this.config = config;
    this.store = new DeskStore(config.dbPath, config.jsonlPath, config.logPath);
    this.advisor = new AdvisorBook(config.advisorPath);
    const saved = this.readSettings();
    if (typeof saved.minVolume1hUsd === "number") {
      this.config.rules.minVolume1hUsd = clampVolumeUsd(saved.minVolume1hUsd);
    }
    if (typeof saved.analystMinScore === "number") {
      this.config.rules.analystMinScore = clampScore(saved.analystMinScore);
    }
    if (typeof saved.maxTop10Pct === "number") {
      this.config.rules.maxTop10Pct = clampTop10(saved.maxTop10Pct);
    }
    if (typeof saved.maxPositionPct === "number") {
      this.config.rules.maxPositionPct = clampPositionPct(saved.maxPositionPct);
    }
    if (typeof saved.maxEntrySlippage === "number") {
      this.config.rules.maxEntrySlippage = clampEntrySlippage(saved.maxEntrySlippage);
    }
    if ("defaultBuyUsd" in saved) this.defaultBuyUsd = clampBuyUsd(saved.defaultBuyUsd ?? null);
    if (typeof saved.maxOpenPositions === "number") this.maxOpenPositions = clampOpenPositions(saved.maxOpenPositions);
    if (typeof saved.allowUnlockedLp === "boolean") this.allowUnlockedLp = saved.allowUnlockedLp;
    this.absorbGates(saved);
    this.operatorReady = saved.operatorReady === true;
    this.walletStatus = inspectDeskKeypair(config.walletKeypairPath);
    this.rugs = new LayeredRugRegistry(new StaticRugRegistry(loadRugWalletMap(config.rugWalletsFile)));
    const restored = config.resetPaper ? null : this.store.loadBook();
    const starting =
      restored && restored.startingBalanceUsd > 0 ? restored.startingBalanceUsd : config.startingBalanceUsd;
    this.config.startingBalanceUsd = starting;
    this.book = new PaperBook(restored?.cashUsd ?? starting);
    if (restored) {
      this.startedAt = restored.startedAt;
      for (const pos of restored.positions) {
        pos.closing = false;
        this.book.positions.set(pos.mint, pos);
        this.book.mark(pos.mint, pos.entryPrice);
      }
      for (const [mint, priceUsd] of restored.lastPrices ?? []) this.book.mark(mint, priceUsd);
      this.cooldowns = new Map(restored.cooldowns.filter(([, until]) => until > Date.now()));
    }
    this.resetAt = this.ensureResetAt();
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
      onStatus: (patch) => {
        this.feed = { ...this.feed, ...patch };
      }
    });
    this.scout.setSources(this.scoutSources);
    this.feed = { ...this.scout.status };
    this.replay = new ReplayFeed(this.scout);
    this.pricer = new PositionPricer({
      heldMints: () => [...this.book.positions.values()].filter((pos) => pos.source !== "replay").map((pos) => pos.mint),
      tick: (mint, priceUsd, quote) =>
        this.scout.tick(mint, priceUsd, {
          feed: quote?.feed,
          pairAddress: quote?.pairAddress,
          dex: quote?.dex,
          liquidityUsd: quote?.liquidityUsd
        }),
      fetchImpl: deps.priceFetch,
      onStale: (mint, silentMs) => {
        const pos = this.book.positions.get(mint);
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
        const pos = this.book.positions.get(mint);
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
        this.feed = { ...this.feed, lastError: `position prices: ${message}` };
      },
      onOk: () => {
        if (this.feed.lastError?.startsWith("position prices:")) this.feed = { ...this.feed, lastError: undefined };
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
    this.log({
      stage: "logger",
      kind: "info",
      message:
        config.mode === "live"
          ? `Logger opened a live book. Live swaps are armed. Cash tracked at ${money(this.book.cashUsd)}.`
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
    if (this.config.feedMode !== "replay") this.pricer.start();
    this.equityTimer = setInterval(() => this.markEquity(), 2_000);
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
    if (this.equityTimer) clearInterval(this.equityTimer);
    if (this.commentTimer) clearInterval(this.commentTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
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
   * Drop the paper book back to $100. Open positions are removed from the ledger
   * and no order is sent. The event log, advisor memory, and settings (including
   * the 1h volume floor) stay. Live mode is refused and LIVE_TRADING is not changed.
   */
  resetPaperBook(confirm: boolean): { ok: true; cashUsd: number; startingBalanceUsd: number } | { ok: false; error: string } {
    if (confirm !== true) return { ok: false, error: "Confirm the reset before the paper book is cleared." };
    if (this.config.mode !== "paper") {
      return { ok: false, error: "Reset only clears the paper book. Live trading is unchanged." };
    }
    const starting = HARD_RULES.paperStartingUsd;
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
      message: `Paper book reset to ${money(starting)}. Open positions dropped. The log, advisor memory, and volume floor stay. Live trading is still off.`
    });
    this.publishAdvice(this.buildAdvice());
    return { ok: true, cashUsd: this.book.cashUsd, startingBalanceUsd: starting };
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
    if ("maxTop10Pct" in patch) {
      const raw = Number(patch.maxTop10Pct);
      if (!Number.isFinite(raw)) return { ok: false, error: "Top 10 cap must be a percent from 5 to 35." };
      next.maxTop10Pct = clampTop10(raw);
    }
    if ("maxPositionPct" in patch) {
      const raw = Number(patch.maxPositionPct);
      if (!Number.isFinite(raw)) return { ok: false, error: "Position cap must be a percent from 1 to 8." };
      next.maxPositionPct = clampPositionPct(raw);
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
    if ("allowUnlockedLp" in patch) {
      if (typeof patch.allowUnlockedLp !== "boolean") return { ok: false, error: "Allow unlocked LP must be true or false." };
      next.allowUnlockedLp = patch.allowUnlockedLp;
    }
    if ("maxEntrySlippage" in patch) {
      if (patch.maxEntrySlippage == null || patch.maxEntrySlippage === "") {
        return { ok: false, error: "Entry slippage cap cannot be removed. Send a percent from 0.5 to 3." };
      }
      const raw = Number(patch.maxEntrySlippage);
      if (!Number.isFinite(raw)) return { ok: false, error: "Entry slippage cap must be a percent from 0.5 to 3." };
      next.maxEntrySlippage = clampEntrySlippage(raw);
    }
    const refused = this.assignGates(patch, next);
    if (refused) return refused;
    this.store.writeJson("settings", next);
    this.applySaved(next);
    const view = this.settingsView();
    this.log({
      stage: "system",
      kind: "info",
      message: `Settings saved. Volume ${money(view.minVolume1hUsd)}, trade line ${view.analystMinScore.toFixed(2)}, top 10 ${(view.maxTop10Pct * 100).toFixed(0)}%, position ${(view.maxPositionPct * 100).toFixed(0)}%, entry slip ${(view.maxEntrySlippage * 100).toFixed(2)}%, buy ${view.defaultBuyUsd == null ? "cap" : money(view.defaultBuyUsd)}, open ${view.maxOpenPositions}, unlocked LP ${view.allowUnlockedLp ? "allowed" : "blocked"}. Hard stop stays −${(HARD_RULES.stopLossPct * 100).toFixed(0)}%.`
    });
    return { ok: true, settings: view };
  }

  /**
   * Operator paper/live close. Uses the same sell path as a risk exit.
   * Does not ban the mint and does not change filter rules.
   */
  async closePosition(mint: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const pos = this.book.positions.get(mint);
    if (!pos) return { ok: false, error: "No open position for that mint." };
    if (pos.closing) return { ok: false, error: "Close already in progress." };
    const mark = this.book.price(mint, pos.entryPrice);
    if (!(mark > 0)) return { ok: false, error: "No mark to close against." };
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
      }
    };
    this.log({
      stage: "system",
      kind: "info",
      mint: pos.mint,
      symbol: pos.symbol,
      code: "MANUAL_CLOSE",
      message: `Manual close requested for ${pos.symbol} at mark ${price(mark)}.`
    });
    this.bus.emit("risk.exit", order);
    await this.drain();
    return { ok: true };
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
    opts?: { ignoreCooldown?: boolean }
  ): Promise<ManualBuyResult | ManualBuyRefusal> {
    const cleaned = mint.trim();
    if (!cleaned) return { ok: false, error: "Mint is required.", code: "PRICE_UNAVAILABLE" };
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
    const token: CandidateToken = { ...seen, priceUsd, liquidityUsd };
    if (!(token.priceUsd > 0) || !Number.isFinite(token.priceUsd)) {
      this.log({
        stage: "executor",
        kind: "reject",
        mint: token.mint,
        symbol: token.symbol,
        code: "PRICE_UNAVAILABLE",
        message: `Manual buy refused for ${token.symbol}. No usable price.`
      });
      return { ok: false, error: "No usable price. Buy refused.", code: "PRICE_UNAVAILABLE" };
    }
    this.log({
      stage: "system",
      kind: "info",
      mint: token.mint,
      symbol: token.symbol,
      code: "MANUAL_BUY",
      message: `Manual buy requested for ${token.symbol} at mark ${price(token.priceUsd)}.`
    });
    const cached = this.analystScores.get(token.mint);
    const score = cached != null && Number.isFinite(cached) ? cached : scoreToken(token, this.config.rules).score;
    this.analystScores.set(token.mint, score);
    return this.executeBuy(token, score, sizeUsd, "manual", opts?.ignoreCooldown === true);
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
        ? `Keypair file on the Austin desk host is present${walletPublicKey ? `. Public address ${walletPublicKey}` : ""}. The secret stays on that host.`
        : "Keypair file on the Austin desk host is missing. Point WALLET_KEYPAIR_PATH at a Solana CLI JSON keypair on that machine. Do not paste a Phantom seed into Night Desk.",
      rpcPresent ? "RPC is set on the desk host. The URL is not shown here." : "SOLANA_RPC_URL is missing on the desk host.",
      mode === "live"
        ? "Live swaps are on. Austin restarted with LIVE_TRADING=true and a keypair path."
        : "Still paper. Real money starts only after Austin sets LIVE_TRADING=true and WALLET_KEYPAIR_PATH in .env, then restarts the desk.",
      operatorReady
        ? "Operator marked this checklist ready. That mark does not arm live trading and does not store a wallet."
        : "Operator has not marked this checklist ready."
    ];
    return { mode, liveTradingFlag, keypairPresent, walletPublicKey, rpcPresent, operatorReady, lines };
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

  snapshot(): DeskSnapshot {
    const equityUsd = this.book.equity();
    const sessionPnlUsd = equityUsd - this.config.startingBalanceUsd;
    const positions = [...this.book.positions.values()].map((pos) => this.view(pos));
    return {
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
      positionCapUsd: this.positionCapUsd(equityUsd),
      cooldowns: [...this.cooldowns.entries()]
        .filter(([, until]) => until > Date.now())
        .map(([mint, until]) => ({
          mint,
          until,
          minutesLeft: Math.ceil((until - Date.now()) / 60_000)
        })),
      feed: this.feed,
      pipeline: { ...this.pipeline },
      killReasons: { ...this.killReasons },
      positions,
      closed: this.store
        .recentClosed(40)
        .filter((trade) => trade.closedAt >= this.startedAt)
        .slice(-20),
      equity: downsample(this.store.equitySince(this.startedAt), 240),
      events: this.store.recentEvents(180),
      advice: this.advice
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
        message: `Scout found ${token.symbol} on ${token.source}. Mark ${price(token.priceUsd)}, 1h volume ${money(token.volume1hUsd)}.`,
        detail: token.source
      });
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
    await this.executeBuy(report.token, report.score, undefined, "analyst");
  }

  private async executeBuy(
    token: CandidateToken,
    score: number,
    requestedUsd: number | undefined,
    source: "analyst" | "manual",
    ignoreCooldown = false
  ): Promise<ManualBuyResult | ManualBuyRefusal> {
    const epoch = this.bookEpoch;
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
    const openCount = [...this.book.positions.values()].filter((pos) => !pos.closing).length + this.opening.size;
    if (!this.book.positions.has(token.mint) && !this.opening.has(token.mint) && openCount >= this.maxOpenPositions) {
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
    const plan = planOrder({
      equityUsd: this.book.equity(),
      cashUsd: this.book.cashUsd,
      rules: this.config.rules,
      token,
      hasPosition: this.book.positions.has(token.mint) || this.opening.has(token.mint),
      cooldownUntil: this.cooldowns.get(token.mint) ?? null,
      now: Date.now(),
      ignoreCooldown: source === "manual" && ignoreCooldown
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
      source === "manual" && requestedUsd == null && this.defaultBuyUsd != null ? Math.min(this.defaultBuyUsd, plan.sizeUsd) : requestedUsd;
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

    const pctLabel = (this.config.rules.maxPositionPct * 100).toFixed(0);
    const exitGate = exitImpactAllowed(sized.sizeUsd, token.liquidityUsd, this.config.rules.maxEntrySlippage);
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
    this.opening.add(token.mint);
    try {
      if (this.config.mode === "live") {
        if (!this.config.walletKeypairPath) {
          const message = "Live mode lost its keypair path.";
          this.skipLive(token, score, message);
          return { ok: false, error: message, code: "LIVE_NOT_ARMED" };
        }
        try {
          const { executeLiveSwap } = await import("../market/live-broker.js");
          const live = await executeLiveSwap({
            side: "buy",
            mint: token.mint,
            sizeUsd: sized.sizeUsd,
            decimals: token.decimals,
            keypairPath: this.config.walletKeypairPath,
            rpcUrl: this.config.rpcUrl,
            quoteUrl: this.config.jupiterQuoteUrl,
            swapUrl: this.config.jupiterSwapUrl,
            markPriceUsd: token.priceUsd,
            maxEntrySlippage: this.config.rules.maxEntrySlippage
          });
          if (epoch !== this.bookEpoch) {
            return { ok: false, error: "Paper book was reset before the fill. Buy dropped.", code: "BOOK_RESET" };
          }
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
              : `Live buy sized at ${pctLabel}% cap ($${sized.sizeUsd.toFixed(2)} of $${plan.capUsd.toFixed(2)}).`;
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
            source
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
        source
      );
      return this.bought(token, sized, "paper");
    } finally {
      this.opening.delete(token.mint);
    }
  }

  private applyBuy(fill: Fill, token: CandidateToken, score: number, entry: "manual" | "analyst"): void {
    if (fill.notionalUsd > this.book.equity() * this.config.rules.maxPositionPct + 0.02) {
      throw new Error(`Position cap breached on ${token.symbol}`);
    }
    this.book.cashUsd = roundUsd(this.book.cashUsd - fill.notionalUsd);
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
      pairAddress: token.priceFeed === "dexscreener" ? token.pairAddress : undefined,
      dex: token.dex,
      tradeId: fill.id
    };
    this.book.positions.set(token.mint, position);
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
    this.book.mark(token.mint, fill.markUsd);
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
    const pos = this.book.positions.get(order.mint);
    if (!pos) return;
    try {
      if (this.config.mode === "live") {
        if (!this.config.walletKeypairPath) throw new Error("LIVE_NOT_ARMED");
        const { executeLiveSwap } = await import("../market/live-broker.js");
        const live = await executeLiveSwap({
          side: "sell",
          mint: order.mint,
          qty: pos.qty,
          decimals: pos.decimals,
          keypairPath: this.config.walletKeypairPath,
          rpcUrl: this.config.rpcUrl,
          quoteUrl: this.config.jupiterQuoteUrl,
          swapUrl: this.config.jupiterSwapUrl
        });
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
    if (!this.book.positions.has(pos.mint)) return;
    const rawProceeds = proceeds ?? roundUsd(fill.notionalUsd - fill.feeUsd);
    const proceedsUsd = typeof rawProceeds === "number" && Number.isFinite(rawProceeds) && rawProceeds > 0 ? roundUsd(rawProceeds) : 0;
    const fillPrice = typeof fill.priceUsd === "number" && Number.isFinite(fill.priceUsd) && fill.priceUsd > 0 ? fill.priceUsd : 0;
    assertNonNegativeFinite("proceedsUsd", proceedsUsd);
    assertNonNegativeFinite("fillPrice", fillPrice);
    const booked: Fill = { ...fill, priceUsd: fillPrice };
    this.book.cashUsd = roundUsd(this.book.cashUsd + proceedsUsd);
    this.book.positions.delete(pos.mint);
    const pnlUsd = roundUsd(proceedsUsd - pos.costUsd);
    const pnlPct = pos.costUsd > 0 ? pnlUsd / pos.costUsd : order.pnlPct;
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
      exitCode: order.reason.code,
      score: pos.score,
      mode: booked.mode,
      entryPrice: pos.entryPrice,
      exitPrice: fillPrice
    };
    const stopPrice = pos.entryPrice > 0 ? pos.entryPrice * (1 - this.config.rules.stopLossPct) : 0;
    const compared = `Stop trigger ${price(stopPrice)} vs fill ${price(fillPrice)}.`;
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
    this.bus.emit("executor.fill", booked);
    this.log(
      {
        stage: "risk",
        kind: "exit",
        mint: pos.mint,
        symbol: pos.symbol,
        code: order.reason.code,
        message: `Risk ${exitVerb(order.reason.code)} ${pos.symbol}. ${order.reason.message} ${compared} Realized ${signed(pnlUsd)}.`,
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
        code: order.reason.code,
        message: `Executor filled ${pos.symbol} sell ${money(proceedsUsd)} @ ${price(fillPrice)} (${booked.mode}). ${compared}`,
        detail: money(proceedsUsd)
      },
      booked
    );
    this.persist();
    this.markEquity(true);
  }

  private review(mint: string, mark: number): void {
    const pos = this.book.positions.get(mint);
    if (!pos || pos.closing) return;
    const view = assessPosition(pos, mark, this.config.rules, { trailExits: this.trailTakeProfit });
    const peakRose = view.peakPrice > pos.peakPrice;
    const armChanged = view.trailArmed !== pos.trailArmed;
    pos.peakPrice = view.peakPrice;
    pos.trailArmed = view.trailArmed;
    if (view.action === "hold" || !view.code) {
      if (peakRose || armChanged) this.persist();
      return;
    }
    pos.closing = true;
    if (view.code === "STOP_LOSS") {
      this.cooldowns.set(mint, Date.now() + this.config.rules.revengeCooldownMs);
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
      reason: { code: view.code, message: view.message }
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

  private view(pos: Position): PositionView {
    const markPrice = this.book.price(pos.mint, pos.entryPrice);
    const marketValueUsd = pos.qty * markPrice;
    const pnlUsd = marketValueUsd - pos.costUsd;
    const assessment = assessPosition(pos, markPrice, this.config.rules);
    return {
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
      markAgeMs: Math.max(0, Date.now() - (this.book.markedAt(pos.mint) ?? pos.openedAt)),
      openedAt: pos.openedAt
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

  private applyMark(mint: string, priceUsd: number, origin?: MarkOrigin, advise = true): void {
    const pos = this.book.positions.get(mint);
    if (markUnusable(priceUsd)) {
      if (pos && !pos.closing) {
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
    if (pos && !sameMarkSource(pos, origin)) {
      this.log({
        stage: "risk",
        kind: "reject",
        mint,
        symbol: pos.symbol,
        code: "PRICE_SOURCE",
        message: `Risk ignored a ${pos.symbol} mark of ${price(priceUsd)} from ${originLabel(origin)}. Entry was ${pos.priceFeed ?? pos.source}${pos.pairAddress ? ` pair ${pos.pairAddress.slice(0, 4)}` : ""}. Waiting for a valid mark.`
      });
      return;
    }
    if (pos && !pos.closing && needsShockConfirm(pos.entryPrice, priceUsd, pos.openedAt, Date.now())) {
      const feed = origin?.feed ?? pos.priceFeed ?? "mark";
      const pending = this.shocks.get(mint);
      if (!pending || pending.feed !== feed) {
        this.shocks.set(mint, { feed });
        const move = ((priceUsd - pos.entryPrice) / pos.entryPrice) * 100;
        this.log({
          stage: "risk",
          kind: "info",
          mint,
          symbol: pos.symbol,
          code: "PRICE_UNCONFIRMED",
          message: `Risk held a ${pos.symbol} move of ${move.toFixed(2)}% from ${originLabel(origin)} inside 10s of entry. A second tick from the same source has to confirm it before the stop fires.`
        });
        return;
      }
      this.shocks.delete(mint);
    } else if (pos) {
      this.shocks.delete(mint);
    }
    const seen = this.sightings.get(mint);
    if (seen) this.sightings.set(mint, { ...seen, priceUsd });
    if (origin?.liquidityUsd && origin.liquidityUsd > 0 && pos) this.markLiquidity.set(mint, origin.liquidityUsd);
    this.book.mark(mint, priceUsd);
    this.review(mint, priceUsd);
    if (advise) this.publishAdvice(this.buildAdvice());
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
    if (typeof saved.maxTop10Pct === "number") this.config.rules.maxTop10Pct = clampTop10(saved.maxTop10Pct);
    if (typeof saved.maxPositionPct === "number") this.config.rules.maxPositionPct = clampPositionPct(saved.maxPositionPct);
    if (typeof saved.maxEntrySlippage === "number") this.config.rules.maxEntrySlippage = clampEntrySlippage(saved.maxEntrySlippage);
    if ("defaultBuyUsd" in saved) this.defaultBuyUsd = clampBuyUsd(saved.defaultBuyUsd ?? null);
    if (typeof saved.maxOpenPositions === "number") this.maxOpenPositions = clampOpenPositions(saved.maxOpenPositions);
    if (typeof saved.allowUnlockedLp === "boolean") this.allowUnlockedLp = saved.allowUnlockedLp;
    this.absorbGates(saved);
    if (typeof saved.operatorReady === "boolean") this.operatorReady = saved.operatorReady;
    this.scout.setSources(this.scoutSources);
  }

  private positionCapUsd(equityUsd = this.book.equity()): number {
    const pct = Math.min(this.config.rules.maxPositionPct, HARD_RULES.maxPositionPct);
    const cap = floorUsd(Math.max(0, equityUsd) * pct);
    const cash = floorUsd(Math.max(0, this.book.cashUsd));
    return Math.min(cap, cash);
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
      ...(sized.clampedFrom != null ? { clampedFrom: sized.clampedFrom } : {})
    };
  }

  private settingsView(): DeskSettingsView {
    return {
      minVolume1hUsd: this.config.rules.minVolume1hUsd,
      analystMinScore: this.config.rules.analystMinScore,
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
      notifyNearMiss: this.notifyNearMiss,
      notifyFills: this.notifyFills,
      notifyStops: this.notifyStops,
      pnlAlertPct: this.pnlAlertPct
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
      const fraction = raw > 1 ? raw / 100 : raw;
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction > HARD_RULES.stopLossPct + 1e-9) {
        return { ok: false, error: "Hard stop cannot be loosened past 6%. Tighter is allowed." };
      }
      next.stopLossPct = clampStopLossPct(raw);
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
      const fraction = raw > 1 ? raw / 100 : raw;
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction > HARD_RULES.trailGapPct + 1e-9) {
        return { ok: false, error: "Trail gap cannot be wider than 4%." };
      }
      next.trailGapPct = clampTrailGapPct(raw);
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
      "notifyNearMiss",
      "notifyFills",
      "notifyStops"
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
    this.scoutSources = {
      dexscreener: saved.scoutDexscreener !== false,
      gecko: saved.scoutGecko !== false,
      jupiter: saved.scoutJupiter !== false,
      dexpaprika: saved.scoutDexpaprika === true,
      bitquery: saved.scoutBitquery !== false
    };
    if (typeof saved.notifyNearMiss === "boolean") this.notifyNearMiss = saved.notifyNearMiss;
    if (typeof saved.notifyFills === "boolean") this.notifyFills = saved.notifyFills;
    if (typeof saved.notifyStops === "boolean") this.notifyStops = saved.notifyStops;
    if (typeof saved.pnlAlertPct === "number") this.pnlAlertPct = clampPnlAlertPct(saved.pnlAlertPct);
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
      scoutBitquery: view.scoutBitquery
    };
  }

  private persist(): void {
    this.store.saveBook({
      cashUsd: this.book.cashUsd,
      startingBalanceUsd: this.config.startingBalanceUsd,
      startedAt: this.startedAt,
      positions: [...this.book.positions.values()].map((pos) => ({ ...pos, closing: false })),
      cooldowns: [...this.cooldowns.entries()],
      lastPrices: [...this.book.lastPrice.entries()]
    });
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

function exitVerb(code: string): string {
  if (code === "STOP_LOSS") return "stopped";
  if (code === "TRAIL_STOP") return "trailed";
  if (code === "MANUAL_CLOSE") return "closed";
  return "exited";
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  return n.toFixed(8);
}

function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(rows[Math.round(i * step)]!);
  return out;
}

export { entryAllowed };
