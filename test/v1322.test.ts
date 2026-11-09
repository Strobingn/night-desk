import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig, testDesk } from "./helpers.js";

const swaps = vi.hoisted(() => ({ executeLiveSwap: vi.fn(), executePumpLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: swaps.executeLiveSwap }));
vi.mock("../src/market/pump-live.js", async () => {
  const actual = await vi.importActual<typeof import("../src/market/pump-live.js")>("../src/market/pump-live.js");
  return { ...actual, executePumpLiveSwap: swaps.executePumpLiveSwap };
});

const MINT = "PepeMint111111111111111111111111111111111";
const PAIR = "PepePool11111111111111111111111111111111";
const ENTRY = 1.342e-5;
const POISON = 0.5319;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

beforeEach(() => {
  swaps.executeLiveSwap.mockReset();
  swaps.executePumpLiveSwap.mockReset();
  swaps.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number; markPriceUsd?: number }) =>
    req.side === "buy"
      ? { signature: "sig-buy", fillPriceUsd: ENTRY, qty: (req.sizeUsd ?? 5) / ENTRY, notionalUsd: req.sizeUsd ?? 5, feeUsd: 0.01, slippage: 0.01 }
      : { signature: "sig-sell", fillPriceUsd: req.markPriceUsd ?? ENTRY, qty: req.qty ?? 0, notionalUsd: (req.qty ?? 0) * (req.markPriceUsd ?? ENTRY), feeUsd: 0.01, slippage: 0.01 }
  );
});

function prices(dex: number, jup: number): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes("dexscreener")) {
      return Response.json([
        { baseToken: { address: MINT }, priceUsd: String(dex), liquidity: { usd: 180_000 }, pairAddress: PAIR, dexId: "pumpswap" }
      ]);
    }
    return Response.json({ [MINT]: { usdPrice: jup, liquidity: 180_000 } });
  }) as typeof fetch;
}

describe("v13.22 poisoned marks cannot fill a sell", () => {
  it("refuses a Pepetide manual close at 0.5319 and still sells a real drop", async () => {
    let dex = ENTRY;
    let jup = ENTRY;
    const desk = testDesk({}, { priceFetch: (url) => prices(dex, jup)(url) });
    try {
      await desk.submitCandidate(
        makeToken({
          mint: MINT,
          symbol: "PEPETIDE",
          priceUsd: ENTRY,
          liquidityUsd: 180_000,
          source: "pumpfun",
          priceFeed: "dexscreener",
          pairAddress: PAIR,
          dex: "pumpswap"
        })
      );
      const pos = desk.book.positions.get(MINT);
      expect(pos).toBeTruthy();
      const entry = pos!.entryPrice;
      expect(POISON / entry).toBeGreaterThanOrEqual(25);
      pos!.liquidityUsd = 25;
      desk.book.mark(MINT, POISON);
      const cash = desk.book.cashUsd;
      const refused = await desk.closePosition(MINT, 1);
      expect(refused).toMatchObject({ ok: false, error: "Price unverified - sell refused, retry" });
      expect(desk.book.positions.has(MINT)).toBe(true);
      expect(desk.book.cashUsd).toBe(cash);
      desk.snapshot();
      const retried = await desk.closePosition(MINT, 1);
      expect(retried).toMatchObject({ ok: false, error: "Price unverified - sell refused, retry" });
      expect(desk.book.positions.has(MINT)).toBe(true);
      expect(desk.book.cashUsd).toBe(cash);

      desk.book.mark(MINT, entry * 0.5);
      const sold = await desk.closePosition(MINT, 1);
      expect(sold.ok).toBe(true);
      if (sold.ok) expect(sold.proceedsUsd ?? 0).toBeLessThan(pos!.costUsd * 2);
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(desk.book.cashUsd).toBeLessThan(cash + pos!.costUsd * 2);

      await desk.submitCandidate(
        makeToken({
          mint: MINT,
          symbol: "PEPETIDE",
          priceUsd: entry,
          liquidityUsd: 180_000,
          source: "pumpfun",
          priceFeed: "dexscreener",
          pairAddress: PAIR,
          dex: "pumpswap"
        })
      );
      expect(desk.book.positions.has(MINT)).toBe(true);
      dex = entry * 0.5;
      jup = entry * 0.5;
      await desk.repricePositions();
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "STOP_LOSS" || event.code === "GAP_RUG")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("does not send a live sell against the poisoned Pepetide mark", async () => {
    const secret = base58Encode(Keypair.generate().secretKey);
    const balances = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });
    const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: balances, priceFetch: prices(ENTRY, ENTRY) });
    desk.setOperatorReady(true);
    desk.updateSettings({ autoBuy: false });
    try {
      await desk.submitCandidate(
        makeToken({
          mint: MINT,
          symbol: "PEPETIDE",
          priceUsd: ENTRY,
          liquidityUsd: 180_000,
          source: "pumpfun",
          priceFeed: "dexscreener",
          pairAddress: PAIR,
          dex: "pumpswap"
        })
      );
      const bought = await desk.manualBuy(MINT, undefined, { book: "live" });
      expect(bought.ok).toBe(true);
      const pos = desk.liveBook!.positions.get(MINT);
      expect(pos).toBeTruthy();
      expect(POISON / pos!.entryPrice).toBeGreaterThanOrEqual(25);
      pos!.liquidityUsd = 25;
      desk.liveBook!.mark(MINT, POISON);
      const sellsBefore = swaps.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell").length;
      const refused = await desk.closePosition(MINT, 1, "live");
      expect(refused).toMatchObject({ ok: false, error: "Price unverified - sell refused, retry" });
      expect(desk.liveBook!.positions.has(MINT)).toBe(true);
      expect(swaps.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell")).toHaveLength(sellsBefore);
      desk.snapshot();
      const retried = await desk.closePosition(MINT, 1, "live");
      expect(retried).toMatchObject({ ok: false, error: "Price unverified - sell refused, retry" });
      expect(desk.liveBook!.positions.has(MINT)).toBe(true);
      expect(swaps.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell")).toHaveLength(sellsBefore);
    } finally {
      desk.stop();
    }
  });
});
