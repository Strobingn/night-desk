import { randomUUID } from "node:crypto";
import { assessPosition, entryAllowed } from "../agents/risk.js";
import { HARD_RULES, clampVolumeUsd } from "../rules.js";
import { evaluateFilter } from "../agents/filter.js";
import { scoreToken } from "../agents/analyst.js";
import { MARK_STALE_MS, planOrder, quotePaperBuy, quotePaperSell, realizablePnl, roundUsd } from "../agents/execution-math.js";
import { Scout } from "../agents/scout.js";
import { EventBus } from "../bus.js";
import type { DeskConfig } from "../config.js";
import { ReplayFeed } from "../demo/replay.js";
import { advise, AdvisorBook, noteEntry, noteKill, noteOutcome, notePass, type Advice, type FeatureSample, type WeakSurvivor } from "./advisor.js";
import { phraseAdvice } from "./commentary.js";
import { PositionPricer } from "../market/position-pricer.js";
import { LayeredRugRegistry, loadRugWalletMap, StaticRugRegistry } from "../market/rug-registry.js";
import { DeskStore } from "../store/db.js";
import type {
  AnalystReport,
  CandidateToken,
  ClosedTrade,
  DeskEvents,
  DeskSnapshot,
  ExitOrder,
  FeedEvent,
  FeedStatus,
  AdviceNote,
  Fill,
  PipelineCounts,
  Position,
  PositionView
} from "../types.js";
import { PaperBook } from "./book.js";

