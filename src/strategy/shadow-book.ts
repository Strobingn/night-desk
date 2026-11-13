import { randomUUID } from "node:crypto";
import { exitImpactAllowed, floorUsd, quotePaperBuy, quotePaperSell, realizablePnl, roundUsd } from "../agents/execution-math.js";
import { entryAnchor, outlierReason } from "../market/mark-guard.js";
import { STRATEGY, timeLimitFor, type SignalKind, type StrategyConfig, type Variant } from "./config.js";
import { assessStrategyExit, type MarketFlow, type StrategyExitCode, type StrategyMeta } from "./exits.js";

export interface ShadowToken {
  mint: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  /** 5-minute volume at the signal, for the fade exits. */
  vol5mUsd?: number | null;
}

export interface ShadowPosition {
  mint: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  /** The mark the buy was priced at. The stop is measured from it. */
  entryMark: number;
  costUsd: number;
  openedAt: number;
  liquidityUsd: number;
  lastMark: number;
  lastMarkAt: number;
  breakevenArmed: boolean;
  /** Trailing state and the entry volume and depth (see StrategyMeta). */
  state: Partial<StrategyMeta>;
}

export interface ShadowTrade {
  id: string;
  variant: string;
  signal: SignalKind;
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number;
  costUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  exitCode: StrategyExitCode;
}

export interface ShadowSizing {
  targetNetUsd: number;
  tradeUsd: number;
  maxOpen: number;
}

export type ShadowOpen = { ok: true; position: ShadowPosition } | { ok: false; reason: string };

