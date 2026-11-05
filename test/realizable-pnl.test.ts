import { describe, expect, it } from "vitest";
import { MARK_STALE_MS, quotePaperBuy, quotePaperSell, realizablePnl } from "../src/agents/execution-math.js";
import { MARK_SERIES_CAP, PaperBook } from "../src/desk/book.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { testConfig, testDesk } from "./helpers.js";

describe("realizable PnL", () => {
  const now = 1_700_000_000_000;

  it("matches a paper sell quote and keeps buy-side slippage inside the cost", () => {
    const buy = quotePaperBuy(1, 800, 10_000);
    const sell = quotePaperSell(1, buy.qty, 10_000);
    const net = realizablePnl({
      markPrice: 1,
      qty: buy.qty,
      costUsd: 800,
      liquidityUsd: 10_000,
      markAt: now,
      now
    });
    expect(sell.proceedsUsd).toBe(603.19);
    expect(net).not.toBeNull();
    expect(net!.proceedsUsd).toBe(sell.proceedsUsd);
    expect(net!.exitSlippage).toBeCloseTo(sell.slippage, 10);
    expect(net!.netPnlUsd).toBeCloseTo(603.19 - 800, 2);
    expect(net!.netPnlUsd).toBeLessThan(0);
    expect(net!.netPnlPct).toBeCloseTo(net!.netPnlUsd / 800, 10);
  });

  it("is below raw mark PnL by the exit haircut when the coin is up", () => {
    const buy = quotePaperBuy(1, 800, 100_000);
    const mark = 1.4;
    const raw = buy.qty * mark - 800;
    const net = realizablePnl({
      markPrice: mark,
      qty: buy.qty,
      costUsd: 800,
      liquidityUsd: 100_000,
      markAt: now - 1_000,
      now
    });
    expect(raw).toBeGreaterThan(0);
    expect(net).not.toBeNull();
    expect(net!.netPnlUsd).toBeLessThan(raw);
    expect(net!.netPnlUsd).toBeGreaterThan(0);
    expect(net!.exitSlippage).toBeGreaterThan(0.0015);
  });

  it("charges the configured slippage ceiling when liquidity is unknown, and does not invent a rate", () => {
    const net = realizablePnl({
      markPrice: 2,
      qty: 100,
      costUsd: 100,
      liquidityUsd: 0,
      markAt: now,
      now
    });
    const quoted = quotePaperSell(2, 100, 0);
    expect(quoted.slippage).toBe(0.5);
    expect(net!.exitSlippage).toBe(0.5);
    expect(net!.netPnlUsd).toBeLessThan(100 * 2 - 100);

    expect(
      realizablePnl({
        markPrice: 2,
        qty: 100,
        costUsd: 100,
        liquidityUsd: Number.NaN,
        markAt: now,
        now
      })
    ).toBeNull();
  });

  it("withholds a net figure when the mark is missing, stale, or unstamped", () => {
    const base = { markPrice: 3, qty: 10, costUsd: 10, liquidityUsd: 50_000, now };
    expect(realizablePnl({ ...base, markPrice: 0, markAt: now })).toBeNull();
    expect(realizablePnl({ ...base, markPrice: Number.NaN, markAt: now })).toBeNull();
    expect(realizablePnl({ ...base, markAt: null })).toBeNull();
    expect(realizablePnl({ ...base, markAt: now - MARK_STALE_MS })).toBeNull();
    expect(realizablePnl({ ...base, markAt: now - MARK_STALE_MS + 1 })).not.toBeNull();
    expect(realizablePnl({ ...base, markAt: now + 60_000 })).toBeNull();
    expect(realizablePnl({ ...base, qty: 0, markAt: now })).toBeNull();
    expect(realizablePnl({ ...base, costUsd: 0, markAt: now })).toBeNull();
  });
});

