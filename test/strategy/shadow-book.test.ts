import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { quotePaperBuy, quotePaperSell } from "../../src/agents/execution-math.js";
import { STRATEGY, variantById } from "../../src/strategy/config.js";
import { scoreVariant } from "../../src/strategy/scorecard.js";
import { ShadowBook, type ShadowTrade } from "../../src/strategy/shadow-book.js";
import { ShadowStore } from "../../src/strategy/store.js";

const t0 = Date.UTC(2026, 10, 11, 15, 0, 0);
const LIQ = 200_000;
const coin = (mint = "A", priceUsd = 1) => ({ mint, symbol: mint, priceUsd, liquidityUsd: LIQ });
const book = (id = "launch-1", trades: ShadowTrade[] = []) => new ShadowBook(variantById(id)!, { trades });

describe("shadow book", () => {
  it("opens at the modeled paper fill and takes the cost out of cash", () => {
    const b = book();
    const opened = b.open(coin(), t0);
    expect(opened.ok).toBe(true);
    const quote = quotePaperBuy(1, 50, LIQ);
    if (!quote.ok || !opened.ok) throw new Error("expected fills");
    expect(opened.position.entryPrice).toBeCloseTo(quote.fillPrice, 12);
    expect(opened.position.qty).toBeCloseTo(quote.qty, 12);
    expect(b.cashUsd).toBe(50);
  });

  it("stops at the variant stop and books the modeled loss", () => {
    const b = book("launch-1");
    const opened = b.open(coin(), t0);
    if (!opened.ok) throw new Error("no fill");
    const entry = opened.position.entryMark;
    expect(b.onMark("A", entry * 0.995, t0 + 5_000)).toBeNull();
    const mark = entry * 0.989;
    const trade = b.onMark("A", mark, t0 + 10_000);
    expect(trade?.exitCode).toBe("STRATEGY_STOP");
    const sell = quotePaperSell(mark, opened.position.qty, LIQ);
    expect(trade?.proceedsUsd).toBe(sell.proceedsUsd);
    expect(trade?.pnlUsd).toBeCloseTo((sell.proceedsUsd ?? 0) - 50, 2);
    expect(trade!.pnlUsd).toBeLessThan(0);
    expect(b.positions.size).toBe(0);
    expect(b.cashUsd).toBeCloseTo(50 + (sell.proceedsUsd ?? 0), 2);
  });

  it("a wider stop holds through a dip that stops the 1% book", () => {
    const tight = book("launch-1");
    const wide = book("launch-6");
    for (const b of [tight, wide]) b.open(coin(), t0);
    const entry = tight.positions.get("A")!.entryMark;
    expect(tight.onMark("A", entry * 0.98, t0 + 5_000)?.exitCode).toBe("STRATEGY_STOP");
    expect(wide.onMark("A", entry * 0.98, t0 + 5_000)).toBeNull();
    expect(wide.onMark("A", entry * 0.94, t0 + 9_000)?.exitCode).toBe("STRATEGY_STOP");
  });

  it("takes profit once a sell nets the target", () => {
    const b = book();
    b.open(coin(), t0);
    expect(b.onMark("A", 1.05, t0 + 5_000)).toBeNull();
    const trade = b.onMark("A", 1.08, t0 + 10_000);
    expect(trade?.exitCode).toBe("TAKE_PROFIT");
    expect(trade!.pnlUsd).toBeGreaterThanOrEqual(3);
  });

  it("gives back to breakeven after reaching half the target", () => {
    const b = book("launch-6");
    b.open(coin(), t0);
    expect(b.onMark("A", 1.045, t0 + 5_000)).toBeNull();
    expect(b.positions.get("A")!.breakevenArmed).toBe(true);
    const trade = b.onMark("A", 1.004, t0 + 10_000);
    expect(trade?.exitCode).toBe("BREAKEVEN_STOP");
    expect(Math.abs(trade!.pnlUsd)).toBeLessThan(0.5);
  });

  it("closes at the time limit from tick, on a fresh mark only", () => {
    const b = book("launch-6");
    b.open(coin(), t0);
    const limit = STRATEGY.launch.timeLimitMs;
    b.onMark("A", 1.002, t0 + limit - 5_000);
    expect(b.tick(t0 + limit - 1)).toEqual([]);
    expect(b.tick(t0 + limit).map((t) => t.exitCode)).toEqual(["TIME_LIMIT"]);

    const stale = book("launch-6");
    stale.open(coin(), t0);
    stale.onMark("A", 1.002, t0 + 60_000);
    expect(stale.tick(t0 + limit + 60_000)).toEqual([]);
    expect(stale.positions.size).toBe(1);
  });

  it("holds two positions at most and never doubles up on a coin", () => {
    const b = book();
    expect(b.open(coin("A"), t0).ok).toBe(true);
    expect(b.open(coin("A"), t0 + 1).ok).toBe(false);
    expect(b.open(coin("B"), t0 + 2).ok).toBe(true);
    const third = b.open(coin("C"), t0 + 3);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toMatch(/open/i);
  });

  it("refuses a pool too thin to fill or to exit", () => {
    const b = book();
    expect(b.open({ ...coin(), liquidityUsd: 0 }, t0).ok).toBe(false);
    expect(b.open({ ...coin(), liquidityUsd: 1_000 }, t0).ok).toBe(false);
    expect(b.open({ ...coin(), priceUsd: 0 }, t0).ok).toBe(false);
    expect(b.cashUsd).toBe(100);
  });

  it("ignores an absurd upward print instead of booking a fake profit", () => {
    const b = book();
    b.open(coin(), t0);
    expect(b.onMark("A", 1_000, t0 + 5_000)).toBeNull();
    expect(b.onMark("A", 40, t0 + 6_000)).toBeNull();
    expect(b.positions.size).toBe(1);
    // A real crash is never ignored.
    expect(b.onMark("A", 0.4, t0 + 7_000)?.exitCode).toBe("STRATEGY_STOP");
  });

  it("pauses new entries once the day is $10 down, and resumes the next UTC day", () => {
    const loss = (i: number): ShadowTrade => ({
      id: `t${i}`,
      variant: "launch-1",
      signal: "launch",
      mint: `L${i}`,
      symbol: `L${i}`,
      openedAt: t0 - 60_000,
      closedAt: t0 - 30_000,
      costUsd: 50,
      proceedsUsd: 47.5,
      pnlUsd: -2.5,
      exitCode: "STRATEGY_STOP"
    });
    const b = book("launch-1", [loss(1), loss(2), loss(3), loss(4)]);
    expect(b.cashUsd).toBe(90);
    const refused = b.open(coin(), t0);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/day/i);
    expect(b.open(coin(), t0 + 24 * 3_600_000).ok).toBe(true);
  });

  it("restores cash from its closed trades and shrinks the trade when cash is short", () => {
    const big = (pnlUsd: number): ShadowTrade => ({
      id: `x${pnlUsd}`,
      variant: "launch-1",
      signal: "launch",
      mint: "Z",
      symbol: "Z",
      openedAt: t0 - 10 * 24 * 3_600_000,
      closedAt: t0 - 9 * 24 * 3_600_000,
      costUsd: 50,
      proceedsUsd: 50 + pnlUsd,
      pnlUsd,
      exitCode: "STRATEGY_STOP"
    });
    const b = book("launch-1", [big(-30), big(-30)]);
    expect(b.cashUsd).toBe(40);
    const opened = b.open(coin(), t0);
    expect(opened.ok && opened.position.costUsd).toBe(40);
    const broke = book("launch-1", [big(-48), big(-48)]);
    expect(broke.open(coin(), t0).ok).toBe(false);
  });
});

