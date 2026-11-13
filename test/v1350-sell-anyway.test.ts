import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { sellImpactRefused, sellQuoteTolerance } from "../src/market/live-broker.js";
import { POOL_DRAINED_MESSAGE, offersSellAnyway, sellExitImpactError } from "../src/market/live-submit.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { isDeadHolding, splitHoldings } from "../web/src/holdings.js";
import { testConfig, testDesk } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", async () => {
  const actual = await vi.importActual<typeof import("../src/market/live-broker.js")>("../src/market/live-broker.js");
  return { ...actual, executeLiveSwap: liveBroker.executeLiveSwap };
});

const mint = "InsaneMint111111111111111111111111111111111";
const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });

function liveDesk(): Desk {
  const secret = JSON.stringify([...Keypair.generate().secretKey]);
  const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: rich });
  desk.setOperatorReady(true);
  desk.updateSettings({ autoBuy: false, liveDailyCapUsd: 20 });
  return desk;
}

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
});

describe("v13.50 manual sell past the exit cap", () => {
  it("keeps the saved cap on the quote unless the operator confirms", () => {
    expect(sellQuoteTolerance(0.06, false)).toBeCloseTo(0.06);
    expect(sellQuoteTolerance(0.06, true)).toBe(0.5);
    expect(sellImpactRefused(0.22, 0.06, false)).toBe(true);
    expect(sellImpactRefused(0.22, 0.06, true)).toBe(false);
    expect(sellImpactRefused(0.04, 0.06, false)).toBe(false);
    expect(offersSellAnyway(sellExitImpactError(0.22, 0.06).message)).toBe(true);
    expect(offersSellAnyway(POOL_DRAINED_MESSAGE)).toBe(false);
  });

  it("refuses a thin paper sell until Sell anyway, and never sells a drained pool", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      const pos = desk.book.positions.get(mint)!;
      pos.liquidityUsd = 15;
      await desk.markPrice(mint, pos.entryPrice * 1.1);
      const blocked = await desk.closePosition(mint, 1);
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("EXIT_IMPACT");
      expect(blocked.allowSellAnyway).toBe(true);
      expect(blocked.error).toMatch(/would cost \d+\.\d+%/);
      expect(desk.book.positions.has(mint)).toBe(true);
      expect(desk.config.rules.maxEntrySlippage).toBeLessThanOrEqual(0.03);

      const sold = await desk.closePosition(mint, 1, undefined, { sellAnyway: true });
      expect(sold.ok).toBe(true);
      expect(desk.book.positions.has(mint)).toBe(false);

      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      const again = desk.book.positions.get(mint)!;
      again.liquidityUsd = 0;
      await desk.markPrice(mint, again.entryPrice);
      const drained = await desk.closePosition(mint, 1, undefined, { sellAnyway: true });
      expect(drained.ok).toBe(false);
      if (drained.ok) return;
      expect(drained.error).toBe(POOL_DRAINED_MESSAGE);
      expect(drained.allowSellAnyway).toBeUndefined();
      expect(desk.book.positions.has(mint)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("forwards Sell anyway on a live manual close and still refuses when the mock has no route", async () => {
    liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number; sellAnyway?: boolean }) => {
      if (req.side === "buy") {
        return { signature: "sig-buy", fillPriceUsd: 1.01, qty: (req.sizeUsd ?? 5) / 1.01, notionalUsd: req.sizeUsd ?? 5, feeUsd: 0.01, slippage: 0.01 };
      }
      if (!req.sellAnyway) throw sellExitImpactError(0.22, 0.06);
      return { signature: "sig-sell", fillPriceUsd: 0.78, qty: req.qty ?? 0, notionalUsd: (req.qty ?? 0) * 0.78, feeUsd: 0.01, slippage: 0.22 };
    });
    const desk = liveDesk();
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      const bought = await desk.manualBuy(mint, 5, { book: "live" });
      expect(bought.ok).toBe(true);
      const blocked = await desk.closePosition(mint, 1, "live");
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.allowSellAnyway).toBe(true);
      expect(blocked.error).toMatch(/would cost 22\.00%/);
      expect(desk.liveBook?.positions.has(mint)).toBe(true);
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell");
      expect(sells.at(-1)?.[0].sellAnyway).not.toBe(true);

      const sold = await desk.closePosition(mint, 1, "live", { sellAnyway: true });
      expect(sold.ok).toBe(true);
      const confirmed = liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell").at(-1)?.[0];
      expect(confirmed?.sellAnyway).toBe(true);
      expect(desk.liveBook?.positions.has(mint)).toBe(false);
    } finally {
      desk.stop();
    }

    liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number }) => {
      if (req.side === "buy") {
        return { signature: "sig-buy", fillPriceUsd: 1.01, qty: (req.sizeUsd ?? 5) / 1.01, notionalUsd: req.sizeUsd ?? 5, feeUsd: 0.01, slippage: 0.01 };
      }
      const { noSellRouteError } = await import("../src/market/live-submit.js");
      throw noSellRouteError();
    });
    const drained = liveDesk();
    try {
      await drained.submitCandidate(makeToken({ mint, symbol: "DACITY", priceUsd: 1, liquidityUsd: 180_000 }));
      expect((await drained.manualBuy(mint, 5, { book: "live" })).ok).toBe(true);
      const refused = await drained.closePosition(mint, 1, "live", { sellAnyway: true });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error).toBe(POOL_DRAINED_MESSAGE);
      expect(refused.allowSellAnyway).toBeUndefined();
      expect(drained.liveBook?.positions.has(mint)).toBe(true);
    } finally {
      drained.stop();
    }
  });
});

describe("v13.50 dead holdings stay listed, out of the main cards", () => {
  it("splits liquidity-gone positions and leaves the others", () => {
    const rows = [
      { symbol: "ALIVE", liquidityNote: null },
      { symbol: "INSANE", liquidityNote: "Liquidity gone, no sell route" },
      { symbol: "PAPER", liquidityNote: "" },
      { symbol: "DACITY", liquidityNote: "Liquidity gone, no sell route" }
    ];
    expect(isDeadHolding(rows[0]!)).toBe(false);
    expect(isDeadHolding(rows[1]!)).toBe(true);
    const split = splitHoldings(rows);
    expect(split.open.map((row) => row.symbol)).toEqual(["ALIVE", "PAPER"]);
    expect(split.dead.map((row) => row.symbol)).toEqual(["INSANE", "DACITY"]);
    expect(rows).toHaveLength(4);
  });
});
