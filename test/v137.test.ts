import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { DeskStore } from "../src/store/db.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));

const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });

function armedDesk(dir?: string, balances: () => Promise<WalletBalances> = rich): Desk {
  const key = Keypair.generate();
  const secret = JSON.stringify(Array.from(key.secretKey));
  const cfg = testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret });
  if (dir) {
    cfg.dbPath = path.join(dir, "desk.sqlite");
    cfg.jsonlPath = path.join(dir, "desk.jsonl");
    cfg.logPath = path.join(dir, "desk.log");
    cfg.advisorPath = path.join(dir, "advisor.json");
    cfg.resetPaper = false;
  }
  return new Desk(cfg, { walletBalances: balances });
}

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number; markPriceUsd?: number }) =>
    req.side === "buy"
      ? { signature: "sig-buy", fillPriceUsd: 1.0, qty: req.sizeUsd ?? 0, notionalUsd: req.sizeUsd ?? 0, feeUsd: 0.01, slippage: 0 }
      : { signature: "sig-sell", fillPriceUsd: 0.9, qty: req.qty ?? 0, notionalUsd: (req.qty ?? 0) * 0.9, feeUsd: 0.01, slippage: 0.01 }
  );
});

describe("v13.7 live: manual only · AI: paper", () => {
  it("holds the same coin in both books: the AI's paper position and Dirk's live one, each with its own stop", async () => {
    const desk = armedDesk();
    try {
      expect(desk.snapshot().prefs.autoBuy).toBe(true);
      const m = "BothBooks111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "BOTH", priceUsd: 1, liquidityUsd: 180_000 }));
      expect(desk.book.positions.has(m)).toBe(true); // AI bought on paper
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      desk.setOperatorReady(true);
      const bought = await desk.manualBuy(m, 25, { book: "live" });
      expect(bought).toMatchObject({ ok: true, mode: "live", sizeUsd: 5 });
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      expect(desk.liveBook!.positions.get(m)).toMatchObject({ live: true, costUsd: 5, entry: "manual" });
      const snap = desk.snapshot();
      expect(snap.positions.map((p) => p.mint)).toEqual([m]);
      expect(snap.positions[0]?.book).toBeUndefined();
      expect(snap.liveBook?.positions.map((p) => [p.mint, p.book])).toEqual([[m, "live"]]);
      expect(snap.liveBook).toMatchObject({ scope: "manual", tradeUsd: 5 });
      const delta = desk.marksDelta();
      expect(delta.positions).toHaveLength(1);
      expect(delta.live?.positions[0]).toMatchObject({ mint: m, book: "live" });

      // −7% on the shared feed: both hard stops fire, the paper one on paper and the live one through the broker.
      await desk.markPrice(m, 0.93);
      await desk.markPrice(m, 0.93);
      expect(desk.book.positions.has(m)).toBe(false);
      expect(desk.liveBook!.positions.has(m)).toBe(false);
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((c) => c[0].side === "sell");
      expect(sells).toHaveLength(1);
      const closed = desk.snapshot().closed.filter((t) => t.mint === m);
      expect(closed.map((t) => t.mode).sort()).toEqual(["live", "paper"]);
    } finally {
      desk.stop();
    }
  });

  it("can still paper-buy by hand when the client asks for the paper book", async () => {
    const desk = armedDesk();
    try {
      desk.updateSettings({ autoBuy: false });
      const m = "PaperHand11111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "PH", priceUsd: 1, liquidityUsd: 180_000 }));
      const out = await desk.manualBuy(m, 20, { book: "paper" });
      expect(out).toMatchObject({ ok: true, mode: "paper" });
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(desk.book.positions.has(m)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("a paper desk refuses a live buy (nothing is sent)", async () => {
    const desk = new Desk(testConfig());
    try {
      desk.updateSettings({ autoBuy: false });
      const m = "NotArmed111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "NA", priceUsd: 1, liquidityUsd: 180_000 }));
      expect(await desk.manualBuy(m, 5, { book: "live" })).toMatchObject({ ok: false, code: "LIVE_NOT_ARMED" });
      expect(desk.snapshot().liveBook ?? null).toBeNull();
      expect(desk.snapshot().liveScope ?? null).toBeNull();
      expect((await desk.manualBuy(m, 5)).ok).toBe(true); // default stays paper
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
    } finally {
      desk.stop();
    }
  });

  it("saves the live book apart, restores it after a restart, and a paper reset never touches it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "night-desk-v137-"));
    const m = "Restore1111111111111111111111111111111111";
    const first = armedDesk(dir);
    try {
      first.updateSettings({ autoBuy: false });
      await first.submitCandidate(makeToken({ mint: m, symbol: "RST", priceUsd: 1, liquidityUsd: 180_000 }));
      first.setOperatorReady(true);
      expect((await first.manualBuy(m, undefined, { book: "live" })).ok).toBe(true);
    } finally {
      first.stop();
    }
    const again = armedDesk(dir);
    try {
      expect(again.liveBook!.positions.get(m)).toMatchObject({ live: true, costUsd: 5 });
      expect(again.book.positions.has(m)).toBe(false);
      const reset = again.resetPaperBook(true);
      expect(reset.ok).toBe(true);
      expect(again.liveBook!.positions.has(m)).toBe(true);
      expect(again.snapshot().prefs.autoBuy).toBe(false);
    } finally {
      again.stop();
    }
  });

  it("liveAutoBuy true is refused and leaves every other setting alone", () => {
    const desk = armedDesk();
    try {
      desk.updateSettings({ liveTradeUsd: 5, liveTrailPct: 5, liveDailyCapUsd: "", autoBuy: true });
      const before = desk.snapshot().prefs;
      expect(before.liveAutoBuy).toBe(false);
      expect(desk.updateSettings({ liveAutoBuy: "yes" }).ok).toBe(false);
      const on = desk.updateSettings({ liveAutoBuy: true });
      expect(on.ok).toBe(false);
      const after = desk.snapshot().prefs;
      expect(after).toEqual(before);
      expect(after.liveAutoBuy).toBe(false);
      expect(after.liveTrailPct).toBe(0.05);
      expect(after.liveTradeUsd).toBe(5);
      expect(after.liveDailyCapUsd).toBeNull();
      expect(desk.snapshot().liveScope).toBe("manual");
    } finally {
      desk.stop();
    }
  });

  it("a saved liveAutoBuy true is ignored on restart and does not move the AI onto the live book", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "desk-ai-paper-"));
    const first = armedDesk(dir);
    first.stop();
    const store = new DeskStore(path.join(dir, "desk.sqlite"), path.join(dir, "desk.jsonl"), path.join(dir, "desk.log"));
    const saved = store.readJson("settings");
    const prior = saved && typeof saved === "object" ? saved : {};
    store.writeJson("settings", { ...prior, liveAutoBuy: true, autoBuy: true });
    store.close();
    const desk = armedDesk(dir);
    try {
      expect(desk.snapshot().prefs.liveAutoBuy).toBe(false);
      expect(desk.snapshot().liveScope).toBe("manual");
      const m = "SavedFlag111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "FLAG", priceUsd: 1, liquidityUsd: 180_000 }));
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(desk.book.positions.has(m)).toBe(true);
      expect(desk.liveBook!.positions.size).toBe(0);
    } finally {
      desk.stop();
    }
  });
});