describe("scorecard", () => {
  const trade = (i: number, pnlUsd: number): ShadowTrade => ({
    id: `s${i}`,
    variant: "momentum-3",
    signal: "momentum",
    mint: `M${i}`,
    symbol: `M${i}`,
    openedAt: t0 + i * 1_000,
    closedAt: t0 + i * 1_000 + 500,
    costUsd: 50,
    proceedsUsd: 50 + pnlUsd,
    pnlUsd,
    exitCode: pnlUsd > 0 ? "TAKE_PROFIT" : "STRATEGY_STOP"
  });
  const v = variantById("momentum-3")!;

  it("is all zeros with no trades", () => {
    expect(scoreVariant(v, [])).toMatchObject({ trades: 0, wins: 0, winRate: 0, netUsd: 0, avgNetUsd: 0, maxDrawdownUsd: 0, ready: false });
  });

  it("adds up wins, losses, net and the worst drawdown", () => {
    const s = scoreVariant(v, [trade(1, 3), trade(2, -1), trade(3, -1.5), trade(4, 3.2), trade(5, 0)]);
    expect(s.trades).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.winRate).toBeCloseTo(0.4, 10);
    expect(s.avgWinUsd).toBeCloseTo(3.1, 10);
    expect(s.avgLossUsd).toBeCloseTo(-1.25, 10);
    expect(s.netUsd).toBeCloseTo(3.7, 10);
    expect(s.avgNetUsd).toBeCloseTo(0.74, 10);
    expect(s.maxDrawdownUsd).toBeCloseTo(2.5, 10);
    expect(s.equityUsd).toBeCloseTo(103.7, 10);
  });

  it("is ready only with 200 trades and a net profit", () => {
    const winners = Array.from({ length: 200 }, (_, i) => trade(i, 0.1));
    expect(scoreVariant(v, winners).ready).toBe(true);
    expect(scoreVariant(v, winners.slice(1)).ready).toBe(false);
    const losers = Array.from({ length: 250 }, (_, i) => trade(i, -0.1));
    expect(scoreVariant(v, losers).ready).toBe(false);
  });
});

describe("shadow store", () => {
  it("saves, reloads and clears shadow trades", () => {
    const store = new ShadowStore(new DatabaseSync(":memory:"));
    const b = new ShadowBook(variantById("launch-1")!, {});
    b.open(coin(), t0);
    const closed = b.onMark("A", 0.9, t0 + 5_000)!;
    store.save(closed);
    store.save(closed);
    expect(store.all()).toEqual([closed]);
    const again = new ShadowBook(variantById("launch-1")!, { trades: store.all() });
    expect(again.cashUsd).toBeCloseTo(b.cashUsd, 2);
    store.clear();
    expect(store.all()).toEqual([]);
  });
});
