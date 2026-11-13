import type { RecordedQuote, RecordedSignal } from "../market/recorder.js";
import { SIGNALS, STRATEGY, type SignalKind, type StrategyConfig, type Variant } from "./config.js";
import type { MarketFlow } from "./exits.js";
import { scoreVariant } from "./scorecard.js";
import { ShadowBook } from "./shadow-book.js";

/** One set of exit rules tried against the saved data. */
export interface ReplayRules {
  stopPct: number;
  /** Absent: sell at the target. */
  trailPct?: number;
  fade?: boolean;
  /** Trailing only: the share of the target a trailing trade may fall back to before it is sold. */
  lockShare?: number;
}

export interface ReplayRow {
  signal: SignalKind;
  rules: ReplayRules;
  label: string;
  trades: number;
  wins: number;
  winRate: number;
  netUsd: number;
  avgNetUsd: number;
  maxDrawdownUsd: number;
  /** Still open when the saved data ran out. Not counted in the result. */
  open: number;
}

export interface ReplayResult {
  from: number | null;
  to: number | null;
  quotes: number;
  signals: number;
  targetNetUsd: number;
  tradeUsd: number;
  rows: ReplayRow[];
  note: string;
}

export const REPLAY_GRID = {
  stops: [0.01, 0.03, 0.06],
  trails: [0.04, 0.08, 0.12],
  lockShares: [0, 0.25, 0.5]
} as const;

const pct = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;

export function rulesLabel(rules: ReplayRules): string {
  if (rules.trailPct == null) return `${pct(rules.stopPct)} stop, sell at target`;
  const lock = rules.lockShare === 0 ? "breakeven" : `${pct(rules.lockShare ?? STRATEGY.trail.lockShare)} of target`;
  return `${pct(rules.stopPct)} stop, ${pct(rules.trailPct)} trail, lock ${lock}${rules.fade ? ", fade" : ""}`;
}

export function replayGrid(): ReplayRules[] {
  const out: ReplayRules[] = [];
  for (const stopPct of REPLAY_GRID.stops) {
    out.push({ stopPct });
    for (const trailPct of REPLAY_GRID.trails) {
      for (const lockShare of REPLAY_GRID.lockShares) {
        out.push({ stopPct, trailPct, lockShare });
        out.push({ stopPct, trailPct, lockShare, fade: true });
      }
    }
  }
  return out;
}

/**
 * Replays saved signals and quotes through the same shadow-book code the desk trades with, once
 * per rule set. Every saved signal is taken (no open limit, no daily pause), so rule sets are
 * compared on the same trades. Fills use the paper model: results are estimates, and a rule set
 * that wins on a few dozen trades has not shown anything yet.
 */
export async function replaySaved(
  quotes: RecordedQuote[],
  signals: RecordedSignal[],
  opts: { targetNetUsd?: number; tradeUsd?: number; grid?: ReplayRules[]; yieldEvery?: number } = {}
): Promise<ReplayResult> {
  const targetNetUsd = opts.targetNetUsd ?? STRATEGY.targetNetUsd;
  const tradeUsd = opts.tradeUsd ?? STRATEGY.tradeUsd;
  const grid = opts.grid ?? replayGrid();
  const flows = new Map<string, MarketFlow>();
  const books: Array<{ signal: SignalKind; rules: ReplayRules; book: ShadowBook }> = [];
  for (const signal of SIGNALS) {
    grid.forEach((rules, index) => {
      const cfg = {
        ...STRATEGY,
        targetNetUsd,
        tradeUsd,
        maxOpen: Number.MAX_SAFE_INTEGER,
        dailyMaxLossUsd: Number.MAX_SAFE_INTEGER,
        startingUsd: 1_000_000_000,
        trail: { ...STRATEGY.trail, lockShare: rules.lockShare ?? STRATEGY.trail.lockShare }
      } as unknown as StrategyConfig;
      const variant: Variant = { id: `replay-${signal}-${index}`, signal, stopPct: rules.stopPct, ...(rules.trailPct != null ? { trailPct: rules.trailPct } : {}), ...(rules.fade ? { fade: true } : {}) };
      books.push({ signal, rules, book: new ShadowBook(variant, { cfg, flow: (mint) => flows.get(mint), sizing: () => ({ targetNetUsd, tradeUsd, maxOpen: Number.MAX_SAFE_INTEGER }) }) });
    });
  }

  const sortedSignals = [...signals].sort((a, b) => a.t - b.t);
  const yieldEvery = Math.max(1_000, opts.yieldEvery ?? 5_000);
  let next = 0;
  const openSignals = (until: number) => {
    while (next < sortedSignals.length && sortedSignals[next]!.t <= until) {
      const s = sortedSignals[next++]!;
      const liquidityUsd = Number(s.detail.liquidityUsd);
      if (!(s.priceUsd > 0) || !(liquidityUsd > 0)) continue;
      const vol5mUsd = Number(s.detail.vol5mUsd);
      for (const entry of books) {
        if (entry.signal !== s.kind) continue;
        entry.book.open({ mint: s.mint, symbol: s.symbol, priceUsd: s.priceUsd, liquidityUsd, vol5mUsd: Number.isFinite(vol5mUsd) ? vol5mUsd : null }, s.t);
      }
    }
  };
  for (let i = 0; i < quotes.length; i += 1) {
    const q = quotes[i]!;
    openSignals(q.t);
    flows.set(q.mint, { at: q.t, vol5mUsd: q.vol5mUsd, buys5m: q.buys5m, sells5m: q.sells5m, liquidityUsd: q.liquidityUsd });
    for (const entry of books) {
      if (entry.book.positions.has(q.mint)) entry.book.onMark(q.mint, q.priceUsd, q.t, q.liquidityUsd ?? undefined);
    }
    // The desk is trading while this runs: hand the event loop back regularly.
    if (i > 0 && i % yieldEvery === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const rows: ReplayRow[] = books.map(({ signal, rules, book }) => {
    const score = scoreVariant(book.variant, book.trades);
    return {
      signal,
      rules,
      label: rulesLabel(rules),
      trades: score.trades,
      wins: score.wins,
      winRate: score.winRate,
      netUsd: Math.round(score.netUsd * 100) / 100,
      avgNetUsd: Math.round(score.avgNetUsd * 100) / 100,
      maxDrawdownUsd: Math.round(score.maxDrawdownUsd * 100) / 100,
      open: book.positions.size
    };
  });
  rows.sort((a, b) => b.netUsd - a.netUsd || b.trades - a.trades);
  const most = rows.reduce((n, row) => Math.max(n, row.trades), 0);
  return {
    from: quotes.length ? quotes[0]!.t : null,
    to: quotes.length ? quotes[quotes.length - 1]!.t : null,
    quotes: quotes.length,
    signals: sortedSignals.length,
    targetNetUsd,
    tradeUsd,
    rows,
    note:
      most === 0
        ? "No saved signal has closed a trade yet. Let the desk record for a while."
        : `Paper-model results on saved data: every signal taken at $${tradeUsd}, target $${targetNetUsd} net. ${most < STRATEGY.readyTrades ? `The largest sample is ${most} trades, under the ${STRATEGY.readyTrades} the scorecard asks for, so the order can still be luck.` : ""}`.trim()
  };
}
