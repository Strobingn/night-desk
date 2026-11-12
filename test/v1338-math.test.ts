import { describe, expect, it } from "vitest";
import { quotePaperBuy, quotePaperSell, realizablePnl, slippageFor, maxSizeForPool, exitImpactAllowed } from "../src/agents/execution-math.js";
import { assessPosition } from "../src/agents/risk.js";
import { HARD_RULES, pctText, resolveRules } from "../src/rules.js";
import { assessStrategyExit, strategyStopPrice } from "../src/strategy/exits.js";
import { ShadowBook } from "../src/strategy/shadow-book.js";
import { VARIANTS } from "../src/strategy/config.js";

const meta = { variant: "launch-1", signal: "launch" as const, stopPct: 0.01, targetNetUsd: 3, timeLimitMs: 600_000 };

describe("13.38 math audit", () => {
  it("the fill model matches an exact constant-product pool", () => {
    for (const [x, L] of [[50, 20_000], [50, 8_000], [500, 100_000]] as const) {
      const p = 0.001;
      const R = L * HARD_RULES.poolSideShare;
      const T = R / p;
      const tokensOut = (T * x) / (R + x);
      expect(slippageFor(x, L, "buy") - HARD_RULES.baseSlippage).toBeCloseTo(x / tokensOut / p - 1, 12);
      const y = x / p;
      const usdOut = (R * y) / (T + y);
      expect(slippageFor(x, L, "sell") - HARD_RULES.baseSlippage).toBeCloseTo(1 - usdOut / x, 12);
    }
  });

  it("a round trip at an unchanged mark loses exactly fees plus both slippages", () => {
    const q = quotePaperBuy(0.001, 50, 50_000);
    if (!q.ok) throw new Error("buy refused");
    const sell = quotePaperSell(0.001, q.qty, 50_000);
    expect(q.feeUsd).toBe(0.05);
    const gross = q.qty * 0.001 * (1 - sell.slippage);
    expect(sell.proceedsUsd).toBeCloseTo(Math.floor((gross - sell.feeUsd) * 100) / 100, 9);
    expect(sell.proceedsUsd!).toBeLessThan(50);
  });

  it("the engine stop is measured from the entry mark, so a thin pool is not stopped at an unchanged price", () => {
    const mark = 0.001;
    const q = quotePaperBuy(mark, 50, 11_000);
    if (!q.ok) throw new Error("buy refused");
    expect(q.slippage).toBeGreaterThan(0.01);
    const net = realizablePnl({ markPrice: mark, qty: q.qty, costUsd: 50, liquidityUsd: 11_000, markAt: 0, now: 0 });
    const base = { entryPrice: q.fillPrice, openedAt: 0, mark, markFresh: true, netPnlUsd: net!.netPnlUsd, now: 1_000, meta };
    expect(assessStrategyExit({ ...base, entryMark: mark }).action).toBe("hold");
    expect(assessStrategyExit({ ...base, entryMark: mark, mark: mark * 0.9901 }).action).toBe("hold");
    expect(assessStrategyExit({ ...base, entryMark: mark, mark: mark * 0.99 }).code).toBe("STRATEGY_STOP");
    expect(strategyStopPrice(q.fillPrice, undefined, 0.01)).toBeCloseTo(q.fillPrice * 0.99, 15);
  });

  it("a shadow book holds a thin-pool buy through an unchanged mark and stops 1% under it", () => {
    const book = new ShadowBook(VARIANTS.find((v) => v.id === "launch-1")!);
    const opened = book.open({ mint: "M", symbol: "M", priceUsd: 0.001, liquidityUsd: 11_000 }, 0);
    expect(opened.ok).toBe(true);
    expect(book.onMark("M", 0.001, 1_000)).toBeNull();
    const trade = book.onMark("M", 0.00099, 2_000);
    expect(trade?.exitCode).toBe("STRATEGY_STOP");
    expect(trade!.pnlUsd).toBeLessThan(0);
    expect(book.cashUsd).toBeCloseTo(100 + trade!.pnlUsd, 9);
  });

  it("the largest pool size passes both caps and one cent more does not", () => {
    const max = maxSizeForPool(20_000);
    expect(quotePaperBuy(1, max, 20_000).ok).toBe(true);
    expect(exitImpactAllowed(max, 20_000).ok).toBe(true);
    expect(quotePaperBuy(1, max + 0.02, 20_000).ok).toBe(false);
  });

  it("a 2.5% hard stop is labelled 2.5%, not 3%", () => {
    expect(pctText(0.025)).toBe("2.5%");
    expect(pctText(0.06)).toBe("6%");
    const rules = { ...resolveRules({}), stopLossPct: 0.025 };
    const seen = assessPosition({ entryPrice: 1.01, peakPrice: 1.01, trailArmed: false, entryMark: 1 }, 0.97, rules);
    expect(seen.code).toBe("STOP_LOSS");
    expect(seen.stopPrice).toBeCloseTo(0.975, 12);
    expect(seen.message).toContain("limit -2.5%");
  });
});