/**
 * Legal handoffs (nothing else may open, size, or close a position):
 *
 *   scout.candidate → Filter
 *   filter.result pass → Analyst
 *   filter.result reject → Logger
 *   analyst.report trade → Executor buy
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
  private readonly inflight = new Set<Promise<unknown>>();
  private cooldowns = new Map<string, number>();
  private startedAt = Date.now();
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
    const saved = this.store.readJson("settings") as { minVolume1hUsd?: number } | null;
    if (saved && typeof saved.minVolume1hUsd === "number") {
      this.config.rules.minVolume1hUsd = clampVolumeUsd(saved.minVolume1hUsd);
    }
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
      for (const [mint, points] of restored.markSeries ?? []) this.book.restoreSeries(mint, points);
      this.cooldowns = new Map(restored.cooldowns.filter(([, until]) => until > Date.now()));
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
      onStatus: (patch) => {
        this.feed = { ...this.feed, ...patch };
      }
    });
    this.feed = { ...this.scout.status };
    this.replay = new ReplayFeed(this.scout);
    this.pricer = new PositionPricer({
      heldMints: () => [...this.book.positions.values()].filter((pos) => pos.source !== "replay").map((pos) => pos.mint),
      tick: (mint, priceUsd) => this.scout.tick(mint, priceUsd),
      onQuote: (mint, liquidityUsd) => this.markLiquidity.set(mint, liquidityUsd),
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
    this.book.markAt.clear();
    this.book.series.clear();
    this.book.cashUsd = starting;
    this.cooldowns.clear();
    this.markLiquidity.clear();
    this.startedAt = Date.now();
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
   * Live 1h volume floor for new Filter checks. Clamped to $1,000–$500,000.
   * Stays $50,000 until this is called. Open positions and the other hard rules are unchanged.
   */
  setMinVolume(raw: number): { ok: true; minVolume1hUsd: number } | { ok: false; error: string } {
    if (!Number.isFinite(raw)) return { ok: false, error: "Volume floor must be a number of US dollars." };
    const minVolume1hUsd = clampVolumeUsd(raw);
    this.config.rules.minVolume1hUsd = minVolume1hUsd;
    this.store.writeJson("settings", { minVolume1hUsd });
    this.log({
      stage: "system",
      kind: "info",
      message: `Volume floor is now ${money(minVolume1hUsd)} per hour. The next Filter check uses it.`,
      detail: String(minVolume1hUsd)
    });
    return { ok: true, minVolume1hUsd };
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
      startedAt: this.startedAt,
      now: Date.now(),
      startingBalanceUsd: this.config.startingBalanceUsd,
      cashUsd: roundUsd(this.book.cashUsd),
      equityUsd: roundUsd(equityUsd),
      sessionPnlUsd: roundUsd(sessionPnlUsd),
      sessionPnlPct: this.config.startingBalanceUsd > 0 ? sessionPnlUsd / this.config.startingBalanceUsd : 0,
      rules: this.config.rules,
      feed: this.feed,
      pipeline: { ...this.pipeline },
      killReasons: { ...this.killReasons },
      positions,
      closed: this.store
        .recentClosed(40)
        .filter((trade) => trade.closedAt >= this.startedAt)
        .slice(-8),
      equity: downsample(this.store.equitySince(this.startedAt), 240),
      events: this.store.recentEvents(180),
      advice: this.advice
    };
  }

  private wire(): void {
    this.bus.on("scout.candidate", (token) => {
      this.pipeline.scouted += 1;
      this.applyMark(token.mint, token.priceUsd);
      this.log({
        stage: "scout",
        kind: "info",
        mint: token.mint,
        symbol: token.symbol,
        message: `Scout found ${token.symbol} on ${token.source}. Mark ${price(token.priceUsd)}, 1h volume ${money(token.volume1hUsd)}.`,
        detail: token.source
      });
      const job = this.runFilter(token);
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
      this.log({
        stage: "filter",
        kind: "pass",
        mint: result.token.mint,
        symbol: result.token.symbol,
        message: `Filter passed ${result.token.symbol}. Mint revoked, LP locked, holders and volume inside the hard lines.`
      });
      const report = scoreToken(result.token, this.config.rules);
      this.bus.emit("analyst.report", report);
    });

    this.bus.on("analyst.report", (report) => {
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
      this.applyMark(tick.mint, tick.priceUsd);
    });

    this.bus.on("risk.exit", (order) => {
      const job = this.sell(order);
      this.track(job);
    });
  }

  private async runFilter(token: CandidateToken): Promise<void> {
    const rug = await this.rugs.lookup(token.devWallet);
    const result = evaluateFilter(token, rug, this.config.rules);
    this.bus.emit("filter.result", result);
  }

  private async buy(report: AnalystReport): Promise<void> {
    const epoch = this.bookEpoch;
    const token = report.token;
    const plan = planOrder({
      equityUsd: this.book.equity(),
      cashUsd: this.book.cashUsd,
      rules: this.config.rules,
      token,
      hasPosition: this.book.positions.has(token.mint),
      cooldownUntil: this.cooldowns.get(token.mint) ?? null,
      now: Date.now()
    });
    if (!plan.ok) {
      this.pipeline.executorSkips += 1;
      this.bus.emit("executor.skip", { token, reason: plan.reason, score: report.score });
      this.log({
        stage: "executor",
        kind: "reject",
        mint: token.mint,
        symbol: token.symbol,
        code: plan.reason.code,
        message: `Executor skipped ${token.symbol}. ${plan.reason.message}`,
        detail: report.score.toFixed(2)
      });
      return;
    }

    if (this.config.mode === "live") {
      if (!this.config.walletKeypairPath) {
        this.skipLive(token, report.score, "Live mode lost its keypair path.");
        return;
      }
      try {
        const { executeLiveSwap } = await import("../market/live-broker.js");
        const live = await executeLiveSwap({
          side: "buy",
          mint: token.mint,
          sizeUsd: plan.sizeUsd,
          decimals: token.decimals,
          keypairPath: this.config.walletKeypairPath,
          rpcUrl: this.config.rpcUrl,
          quoteUrl: this.config.jupiterQuoteUrl,
          swapUrl: this.config.jupiterSwapUrl
        });
        if (epoch !== this.bookEpoch) return;
        this.applyBuy({
          id: randomUUID(),
          mint: token.mint,
          symbol: token.symbol,
          side: "buy",
          qty: live.qty,
          priceUsd: live.fillPriceUsd,
          markUsd: token.priceUsd,
          slippage: live.slippage,
          notionalUsd: plan.sizeUsd,
          feeUsd: live.feeUsd,
          mode: "live",
          txSignature: live.signature,
          at: Date.now(),
          reason: `Live buy sized at ${(this.config.rules.maxPositionPct * 100).toFixed(0)}% cap ($${plan.sizeUsd.toFixed(2)} of $${plan.capUsd.toFixed(2)}).`,
          score: report.score
        }, token, report.score);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.skipLive(token, report.score, message);
      }
      return;
    }

    if (epoch !== this.bookEpoch) return;
    const quote = quotePaperBuy(token.priceUsd, plan.sizeUsd, token.liquidityUsd);
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
        notionalUsd: plan.sizeUsd,
        feeUsd: quote.feeUsd,
        mode: "paper",
        at: Date.now(),
        reason: `Paper buy sized at the ${(this.config.rules.maxPositionPct * 100).toFixed(0)}% cap.`,
        score: report.score
      },
      token,
      report.score
    );
  }

  private applyBuy(fill: Fill, token: CandidateToken, score: number): void {
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
      liquidityUsd: token.liquidityUsd,
      decimals: token.decimals,
      tradeId: fill.id,
      entrySlippage: fill.slippage
    };
    this.book.positions.set(token.mint, position);
    noteEntry(this.advisor.memory, token.mint, token.symbol, sampleOf(token, score));
    this.advisor.save();
    // Record the spot. Review waits for the next tick so a fill that is already through
    // the hard stop is closed by that tick, not erased inside the buy itself.
    this.book.mark(token.mint, fill.markUsd, fill.at);
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
      const quote = quotePaperSell(order.markPrice, pos.qty, pos.liquidityUsd);
      this.applySell(
        pos,
        {
          id: randomUUID(),
          mint: pos.mint,
          symbol: pos.symbol,
          side: "sell",
          qty: pos.qty,
          priceUsd: quote.fillPrice,
          markUsd: order.markPrice,
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
    const proceedsUsd = proceeds ?? roundUsd(fill.notionalUsd - fill.feeUsd);
    this.book.cashUsd = roundUsd(this.book.cashUsd + proceedsUsd);
    this.book.positions.delete(pos.mint);
    this.book.forgetMarks(pos.mint);
    const pnlUsd = roundUsd(proceedsUsd - pos.costUsd);
    const pnlPct = pos.costUsd > 0 ? pnlUsd / pos.costUsd : order.pnlPct;
    const closed: ClosedTrade = {
      id: pos.tradeId,
      mint: pos.mint,
      symbol: pos.symbol,
      openedAt: pos.openedAt,
      closedAt: fill.at,
      costUsd: pos.costUsd,
      proceedsUsd,
      pnlUsd,
      pnlPct,
      exitCode: order.reason.code,
      score: pos.score,
      mode: fill.mode
    };
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
    this.bus.emit("executor.fill", fill);
    this.log(
      {
        stage: "risk",
        kind: "exit",
        mint: pos.mint,
        symbol: pos.symbol,
        code: order.reason.code,
        message: `Risk ${exitVerb(order.reason.code)} ${pos.symbol}. ${order.reason.message} Realized ${signed(pnlUsd)}.`,
        detail: signed(pnlUsd)
      },
      { ...closed, fill }
    );
    this.log(
      {
        stage: "executor",
        kind: "fill",
        mint: pos.mint,
        symbol: pos.symbol,
        code: order.reason.code,
        message: `Executor filled ${pos.symbol} sell ${money(proceedsUsd)} @ ${price(fill.priceUsd)} (${fill.mode}).`,
        detail: money(proceedsUsd)
      },
      fill
    );
    this.persist();
    this.markEquity(true);
  }

  private review(mint: string, mark: number): void {
    const pos = this.book.positions.get(mint);
    if (!pos || pos.closing) return;
    const view = assessPosition(pos, mark, this.config.rules);
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
    const now = Date.now();
    const markAt = this.book.markAt.get(pos.mint) ?? null;
    const liveMark = this.book.lastPrice.get(pos.mint);
    const quotedLiq = this.markLiquidity.get(pos.mint);
    const liquidityUsd = quotedLiq != null && Number.isFinite(quotedLiq) ? quotedLiq : pos.liquidityUsd;
    const net =
      liveMark != null
        ? realizablePnl({
            markPrice: liveMark,
            qty: pos.qty,
            costUsd: pos.costUsd,
            liquidityUsd,
            markAt,
            now
          })
        : null;
    const markStale =
      liveMark != null &&
      (markAt == null || !Number.isFinite(markAt) || markAt > now + 5_000 || now - markAt >= MARK_STALE_MS);
    const entrySlippage =
      typeof pos.entrySlippage === "number" && Number.isFinite(pos.entrySlippage) ? pos.entrySlippage : null;
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
      netPnlUsd: net?.netPnlUsd ?? null,
      netPnlPct: net?.netPnlPct ?? null,
      exitSlippage: net?.exitSlippage ?? null,
      entrySlippage,
      markStale,
      marks: this.book.seriesFor(pos.mint),
      peakPrice: assessment.peakPrice,
      trailArmed: assessment.trailArmed,
      stopPrice: assessment.stopPrice,
      trailHintPrice: assessment.trailHintPrice,
      score: pos.score,
      source: pos.source,
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
    return advise(this.advisor.memory, {
      positions,
      weak: this.weakSurvivor,
      sessionKills: this.killReasons
    });
  }

  private publishAdvice(items: Advice[]): void {
    const now = Date.now();
    const notes: AdviceNote[] = items.map((item, index) => ({
      id: `${item.stance}:${item.mint ?? item.symbol ?? index}:${item.text}`,
      ts: now,
      stance: item.stance,
      symbol: item.symbol,
      mint: item.mint,
      text: item.text
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

  private applyMark(mint: string, priceUsd: number, advise = true): void {
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return;
    this.book.mark(mint, priceUsd, Date.now());
    this.review(mint, priceUsd);
    if (advise) this.publishAdvice(this.buildAdvice());
  }

  private markEquity(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEquityAt < 1_800) return;
    this.lastEquityAt = now;
    this.store.insertEquity({ t: now, equity: roundUsd(this.book.equity()), cash: roundUsd(this.book.cashUsd) });
  }

  private persist(): void {
    this.store.saveBook({
      cashUsd: this.book.cashUsd,
      startingBalanceUsd: this.config.startingBalanceUsd,
      startedAt: this.startedAt,
      positions: [...this.book.positions.values()].map((pos) => ({ ...pos, closing: false })),
      cooldowns: [...this.cooldowns.entries()],
      lastPrices: [...this.book.lastPrice.entries()],
      markSeries: [...this.book.series.entries()].filter(([mint]) => this.book.positions.has(mint))
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

function price(n: number): string {
  if (!(n > 0)) return "—";
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
