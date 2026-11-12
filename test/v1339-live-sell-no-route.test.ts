import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { quoteUsdFromDexPair } from "../src/market/dex-prices.js";
import { quoteSideDrained, residualExitUsd, residualMarkPrice } from "../src/market/mark-guard.js";
import {
  NO_SELL_ROUTE_MESSAGE,
  SELL_PRE_SEND_MS,
  isNoRoutesBody,
  isNoSellRouteMessage,
  noSellRouteError
} from "../src/market/live-submit.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));

const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });
const MINT = "InsaneMint111111111111111111111111111111111";

function armed(): Desk {
  const key = Keypair.generate();
  const dir = mkdtempSync(path.join(tmpdir(), "v1339-"));
  const cfg = testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => JSON.stringify(Array.from(key.secretKey)) });
  cfg.dbPath = path.join(dir, "desk.sqlite");
  cfg.jsonlPath = path.join(dir, "desk.jsonl");
  cfg.logPath = path.join(dir, "desk.log");
  cfg.resetPaper = false;
  const desk = new Desk(cfg, { walletBalances: rich });
  desk.updateSettings({ autoBuy: false });
  desk.setOperatorReady(true);
  return desk;
}

const fill = {
  signature: "sig-live-buy",
  fillPriceUsd: 0.00001,
  qty: 500_000,
  notionalUsd: 5,
  feeUsd: 0.01,
  slippage: 0.01
};

const sellFill = {
  signature: "sig-live-sell",
  fillPriceUsd: 0.00001,
  qty: 500_000,
  notionalUsd: 0.4,
  feeUsd: 0.01,
  slippage: 0.05
};

let allowSell = false;

function stubBroker(): void {
  allowSell = false;
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: "buy" | "sell" }) => {
    if (req.side === "buy") return fill;
    if (allowSell) return sellFill;
    throw noSellRouteError();
  });
}

async function openLive(desk: Desk): Promise<void> {
  await desk.submitCandidate(makeToken({ mint: MINT, symbol: "INSANE", priceUsd: 0.00001, liquidityUsd: 9_000 }));
  const bought = await desk.manualBuy(MINT, 5, { book: "live" });
  expect(bought).toMatchObject({ ok: true, mode: "live" });
  expect(desk.liveBook?.positions.get(MINT)?.qty).toBeGreaterThan(0);
}