function utcDayStart(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * One variant's paper book. Same fill and fee model as the desk's paper book. It never
 * places an order and holds no reference to the desk.
 */
export class ShadowBook {
  cashUsd: number;
  readonly positions = new Map<string, ShadowPosition>();
  readonly trades: ShadowTrade[];
  private readonly cfg: StrategyConfig;
  private readonly sizing: () => ShadowSizing;
  private readonly flow: (mint: string) => MarketFlow | null | undefined;

  constructor(
    readonly variant: Variant,
    opts: { trades?: ShadowTrade[]; cfg?: StrategyConfig; sizing?: () => ShadowSizing; flow?: (mint: string) => MarketFlow | null | undefined } = {}
  ) {
    this.flow = opts.flow ?? (() => null);
    this.cfg = opts.cfg ?? STRATEGY;
    this.sizing = opts.sizing ?? (() => ({ targetNetUsd: this.cfg.targetNetUsd, tradeUsd: this.cfg.tradeUsd, maxOpen: this.cfg.maxOpen }));
    this.trades = (opts.trades ?? []).filter((t) => t.variant === variant.id);
    this.cashUsd = roundUsd(this.cfg.startingUsd + this.trades.reduce((sum, t) => sum + t.pnlUsd, 0));
  }

  /** Net result of trades closed since the start of the UTC day. */
  netToday(now: number): number {
    const start = utcDayStart(now);
    return this.trades.reduce((sum, t) => (t.closedAt >= start ? sum + t.pnlUsd : sum), 0);
  }

  open(token: ShadowToken, now: number): ShadowOpen {
    const { tradeUsd, maxOpen } = this.sizing();
    if (this.positions.has(token.mint)) return { ok: false, reason: "Already open." };
    if (this.positions.size >= maxOpen) return { ok: false, reason: `Already ${this.positions.size} open.` };
    if (this.netToday(now) <= -this.cfg.dailyMaxLossUsd + 1e-9) return { ok: false, reason: "Paused: the day is past its loss limit." };
    const sizeUsd = floorUsd(Math.min(tradeUsd, this.cashUsd));
    if (!(sizeUsd >= this.cfg.minTradeUsd)) return { ok: false, reason: "Not enough cash left in this book." };
    const quote = quotePaperBuy(token.priceUsd, sizeUsd, token.liquidityUsd);
    if (!quote.ok) return { ok: false, reason: "Entry would cost too much slippage." };
    if (!exitImpactAllowed(sizeUsd, token.liquidityUsd).ok) return { ok: false, reason: "Pool too thin to exit." };
    const position: ShadowPosition = {
      mint: token.mint,
      symbol: token.symbol,
      qty: quote.qty,
      entryPrice: quote.fillPrice,
      entryMark: token.priceUsd,
      costUsd: sizeUsd,
      openedAt: now,
      liquidityUsd: token.liquidityUsd,
      lastMark: token.priceUsd,
      lastMarkAt: now,
      breakevenArmed: false,
      state: {
        entryLiquidityUsd: token.liquidityUsd,
        ...(token.vol5mUsd != null && token.vol5mUsd > 0 && Number.isFinite(token.vol5mUsd) ? { entryVol5mUsd: token.vol5mUsd } : {})
      }
    };
    this.positions.set(token.mint, position);
    this.cashUsd = roundUsd(this.cashUsd - sizeUsd);
    return { ok: true, position };
  }

  /** A new price for a held coin. Returns the closed trade when an exit fires. */
  onMark(mint: string, priceUsd: number, now: number, liquidityUsd?: number): ShadowTrade | null {
    const pos = this.positions.get(mint);
    if (!pos) return null;
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return null;
    // An upward print that looks like a unit mix-up or an absurd spike is not a price. A drop always counts.
    if (outlierReason(entryAnchor(pos.entryPrice, pos.lastMark), priceUsd)) return null;
    pos.lastMark = priceUsd;
    pos.lastMarkAt = now;
    if (liquidityUsd != null && liquidityUsd > 0 && Number.isFinite(liquidityUsd)) pos.liquidityUsd = liquidityUsd;
    return this.assess(pos, now);
  }

  /** Time limits. Uses each position's last mark, and only while that mark is fresh. */
  /** Time passing for one position with no new mark: the timer exits (time limit, stall) on its last mark while that is fresh. */
  tickOne(mint: string, now: number): ShadowTrade | null {
    const pos = this.positions.get(mint);
    return pos ? this.assess(pos, now) : null;
  }

  tick(now: number): ShadowTrade[] {
    const closed: ShadowTrade[] = [];
    for (const pos of [...this.positions.values()]) {
      const trade = this.assess(pos, now);
      if (trade) closed.push(trade);
    }
    return closed;
  }

  equity(): number {
    let held = 0;
    for (const pos of this.positions.values()) held += pos.qty * pos.lastMark;
    return roundUsd(this.cashUsd + held);
  }

  private assess(pos: ShadowPosition, now: number): ShadowTrade | null {
    const markFresh = now - pos.lastMarkAt <= this.cfg.watch.markFreshMs;
    const net = realizablePnl({
      markPrice: pos.lastMark,
      qty: pos.qty,
      costUsd: pos.costUsd,
      liquidityUsd: pos.liquidityUsd,
      markAt: pos.lastMarkAt,
      now
    });
    const verdict = assessStrategyExit(
      {
        entryPrice: pos.entryPrice,
        entryMark: pos.entryMark,
        openedAt: pos.openedAt,
        mark: pos.lastMark,
        markFresh,
        netPnlUsd: net?.netPnlUsd ?? null,
        now,
        meta: {
          variant: this.variant.id,
          signal: this.variant.signal,
          stopPct: this.variant.stopPct,
          targetNetUsd: this.sizing().targetNetUsd,
          timeLimitMs: timeLimitFor(this.variant.signal, this.cfg),
          breakevenArmed: pos.breakevenArmed,
          ...(this.variant.trailPct ? { trailPct: this.variant.trailPct } : {}),
          ...(this.variant.fade ? { fade: true } : {}),
          ...pos.state
        },
        flow: this.flow(pos.mint)
      },
      this.cfg
    );
    if (verdict.armBreakeven) pos.breakevenArmed = true;
    if (verdict.patch) pos.state = { ...pos.state, ...verdict.patch };
    if (verdict.action !== "exit" || !verdict.code) return null;
    // The stop is only acted on with a price in hand for this tick; tick() never re-fires a stale stop.
    if (verdict.code === "STRATEGY_STOP" && !markFresh) return null;
    const quote = quotePaperSell(pos.lastMark, pos.qty, pos.liquidityUsd);
    const proceedsUsd = roundUsd(quote.proceedsUsd ?? 0);
    const trade: ShadowTrade = {
      id: randomUUID(),
      variant: this.variant.id,
      signal: this.variant.signal,
      mint: pos.mint,
      symbol: pos.symbol,
      openedAt: pos.openedAt,
      closedAt: now,
      costUsd: pos.costUsd,
      proceedsUsd,
      pnlUsd: roundUsd(proceedsUsd - pos.costUsd),
      exitCode: verdict.code
    };
    this.positions.delete(pos.mint);
    this.cashUsd = roundUsd(this.cashUsd + proceedsUsd);
    this.trades.push(trade);
    return trade;
  }
}
