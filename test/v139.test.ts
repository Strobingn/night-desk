import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";
import { liveHolding, liveTapBlock, liveTapUsd } from "../web/src/onetap.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));
const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number }) =>
    req.side === "buy"
      ? { signature: "sig-buy", fillPriceUsd: 1.0, qty: req.sizeUsd ?? 0, notionalUsd: req.sizeUsd ?? 0, feeUsd: 0.01, slippage: 0 }
      : { signature: "sig-sell", fillPriceUsd: 1.02, qty: req.qty ?? 0, notionalUsd: (req.qty ?? 0) * 1.02, feeUsd: 0.01, slippage: 0.01 }
  );
});

// A 44-char base58 public address in WALLET_PRIVATE_KEY (what Austin has now). Never a secret.
const ADDRESS_ONLY = Keypair.generate().publicKey.toBase58();

describe("v13.9 LIVE BUY / LIVE SELL beside a paper position", () => {
  it("unarmed desk (address in the key slot): live buy refused in plain words, nothing sent, no paper fallback", async () => {
    const desk = new Desk(testConfig({ mode: "paper", liveRequested: true, readWalletSecret: () => ADDRESS_ONLY }), { walletBalances: rich });
    try {
      desk.updateSettings({ autoBuy: false });
      const m = "PaperOnly1111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "PO", priceUsd: 1, liquidityUsd: 180_000 }));
      await desk.manualBuy(m, 50, { book: "paper" });
      const paperCash = desk.book.cashUsd;
      const paperQty = desk.book.positions.get(m)!.qty;
      const res = await desk.manualBuy(m, 5, { book: "live" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("LIVE_NOT_ARMED");
        expect(res.error).toMatch(/^Live not armed: wallet key missing/);
        expect(res.error).toMatch(/Nothing was sent, and no paper trade was placed instead\.$/);
      }
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(desk.book.cashUsd).toBe(paperCash);
      expect(desk.book.positions.get(m)!.qty).toBe(paperQty);
      const sell = await desk.closePosition(m, 1, "live");
      expect(sell.ok).toBe(false);
      if (!sell.ok) expect(sell.error).toMatch(/^No live position to sell\. Live not armed: wallet key missing/);
      expect(desk.book.positions.has(m)).toBe(true); // the paper position is untouched
      const snap = desk.snapshot();
      expect(snap.liveBook).toBeNull();
      expect(snap.liveNotArmed).toMatch(/^Live not armed: wallet key missing/);
      expect(snap.liveNotArmed).not.toContain(ADDRESS_ONLY);
    } finally {
      desk.stop();
    }
  });

  it("armed desk: LIVE BUY goes to the live book at the live size while the AI's paper position stays; LIVE SELL closes 100% live only", async () => {
    const key = Keypair.generate();
    const secret = JSON.stringify(Array.from(key.secretKey));
    const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: rich });
    try {
      const m = "SideBySide11111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "SBS", priceUsd: 1, liquidityUsd: 180_000 }));
      expect(desk.book.positions.has(m)).toBe(true); // AI paper position
      const paper = { ...desk.book.positions.get(m)! };
      expect(desk.snapshot().liveNotArmed).toBeNull();
      desk.setOperatorReady(true);
      const bought = await desk.manualBuy(m, 5, { book: "live" });
      expect(bought).toMatchObject({ ok: true, mode: "live", sizeUsd: 5 });
      expect(desk.liveBook!.positions.get(m)).toMatchObject({ costUsd: 5, entry: "manual" });
      expect(desk.book.positions.get(m)!.qty).toBe(paper.qty);
      const snap = desk.snapshot();
      expect(liveHolding(snap, m)).toMatchObject({ mint: m, book: "live" });
      expect(snap.positions.find((p) => p.mint === m)?.costUsd).toBe(paper.costUsd);
      // The pricer is asked to mark both books' coins (instant on-chain push covers live holdings too).
      expect(desk.marksDelta().live?.positions.map((p) => p.mint)).toEqual([m]);
      const sold = await desk.closePosition(m, 1, "live");
      expect(sold.ok).toBe(true);
      expect(desk.liveBook!.positions.has(m)).toBe(false);
      expect(desk.book.positions.has(m)).toBe(true);
      expect(liveBroker.executeLiveSwap.mock.calls.map((c) => c[0].side)).toEqual(["buy", "sell"]);
    } finally {
      desk.stop();
    }
  });

  it("client helpers: live size defaults to $5, unarmed message, holding lookup", () => {
    expect(liveTapUsd(null)).toBe(5);
    expect(liveTapUsd({ liveBook: null, prefs: { liveTradeUsd: 7 } } as never)).toBe(7);
    expect(liveTapUsd({ liveBook: { tradeUsd: 5 }, prefs: { liveTradeUsd: 9 } } as never)).toBe(5);
    expect(liveTapBlock({ liveBook: null, liveNotArmed: "Live not armed: wallet key missing." } as never)).toBe("Live not armed: wallet key missing. Nothing was sent.");
    expect(liveTapBlock({ liveBook: null, wallet: { keyLoaded: false } } as never)).toBe("Live not armed: wallet key missing. Nothing was sent.");
    expect(liveTapBlock({ liveBook: { positions: [] } } as never)).toBeNull();
    expect(liveHolding({ liveBook: null } as never, "x")).toBeNull();
    expect(liveHolding({ liveBook: { positions: [{ mint: "x", qty: 2 }] } } as never, "x")).toMatchObject({ qty: 2 });
  });
});