beforeEach(() => {
  stubBroker();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("v13.39 live sell no-route and drained quote side", () => {
  it("names the sell pre-send cap and parses Jupiter NO_ROUTES_FOUND", () => {
    expect(SELL_PRE_SEND_MS).toBe(4_000);
    expect(SELL_PRE_SEND_MS).toBeLessThan(5_000);
    expect(isNoRoutesBody(400, { error: "No routes found", errorCode: "NO_ROUTES_FOUND" })).toBe(true);
    expect(isNoRoutesBody(400, { errorCode: "NO_ROUTES_FOUND" })).toBe(true);
    expect(isNoRoutesBody(400, { error: "rate limited" })).toBe(false);
    expect(isNoRoutesBody(500, { errorCode: "NO_ROUTES_FOUND" })).toBe(false);
    expect(isNoSellRouteMessage(NO_SELL_ROUTE_MESSAGE)).toBe(true);
    expect(noSellRouteError()).toMatchObject({ code: "LIVE_NOT_SUBMITTED", submitState: "not_submitted", signature: null });
    expect(noSellRouteError().message).toBe(NO_SELL_ROUTE_MESSAGE);
  });

  it("treats a drained quote side as residual, never the stale mid", () => {
    const quoteUsd = quoteUsdFromDexPair({
      priceUsd: 0.00001287,
      priceNative: 0.00001287 / 84.4,
      liquidity: { usd: 1.39, base: 108_000_000, quote: 1.54e-7 }
    });
    expect(quoteUsd).toBeGreaterThan(0);
    expect(quoteUsd!).toBeLessThan(0.02);
    expect(quoteSideDrained({ quoteUsd, midValueUsd: 5.86, liquidityUsd: 1.39 })).toBe(true);
    expect(quoteSideDrained({ quoteUsd: 400, midValueUsd: 5.86, liquidityUsd: 800 })).toBe(false);
    expect(residualExitUsd({ quoteUsd, midValueUsd: 5.86 })).toBe(quoteUsd);
    expect(residualMarkPrice(0, 455_575)).toBeGreaterThan(0);
    expect(residualMarkPrice(0, 455_575)).toBeLessThan(1e-12);
  });

  it("returns a clear no-route reason in under 5s and keeps the live position open", async () => {
    const desk = armed();
    await openLive(desk);
    const started = Date.now();
    const closed = await desk.closePosition(MINT, 1, "live");
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    expect(closed.ok).toBe(false);
    if (closed.ok) throw new Error("expected a refusal");
    expect(closed.error).toBe(NO_SELL_ROUTE_MESSAGE);
    expect(closed.error).toMatch(/Liquidity gone, no sell route/);
    expect(closed.error).not.toMatch(/timeout/i);
    expect(desk.liveBook?.positions.has(MINT)).toBe(true);
    const view = desk.snapshot().liveBook?.positions.find((p) => p.mint === MINT);
    expect(view?.liquidityNote).toBe("Liquidity gone, no sell route");
    expect(view?.marketValueUsd ?? 1).toBeLessThan(0.05);
  });

  it("does not book a stale Dex mid as sellable value when the quote side is drained", async () => {
    const desk = armed();
    await openLive(desk);
    const cash = desk.snapshot().liveBook!.cashUsd;
    desk.bus.emit("market.tick", {
      mint: MINT,
      priceUsd: 0.00001287,
      at: Date.now(),
      feed: "dexscreener",
      liquidityUsd: 1.39,
      quoteUsd: 0.000013
    });

    const snap = desk.snapshot();
    const pos = snap.liveBook?.positions.find((p) => p.mint === MINT);
    expect(pos).toBeTruthy();
    expect(pos!.liquidityNote).toBe("Liquidity gone, no sell route");
    expect(pos!.marketValueUsd).toBeLessThan(0.05);
    expect(pos!.markPrice * pos!.qty).toBeLessThan(0.05);
    // A $5.86 mid must not inflate live equity above cash + residual.
    expect(snap.liveBook!.equityUsd).toBeLessThan(cash + 0.05);
    expect(desk.liveBook?.positions.has(MINT)).toBe(true);
  });

  it("still applies a real crash when quote-side liquidity is present", async () => {
    const desk = armed();
    await openLive(desk);
    desk.bus.emit("market.tick", {
      mint: MINT,
      priceUsd: 0.0000097,
      at: Date.now(),
      feed: "dexscreener",
      liquidityUsd: 4_000,
      quoteUsd: 1_800
    });
    const pos = desk.snapshot().liveBook?.positions.find((p) => p.mint === MINT);
    expect(pos?.liquidityNote ?? null).toBeFalsy();
    expect(pos?.markPrice).toBeCloseTo(0.0000097, 8);
    expect((pos?.marketValueUsd ?? 0) > 1).toBe(true);
  });

  it("ignores a drained tick from a different pool", async () => {
    const desk = armed();
    await openLive(desk);
    const held = desk.liveBook!.positions.get(MINT)!;
    held.priceFeed = "dexscreener";
    held.pairAddress = "HealthyPool111111111111111111111111111111";
    const before = desk.snapshot().liveBook!.positions.find((p) => p.mint === MINT)!.markPrice;
    desk.bus.emit("market.tick", {
      mint: MINT,
      priceUsd: 0.00001287,
      at: Date.now(),
      feed: "dexscreener",
      pairAddress: "OtherPool111111111111111111111111111111111",
      liquidityUsd: 1.39,
      quoteUsd: 0.000013
    });
    const pos = desk.snapshot().liveBook?.positions.find((p) => p.mint === MINT);
    expect(pos?.liquidityNote ?? null).toBeFalsy();
    expect(pos?.markPrice).toBeCloseTo(before, 10);
    expect(desk.liveBook?.positions.has(MINT)).toBe(true);
  });

  it("restores a real price when the anchored pool's quote side returns", async () => {
    const desk = armed();
    await openLive(desk);
    const held = desk.liveBook!.positions.get(MINT)!;
    held.priceFeed = "dexscreener";
    held.pairAddress = "HealthyPool111111111111111111111111111111";
    desk.bus.emit("market.tick", {
      mint: MINT,
      priceUsd: 0.00001287,
      at: Date.now(),
      feed: "dexscreener",
      pairAddress: held.pairAddress,
      liquidityUsd: 1.39,
      quoteUsd: 0.000013
    });
    expect(desk.snapshot().liveBook?.positions.find((p) => p.mint === MINT)?.liquidityNote).toBe("Liquidity gone, no sell route");

    desk.bus.emit("market.tick", {
      mint: MINT,
      priceUsd: 0.0000097,
      at: Date.now(),
      feed: "dexscreener",
      pairAddress: held.pairAddress,
      liquidityUsd: 4_000,
      quoteUsd: 1_800
    });
    const pos = desk.snapshot().liveBook?.positions.find((p) => p.mint === MINT);
    expect(pos?.liquidityNote ?? null).toBeFalsy();
    expect(pos?.markPrice).toBeCloseTo(0.0000097, 8);
    expect((pos?.marketValueUsd ?? 0) > 1).toBe(true);
  });

  it("does not treat a healthy cached quote as residual when Jupiter has no route", async () => {
    const desk = armed();
    await openLive(desk);
    desk.bus.emit("market.tick", {
      mint: MINT,
      priceUsd: 0.00001287,
      at: Date.now(),
      feed: "dexscreener",
      liquidityUsd: 8_000,
      quoteUsd: 4_000
    });
    const refused = await desk.closePosition(MINT, 1, "live");
    expect(refused.ok).toBe(false);
    const pos = desk.snapshot().liveBook?.positions.find((p) => p.mint === MINT);
    expect(pos?.liquidityNote).toBe("Liquidity gone, no sell route");
    expect(pos?.marketValueUsd ?? 1).toBeLessThan(0.05);
    expect(desk.liveBook?.positions.has(MINT)).toBe(true);
  });

  it("keeps a paper position open when the quote side is drained", async () => {
    const desk = armed();
    await desk.submitCandidate(makeToken({ mint: MINT, symbol: "INSANE", priceUsd: 0.00001, liquidityUsd: 9_000 }));
    const bought = await desk.manualBuy(MINT, 5, { book: "paper" });
    expect(bought).toMatchObject({ ok: true });
    const held = desk.book.positions.get(MINT)!;
    held.priceFeed = "dexscreener";
    held.pairAddress = "HealthyPool111111111111111111111111111111";
    desk.bus.emit("market.tick", {
      mint: MINT,
      priceUsd: 0.00001287,
      at: Date.now(),
      feed: "dexscreener",
      pairAddress: held.pairAddress,
      liquidityUsd: 1.39,
      quoteUsd: 0.000013
    });
    expect(desk.book.positions.has(MINT)).toBe(true);
    const pos = desk.snapshot().positions.find((p) => p.mint === MINT);
    expect(pos?.liquidityNote).toBe("Liquidity gone, no sell route");
    expect(pos?.marketValueUsd ?? 1).toBeLessThan(0.05);
  });

  it("retries a live sell once a route returns", async () => {
    const desk = armed();
    await openLive(desk);
    const refused = await desk.closePosition(MINT, 1, "live");
    expect(refused.ok).toBe(false);
    expect(desk.liveBook?.positions.has(MINT)).toBe(true);

    allowSell = true;
    const sold = await desk.closePosition(MINT, 1, "live");
    expect(sold).toMatchObject({ ok: true });
    expect(desk.liveBook?.positions.has(MINT)).toBe(false);
  });
});
