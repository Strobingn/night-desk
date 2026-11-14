import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", async () => {
  const actual = await vi.importActual<typeof import("../src/market/live-broker.js")>("../src/market/live-broker.js");
  return { ...actual, executeLiveSwap: liveBroker.executeLiveSwap };
});

const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 500, at: Date.now(), error: null });

function liveDesk(): Desk {
  const secret = JSON.stringify([...Keypair.generate().secretKey]);
  const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: rich });
  desk.setOperatorReady(true);
  desk.updateStrategy({ enabled: true, liveVariant: "launch-1", maxOpen: 2 });
  return desk;
}

const quote = (at: number, priceUsd: number) => ({
  at,
  priceUsd,
  vol5mUsd: 40_000,
  vol1hUsd: 180_000,
  change1hPct: 15,
  liquidityUsd: 180_000
});

async function fill(desk: Desk, mint: string, symbol: string): Promise<void> {
  const token = makeToken({ mint, symbol, priceUsd: 1, ageSeconds: 600, volume5mUsd: 40_000, liquidityUsd: 180_000, discoveredAt: Date.now() });
  await desk.submitCandidate(token);
  const t = Date.now();
  await desk.submitStrategyQuote(mint, quote(t + 10_000, 1.01), t + 10_000);
  await desk.submitStrategyQuote(mint, quote(t + 22_000, 1.025), t + 22_000);
}

const buyFill = (req: { sizeUsd?: number; markPriceUsd?: number }) => {
  const mark = req.markPriceUsd ?? 1;
  return { signature: "sig-buy", fillPriceUsd: mark * 1.005, qty: (req.sizeUsd ?? 5) / (mark * 1.005), notionalUsd: req.sizeUsd ?? 5, feeUsd: 0.01, slippage: 0.005 };
};

const sells = () => liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell");

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number; markPriceUsd?: number }) =>
    req.side === "buy" ? buyFill(req) : { signature: "sig-sell", fillPriceUsd: req.markPriceUsd ?? 1, qty: req.qty ?? 0, notionalUsd: req.qty ?? 0, feeUsd: 0.01, slippage: 0.02 }
  );
});

describe("v13.56 dead live positions are not exited automatically", () => {
  it("makes no automatic exit attempt across many review passes", async () => {
    const desk = liveDesk();
    try {
      const mint = "DeadExit11111111111111111111111111111111";
      await fill(desk, mint, "DACITY");
      expect(sells()).toHaveLength(0);
      desk.liveBook!.mark(mint, 1e-18, Date.now() - 45_000);
      for (let i = 0; i < 30; i += 1) {
        desk.strategyPass();
        const pos = desk.liveBook!.positions.get(mint)!;
        desk.bus.emit("market.tick", { mint, priceUsd: 1e-18, liquidityUsd: 180_000, at: Date.now() - 45_000, feed: pos.priceFeed ?? "test" } as never);
      }
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(sells()).toHaveLength(0);
      expect(desk.liveBook!.positions.has(mint)).toBe(true);
      const closed = await desk.closePosition(mint, 1, "live", { sellAnyway: true });
      expect(closed.ok).toBe(true);
      expect(sells()).toHaveLength(1);
      expect(sells()[0]?.[0].sellAnyway).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("does not retry a failed live exit on the next passes", async () => {
    const desk = liveDesk();
    liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; markPriceUsd?: number; qty?: number }) => {
      if (req.side === "sell") throw new Error("LIVE_SWAP_FAILED: quote timed out");
      return buyFill(req);
    });
    try {
      const mint = "RetryGap111111111111111111111111111111111";
      await fill(desk, mint, "JEV");
      const pos = desk.liveBook!.positions.get(mint)!;
      const feed = pos.priceFeed ?? "test";
      const mark = (pos.entryMark ?? pos.entryPrice) * 0.98;
      desk.bus.emit("market.tick", { mint, priceUsd: mark, liquidityUsd: 180_000, at: Date.now(), feed } as never);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(sells()).toHaveLength(1);
      expect(desk.liveBook!.positions.has(mint)).toBe(true);
      for (let i = 0; i < 20; i += 1) desk.strategyPass();
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(sells()).toHaveLength(1);
    } finally {
      desk.stop();
    }
  });
});
