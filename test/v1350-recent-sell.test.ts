import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { resolveSellAtoms } from "../src/market/live-broker.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", async () => {
  const actual = await vi.importActual<typeof import("../src/market/live-broker.js")>("../src/market/live-broker.js");
  return { ...actual, executeLiveSwap: liveBroker.executeLiveSwap };
});

function liveDesk(balances: () => Promise<WalletBalances>): Desk {
  const secret = JSON.stringify([...Keypair.generate().secretKey]);
  const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: balances });
  desk.setOperatorReady(true);
  return desk;
}

const mint = "Dacity111111111111111111111111111111111111";

async function fill(desk: Desk): Promise<void> {
  desk.updateSettings({ autoBuy: false, liveDailyCapUsd: 20 });
  await desk.submitCandidate(makeToken({ mint, symbol: "DACITY", priceUsd: 1, liquidityUsd: 180_000 }));
  const bought = await desk.manualBuy(mint, 5, { book: "live" });
  expect(bought.ok).toBe(true);
}

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number; maxExitSlippage?: number }) =>
    req.side === "buy"
      ? { signature: "sig-buy", fillPriceUsd: 1.01, qty: (req.sizeUsd ?? 5) / 1.01, notionalUsd: req.sizeUsd ?? 5, feeUsd: 0.01, slippage: 0.01 }
      : { signature: "sig-sell", fillPriceUsd: 1, qty: req.qty ?? 0, notionalUsd: req.qty ?? 0, feeUsd: 0.01, slippage: 0.02 }
  );
});

describe("v13.50 a live sell just after a fill", () => {
  it("sends the confirmed amount when the wallet read errors within 30s", async () => {
    let calls = 0;
    const desk = liveDesk(async () => {
      calls += 1;
      if (calls === 1) return { sol: 0.5, usdc: 100, at: Date.now(), error: null };
      return { sol: null, usdc: null, at: Date.now(), error: "RPC HTTP 429" };
    });
    try {
      await fill(desk);
      const pos = desk.liveBook!.positions.get(mint)!;
      pos.openedAt = Date.now() - 29_000;
      const started = Date.now();
      const closed = await desk.closePosition(mint, 1, "live");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(closed.ok).toBe(true);
      const sell = liveBroker.executeLiveSwap.mock.calls.map((call) => call[0]).find((req) => req.side === "sell");
      expect(sell?.qty).toBeCloseTo(pos.qty, 8);
      expect(sell?.confirmedFill).toBe(true);
      expect(sell?.maxExitSlippage).toBeCloseTo(0.06, 6);
    } finally {
      desk.stop();
    }
  });

  it("does not wait out a hung balance read in the first seconds after the fill", async () => {
    let calls = 0;
    const desk = liveDesk(async () => {
      calls += 1;
      if (calls === 1) return { sol: 0.5, usdc: 100, at: Date.now(), error: null };
      return new Promise<WalletBalances>(() => undefined);
    });
    try {
      await fill(desk);
      const started = Date.now();
      const closed = await desk.closePosition(mint, 1, "live");
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(700);
      expect(elapsed).toBeLessThan(1_500);
      expect(closed.ok).toBe(true);
      expect(liveBroker.executeLiveSwap.mock.calls.some((call) => call[0].side === "sell" && call[0].confirmedFill === true)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("still refuses a sell once the fill is older than 30s and the balance read failed", async () => {
    let calls = 0;
    const desk = liveDesk(async () => {
      calls += 1;
      if (calls === 1) return { sol: 0.5, usdc: 100, at: Date.now(), error: null };
      return { sol: null, usdc: null, at: Date.now(), error: "RPC HTTP 429" };
    });
    try {
      await fill(desk);
      desk.liveBook!.positions.get(mint)!.openedAt = Date.now() - 31_000;
      const closed = await desk.closePosition(mint, 1, "live");
      expect(closed.ok).toBe(false);
      if (!closed.ok) expect(closed.error).toMatch(/Wallet balance not current/);
      expect(liveBroker.executeLiveSwap.mock.calls.some((call) => call[0].side === "sell")).toBe(false);
    } finally {
      desk.stop();
    }
  }, 10_000);
});

describe("resolveSellAtoms", () => {
  it("keeps the booked fill when the token account is empty or unread, and caps a real balance", () => {
    expect(resolveSellAtoms(1_000, 0, true)).toBe(1_000);
    expect(resolveSellAtoms(1_000, null, true)).toBe(1_000);
    expect(resolveSellAtoms(1_000, 400, true)).toBe(400);
    expect(resolveSellAtoms(1_000, 5_000, true)).toBe(1_000);
    expect(resolveSellAtoms(1_000, 0, false)).toBeNull();
    expect(resolveSellAtoms(1_000, null, false)).toBeNull();
    expect(resolveSellAtoms(1_000, 400, false)).toBe(400);
  });
});