describe("position sparkline and live net", () => {
  it("keeps a bounded series and only for coins actually held", () => {
    const book = new PaperBook(100);
    const mint = "Mint111111111111111111111111111111111111111";
    book.mark(mint, 1, 1_000);
    expect(book.seriesFor(mint)).toEqual([]);
    book.positions.set(mint, {
      mint,
      symbol: "X",
      name: "X",
      qty: 1,
      entryPrice: 1,
      costUsd: 1,
      openedAt: 0,
      peakPrice: 1,
      trailArmed: false,
      score: 1,
      source: "replay",
      liquidityUsd: 10_000,
      tradeId: "t"
    });
    for (let i = 0; i < MARK_SERIES_CAP + 10; i += 1) {
      book.mark(mint, 1 + i / 100, 10_000 + i * 2_000);
    }
    const series = book.seriesFor(mint);
    expect(series).toHaveLength(MARK_SERIES_CAP);
    expect(series[0]?.priceUsd).toBeCloseTo(1 + 10 / 100, 10);
    expect(series.at(-1)?.priceUsd).toBeCloseTo(1 + (MARK_SERIES_CAP + 9) / 100, 10);
    book.forgetMarks(mint);
    expect(book.seriesFor(mint)).toEqual([]);
    expect(book.lastPrice.has(mint)).toBe(false);
  });

  it("shows raw mark PnL and a smaller after-slippage net on a fresh mark", async () => {
    const desk = testDesk();
    try {
      const mint = "NetMint111111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint, symbol: "NET", priceUsd: 1, liquidityUsd: 100_000 }));
      const open = desk.snapshot().positions.find((pos) => pos.mint === mint);
      expect(open).toBeTruthy();
      expect(open!.entrySlippage).toBeGreaterThan(0);
      expect(open!.marks.at(-1)?.priceUsd).toBe(1);
      expect(open!.markStale).toBe(false);
      expect(open!.netPnlUsd).not.toBeNull();
      expect(open!.netPnlUsd!).toBeLessThan(open!.pnlUsd);
      const sell = quotePaperSell(1, open!.qty, 100_000);
      expect(open!.netPnlUsd).toBeCloseTo((sell.proceedsUsd ?? 0) - open!.costUsd, 2);
      expect(open!.exitSlippage).toBeCloseTo(sell.slippage, 10);

      await desk.markPrice(mint, 1.25);
      const next = desk.snapshot().positions.find((pos) => pos.mint === mint)!;
      expect(next.marks.length).toBeGreaterThanOrEqual(2);
      expect(next.marks.at(-1)?.priceUsd).toBe(1.25);
      expect(next.pnlUsd).toBeGreaterThan(0);
      const up = quotePaperSell(1.25, next.qty, 100_000);
      expect(next.netPnlUsd).toBeCloseTo((up.proceedsUsd ?? 0) - next.costUsd, 2);
      expect(next.netPnlUsd!).toBeLessThan(next.pnlUsd);
    } finally {
      desk.stop();
    }
  });

  it("does not publish a profitable net off a stale mark, and restores a fresh series", async () => {
    const cfg = testConfig({ resetPaper: true });
    const desk = new Desk(cfg);
    const mint = "StaleMint1111111111111111111111111111111111";
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "STALE", priceUsd: 1, liquidityUsd: 80_000 }));
      desk.book.mark(mint, 4, Date.now() - MARK_STALE_MS - 1_000);
      const stale = desk.snapshot().positions.find((pos) => pos.mint === mint)!;
      expect(stale.markPrice).toBe(4);
      expect(stale.pnlUsd).toBeGreaterThan(0);
      expect(stale.netPnlUsd).toBeNull();
      expect(stale.netPnlPct).toBeNull();
      expect(stale.exitSlippage).toBeNull();
      expect(stale.markStale).toBe(true);

      await desk.markPrice(mint, 1.05);
      expect(desk.snapshot().positions.find((pos) => pos.mint === mint)!.netPnlUsd).not.toBeNull();
    } finally {
      desk.stop();
    }

    const again = new Desk({ ...cfg, resetPaper: false });
    try {
      const restored = again.snapshot().positions.find((pos) => pos.mint === mint);
      expect(restored).toBeTruthy();
      expect(restored!.marks.length).toBeGreaterThan(0);
      expect(restored!.marks.at(-1)?.priceUsd).toBe(1.05);
      expect(restored!.entrySlippage).toBeGreaterThan(0);
      expect(restored!.netPnlUsd).not.toBeNull();
      expect(restored!.markStale).toBe(false);
    } finally {
      again.stop();
    }
  });
});
