import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { LiveSubmitError, QUOTE_TIMEOUT_MS, SWAP_TIMEOUT_MS, CONFIRM_TIMEOUT_MS, isAmbiguousSendError, preSendFailure, unconfirmedSend } from "../src/market/live-submit.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));

const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });
const MINT = "TimeoutMint111111111111111111111111111111111";

function armed(dir?: string, signatureStatus?: (signature: string) => Promise<"confirmed" | "failed" | "unknown">): Desk {
  const key = Keypair.generate();
  const cfg = testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => JSON.stringify(Array.from(key.secretKey)) });
  if (dir) {
    cfg.dbPath = path.join(dir, "desk.sqlite");
    cfg.jsonlPath = path.join(dir, "desk.jsonl");
    cfg.logPath = path.join(dir, "desk.log");
    cfg.resetPaper = false;
  }
  const desk = new Desk(cfg, { walletBalances: rich, signatureStatus });
  desk.updateSettings({ autoBuy: false });
  desk.setOperatorReady(true);
  return desk;
}

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
});

describe("live submit timeouts", () => {
  it("names the budgets and treats quote/swap failures as not submitted", () => {
    expect(QUOTE_TIMEOUT_MS).toBe(8_000);
    expect(SWAP_TIMEOUT_MS).toBe(8_000);
    expect(CONFIRM_TIMEOUT_MS).toBe(20_000);
    expect(QUOTE_TIMEOUT_MS + SWAP_TIMEOUT_MS).toBeGreaterThan(12_000);
    const quote = preSendFailure("quote", 429);
    const slow = preSendFailure("swap", "timeout");
    expect(quote).toMatchObject({ code: "LIVE_NOT_SUBMITTED", submitState: "not_submitted", signature: null });
    expect(quote.message).toMatch(/HTTP 429/);
    expect(quote.message).toMatch(/Nothing was sent/);
    expect(slow.message).toMatch(/timed out after 8s/);
    expect(isAmbiguousSendError(new Error("confirmation timed out"))).toBe(true);
    expect(isAmbiguousSendError(new Error("Transaction simulation failed"))).toBe(false);
    expect(unconfirmedSend("sig-1", "buy").message).toContain("sig-1");
  });

  it("keeps an unknown signature and does not send a second buy, then sends once the chain says it failed", async () => {
    let status: "confirmed" | "failed" | "unknown" = "unknown";
    const desk = armed(undefined, async () => status);
    liveBroker.executeLiveSwap.mockRejectedValueOnce(unconfirmedSend("sig-timeout", "buy"));
    try {
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "SLOW", priceUsd: 1, liquidityUsd: 180_000 }));
      const first = await desk.manualBuy(MINT, 5, { book: "live" });
      expect(first).toMatchObject({ ok: false, code: "LIVE_UNCONFIRMED", signature: "sig-timeout", submitState: "submitted_unknown" });
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      const again = await desk.manualBuy(MINT, 5, { book: "live" });
      expect(again).toMatchObject({ ok: false, code: "LIVE_UNCONFIRMED", signature: "sig-timeout" });
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      expect(desk.liveBook!.positions.size).toBe(0);
      expect(desk.book.positions.size).toBe(0);

      status = "failed";
      liveBroker.executeLiveSwap.mockResolvedValueOnce({
        signature: "sig-next",
        fillPriceUsd: 1,
        qty: 5,
        notionalUsd: 5,
        feeUsd: 0.01,
        slippage: 0.01
      });
      const third = await desk.manualBuy(MINT, 5, { book: "live" });
      expect(third).toMatchObject({ ok: true, mode: "live", sizeUsd: 5 });
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(2);
    } finally {
      desk.stop();
    }
  });

  it("a quote rejection is not submitted, so a later live buy may send", async () => {
    const desk = armed();
    liveBroker.executeLiveSwap
      .mockRejectedValueOnce(preSendFailure("quote", 429))
      .mockResolvedValueOnce({ signature: "sig-ok", fillPriceUsd: 1, qty: 5, notionalUsd: 5, feeUsd: 0.01, slippage: 0.01 });
    try {
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "SLOW", priceUsd: 1, liquidityUsd: 180_000 }));
      const first = await desk.manualBuy(MINT, 5, { book: "live" });
      expect(first).toMatchObject({ ok: false, code: "LIVE_NOT_SUBMITTED", submitState: "not_submitted" });
      const second = await desk.manualBuy(MINT, 5, { book: "live" });
      expect(second).toMatchObject({ ok: true, mode: "live" });
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(2);
    } finally {
      desk.stop();
    }
  });

  it("remembers an unknown signature across a restart and still does not send", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "night-desk-unconfirmed-"));
    const first = armed(dir);
    liveBroker.executeLiveSwap.mockRejectedValueOnce(new LiveSubmitError("send hung", "submitted_unknown", null));
    try {
      await first.submitCandidate(makeToken({ mint: MINT, symbol: "SLOW", priceUsd: 1, liquidityUsd: 180_000 }));
      const out = await first.manualBuy(MINT, 5, { book: "live" });
      expect(out).toMatchObject({ ok: false, code: "LIVE_UNCONFIRMED", submitState: "submitted_unknown" });
    } finally {
      first.stop();
    }
    const again = armed(dir, async () => "unknown");
    try {
      await again.submitCandidate(makeToken({ mint: MINT, symbol: "SLOW", priceUsd: 1, liquidityUsd: 180_000 }));
      const blocked = await again.manualBuy(MINT, 5, { book: "live" });
      expect(blocked).toMatchObject({ ok: false, code: "LIVE_UNCONFIRMED" });
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      expect(again.liveBook!.positions.size).toBe(0);
    } finally {
      again.stop();
    }
  });
});
