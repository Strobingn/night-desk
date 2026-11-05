import { describe, expect, it, vi } from "vitest";
import { quotePaperBuy } from "../src/agents/execution-math.js";
import { formatBuyNotice } from "../src/desk/buy-notice.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { testConfig, testDesk } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({
  executeLiveSwap: vi.fn()
}));

vi.mock("../src/market/live-broker.js", () => ({
  executeLiveSwap: liveBroker.executeLiveSwap
}));

const mint = "UrlMint1111111111111111111111111111111111";

describe("entry slippage guard", () => {
  it("refuses the 50% url fill instead of booking it and stopping out", async () => {
    const desk = testDesk();
    try {
      desk.book.cashUsd = 98;
      desk.config.startingBalanceUsd = 98;
      await desk.submitCandidate(
        makeToken({
          mint,
          symbol: "url",
          priceUsd: 0.00000292,
          liquidityUsd: 31.67,
          volume1hUsd: 180_000
        })
      );
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().closed).toHaveLength(0);
      const logged = desk.snapshot().events.find((event) => event.code === "EXIT_IMPACT");
      expect(logged?.message).toContain("Buy refused.");
      expect(logged?.message).toContain("full exit");
      const manual = await desk.manualBuy(mint, 7.84);
      expect(manual.ok).toBe(false);
      if (!manual.ok) {
        expect(manual.code).toBe("EXIT_IMPACT");
        expect(formatBuyNotice(manual)).toContain("full exit");
        expect(formatBuyNotice(manual)).toContain("Buy refused.");
      }
      expect(desk.book.positions.has(mint)).toBe(false);
      const model = quotePaperBuy(0.00000292, 7.84, 31.67);
      expect(model.ok).toBe(false);
      if (!model.ok) expect(model.slippage).toBeGreaterThan(0.45);
    } finally {
      desk.stop();
    }
  });

  it("still fills a deep-pool buy under the 3% cap", async () => {
    const desk = testDesk();
    try {
      const deep = "DeepMint111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: deep, symbol: "DEEP", priceUsd: 1, liquidityUsd: 180_000 }));
      const pos = desk.book.positions.get(deep);
      expect(pos).toBeTruthy();
      expect(pos!.entryPrice / 1 - 1).toBeLessThanOrEqual(0.03);
    } finally {
      desk.stop();
    }
  });

  it("refuses a live fill that clears the quote cap and does not open the position", async () => {
    liveBroker.executeLiveSwap.mockResolvedValue({
      signature: "slip-sig",
      fillPriceUsd: 0.00000437,
      qty: 1_000_000,
      notionalUsd: 7.84,
      feeUsd: 0.01,
      slippage: 0.5
    });
    const desk = new Desk(testConfig({ mode: "live", walletKeypairPath: "/tmp/night-desk-not-used.json", liveRequested: true }), {
      walletBalances: async () => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null })
    });
    try {
      desk.updateSettings({ liveTradeUsd: 7.84 });
      await desk.submitCandidate(makeToken({ mint, symbol: "url", priceUsd: 0.00000292, liquidityUsd: 180_000 }));
      const bought = await desk.manualBuy(mint, 7.84);
      expect(bought.ok).toBe(false);
      if (!bought.ok) expect(formatBuyNotice(bought)).toContain("Buy refused.");
      expect(desk.liveBook!.positions.has(mint)).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("keeps the entry cap when a save tries to remove it", () => {
    const desk = testDesk();
    try {
      expect(desk.snapshot().rules.maxEntrySlippage).toBe(0.03);
      const removed = desk.updateSettings({ maxEntrySlippage: null });
      expect(removed.ok).toBe(false);
      // v13.3: Dirk may raise it, up to 50%. Past 50% is refused, not stored.
      const widened = desk.updateSettings({ maxEntrySlippage: 50 });
      expect(widened.ok).toBe(true);
      if (widened.ok) expect(widened.settings.maxEntrySlippage).toBe(0.5);
      expect(desk.updateSettings({ maxEntrySlippage: 80 }).ok).toBe(false);
      const tighter = desk.updateSettings({ maxEntrySlippage: 1 });
      expect(tighter.ok).toBe(true);
      if (tighter.ok) expect(tighter.settings.maxEntrySlippage).toBe(0.01);
      expect(desk.config.rules.stopLossPct).toBe(0.06);
    } finally {
      desk.stop();
    }
  });
});

describe("analyst trade line 0.10–0.95", () => {
  it("saves 0.30, shows that applied value, and reloads it", () => {
    const config = testConfig();
    const desk = new Desk(config);
    expect(desk.snapshot().rules.analystMinScore).toBe(0.5);
    const saved = desk.updateSettings({ analystMinScore: 0.3 });
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      desk.stop();
      return;
    }
    expect(saved.settings.analystMinScore).toBe(0.3);
    expect(desk.snapshot().rules.analystMinScore).toBe(0.3);
    expect(desk.config.rules.stopLossPct).toBe(0.06);
    desk.stop();
    const restarted = new Desk({ ...config, resetPaper: false });
    expect(restarted.snapshot().rules.analystMinScore).toBe(0.3);
    expect(restarted.config.rules.stopLossPct).toBe(0.06);
    restarted.stop();
  });

  it("rejects a line outside 0.10–0.95 and leaves the saved line alone", () => {
    const desk = testDesk();
    try {
      expect(desk.updateSettings({ analystMinScore: 0.3 }).ok).toBe(true);
      for (const raw of [0.05, 0.96, 1, Number.NaN]) {
        const refused = desk.updateSettings({ analystMinScore: raw });
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error).toBe("Trade line must be from 0.10 to 0.95.");
      }
      expect(desk.snapshot().rules.analystMinScore).toBe(0.3);
      expect(desk.config.rules.stopLossPct).toBe(0.06);
      expect(desk.snapshot().rules.maxTop10Pct).toBe(0.35);
    } finally {
      desk.stop();
    }
  });
});
