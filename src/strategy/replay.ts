import { feedOf, TICK_SOURCE, type RecordedQuote, type RecordedSignal } from "../market/recorder.js";
import { SIGNALS, STRATEGY, type SignalKind, type StrategyConfig, type Variant } from "./config.js";
import { performance } from "node:perf_hooks";
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
 * per rule set. Every saved signal is taken as its own position (no open limit, no daily pause,
 * no skip while the coin is still held), so rule sets are compared on the same entries. Fills use the paper model: results are estimates, and a rule set
 * that wins on a few dozen trades has not shown anything yet.
 */
export async function replaySaved(
  quotes: RecordedQuote[],
  signals: RecordedSignal[],
  opts: { targetNetUsd?: number; tradeUsd?: number; grid?: ReplayRules[]; /** Quotes between clock checks. Tests set 1 to force yields. */ yieldEvery?: number; /** When the replay was asked for. Timers do not run past it. Absent: the last saved quote. */ until?: number } = {}
): Promise<ReplayResult> {
  const targetNetUsd = opts.targetNetUsd ?? STRATEGY.targetNetUsd;
  const tradeUsd = opts.tradeUsd ?? STRATEGY.tradeUsd;
  const grid = opts.grid ?? replayGrid();
  const flows = new Map<string, MarketFlow>();
  // Each saved signal gets its own position key, so a coin that signals again while a slow rule
  // still holds it is taken by every rule set: all of them see the same entries.
  const coinOf = (key: string) => key.slice(0, key.indexOf("#"));
  interface Entry {
    signal: SignalKind;
    rules: ReplayRules;
    book: ShadowBook;
  }
  const books: Entry[] = [];
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
      books.push({ signal, rules, book: new ShadowBook(variant, { cfg, flow: (key) => flows.get(coinOf(key)), sizing: () => ({ targetNetUsd, tradeUsd, maxOpen: Number.MAX_SAFE_INTEGER }) }) });
    });
  }

  const sortedSignals = [...signals].sort((a, b) => a.t - b.t);
  /** Coin → open position keys and the book holding each. A quote only visits books that hold the coin. */
  const holders = new Map<string, Array<{ key: string; entry: Entry }>>();
  /** The feed that priced a coin's signal. The desk marks the position only by that feed, so the replay does too. */
  const coinFeed = new Map<string, string>();
  /**
   * Time passing between two saved quotes. The desk checks timer exits every pass on the last mark
   * while it is fresh, so a time limit or a stall that falls between quotes sells at the earlier price.
   */
  const passMs = 2_000;
  const advance = (key: string, entry: Entry, until: number) => {
    const pos = entry.book.positions.get(key);
    if (!pos) return;
    const end = Math.min(until, pos.lastMarkAt + STRATEGY.watch.markFreshMs);
    for (let t = pos.lastMarkAt + passMs; t < end; t += passMs) {
      if (entry.book.tickOne(key, t)) return;
    }
  };
  let next = 0;
  const openSignals = (until: number) => {
    while (next < sortedSignals.length && sortedSignals[next]!.t <= until) {
      const index = next;
      const s = sortedSignals[next++]!;
      const liquidityUsd = Number(s.detail.liquidityUsd);
      if (!(s.priceUsd > 0) || !(liquidityUsd > 0)) continue;
      const vol5mUsd = Number(s.detail.vol5mUsd);
      const key = `${s.mint}#${index}`;
      if (typeof s.detail.feed === "string" && s.detail.feed) coinFeed.set(s.mint, s.detail.feed);
      for (const entry of books) {
        if (entry.signal !== s.kind) continue;
        const opened = entry.book.open({ mint: key, symbol: s.symbol, priceUsd: s.priceUsd, liquidityUsd, vol5mUsd: Number.isFinite(vol5mUsd) ? vol5mUsd : null }, s.t);
        if (!opened.ok) continue;
        const list = holders.get(s.mint);
        if (list) list.push({ key, entry });
        else holders.set(s.mint, [{ key, entry }]);
      }
    }
  };
  // The desk is trading while this runs: work in short slices and hand the event loop back.
  const sliceMs = 6;
  const checkEvery = Math.max(1, Math.min(200, opts.yieldEvery ?? 200));
  let sliceStart = performance.now();
  for (let i = 0; i < quotes.length; i += 1) {
    if (i % checkEvery === 0 && performance.now() - sliceStart >= sliceMs) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
    const q = quotes[i]!;
    openSignals(q.t);
    const held = holders.get(q.mint);
    // A saved held-position tick: the desk marks its books on it and reads nothing else from it.
    if (q.source === TICK_SOURCE) {
      if (held) {
        for (let h = held.length - 1; h >= 0; h -= 1) {
          const { key, entry } = held[h]!;
          advance(key, entry, q.t);
          entry.book.onMark(key, q.priceUsd, q.t, q.liquidityUsd ?? undefined);
          if (!entry.book.positions.has(key)) held.splice(h, 1);
        }
        if (held.length === 0) holders.delete(q.mint);
      }
      continue;
    }
    const anchor = coinFeed.get(q.mint);
    // A quote from another feed is one the desk would not have acted on. Time still passes.
    if (anchor && feedOf(q.source) !== anchor) {
      if (held) for (let h = held.length - 1; h >= 0; h -= 1) {
        advance(held[h]!.key, held[h]!.entry, q.t);
        if (!held[h]!.entry.book.positions.has(held[h]!.key)) held.splice(h, 1);
      }
      continue;
    }
    if (held) for (const { key, entry } of held) advance(key, entry, q.t);
    flows.set(q.mint, { at: q.flowAt ?? q.t, vol5mUsd: q.vol5mUsd, buys5m: q.buys5m, sells5m: q.sells5m, liquidityUsd: q.liquidityUsd });
    if (held) {
      for (let h = held.length - 1; h >= 0; h -= 1) {
        const { key, entry } = held[h]!;
        entry.book.onMark(key, q.priceUsd, q.t, q.liquidityUsd ?? undefined);
        if (!entry.book.positions.has(key)) held.splice(h, 1);
      }
      if (held.length === 0) holders.delete(q.mint);
    }
  }
  // Positions with no later quote still run out their timers on the last mark.
  // Only up to the cutoff: a deadline after the data ends has not happened, so that position stays open.
  const cutoff = opts.until ?? (quotes.length ? quotes[quotes.length - 1]!.t : 0);
  for (const held of holders.values()) for (const { key, entry } of held) advance(key, entry, cutoff + 1);
  // Signals after the last saved quote open and stay open: they are reported, not scored.
  openSignals(Number.POSITIVE_INFINITY);

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
  // Rule sets that closed a trade come first, best net first. An untested rule set (net 0) never outranks a tested one.
  rows.sort((a, b) => Number(b.trades > 0) - Number(a.trades > 0) || b.netUsd - a.netUsd || b.trades - a.trades);
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
