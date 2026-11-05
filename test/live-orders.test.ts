import { afterEach, describe, expect, it, vi } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { DeskStore } from "../src/store/db.js";
import { testConfig, testDesk } from "./helpers.js";
import type { LiveSwapRequest } from "../src/market/live-broker.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: execute }));
afterEach(() => execute.mockReset());

const candidate = () => makeToken({ source: "raydium" });
const prepare = (req: LiveSwapRequest) => req.onPrepared?.({
  signature: "test-signature", blockhash: "test-blockhash", lastValidBlockHeight: 100, mint: req.mint, side: req.side, at: Date.now()
});
const fill = { signature: "test-signature", qty: 800_000, rawQty: "800000000000", notionalUsd: 800,
  fillPriceUsd: 0.001, feeUsd: 0, slippage: 0, networkFeeLamports: 5000 };

describe("persistent order guard", () => {
  it("survives restart and permits only one reservation across connections", () => {
    const config = testConfig();
    const first = new DeskStore(config.dbPath, ":memory:");
    const second = new DeskStore(config.dbPath, ":memory:");
    expect(first.reserveLiveOrder({ signature: "uncertain" })).toBe(true);
    expect(second.reserveLiveOrder({ signature: "duplicate" })).toBe(false);
    first.close(); second.close();
    const restarted = new DeskStore(config.dbPath, ":memory:");
    expect(restarted.pendingLiveOrder()).toEqual({ signature: "uncertain" });
    restarted.close();
  });

  it("rolls back ledger writes and retains the guard if settlement fails", () => {
    const store = new DeskStore(":memory:", ":memory:");
    store.reserveLiveOrder({ signature: "submitted" });
    expect(() => store.settleLiveOrder(() => { store.writeJson("settled", true); throw new Error("disk error"); })).toThrow();
    expect(store.readJson("settled")).toBeNull();
    expect(store.pendingLiveOrder()).toEqual({ signature: "submitted" });
    store.settleLiveOrder(() => store.writeJson("settled", true));
    expect(store.readJson("settled")).toBe(true);
    expect(store.pendingLiveOrder()).toBeNull();
    store.close();
  });

  it("serializes duplicate live candidates so only one buy reaches the broker", async () => {
    execute.mockImplementation(async (req: LiveSwapRequest) => { prepare(req); await Promise.resolve(); return fill; });
    const desk = testDesk({ mode: "live", walletKeypairPath: "/test-only" });
    try {
      await Promise.all([desk.submitCandidate(candidate()), desk.submitCandidate(candidate())]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(desk.snapshot().positions).toHaveLength(1);
      expect(desk.book.positions.values().next().value?.rawQty).toBe(fill.rawQty);
      expect(desk.store.pendingLiveOrder()).toBeNull();
    } finally { await desk.stop(); }
  });

  it("blocks all further live orders after ambiguous submission, including after restart", async () => {
    execute.mockImplementation(async (req: LiveSwapRequest) => { prepare(req); throw new Error("submission timed out"); });
    const config = testConfig({ mode: "live", walletKeypairPath: "/test-only", resetPaper: false });
    const first = new Desk(config);
    await first.submitCandidate(candidate());
    await first.submitCandidate(candidate());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.store.pendingLiveOrder()).toMatchObject({ signature: "test-signature" });
    expect(first.snapshot().positions).toHaveLength(0);
    expect(first.snapshot().armError).toMatch(/unresolved order/);
    await first.stop();
    const second = new Desk({ ...config });
    try {
      await second.submitCandidate(candidate());
      expect(execute).toHaveBeenCalledTimes(1);
      expect(second.store.pendingLiveOrder()).toMatchObject({ signature: "test-signature" });
    } finally { await second.stop(); }
  });

  it("releases an order that definitively failed on-chain without booking a fill", async () => {
    execute.mockImplementation(async (req: LiveSwapRequest) => { prepare(req); throw Object.assign(new Error("on-chain error"), { outcome: "failed" }); });
    const desk = testDesk({ mode: "live", walletKeypairPath: "/test-only" });
    try {
      await desk.submitCandidate(candidate());
      expect(desk.store.pendingLiveOrder()).toBeNull();
      expect(desk.snapshot().positions).toHaveLength(0);
      expect(desk.snapshot().cashUsd).toBe(10000);
    } finally { await desk.stop(); }
  });

  it("never sends replay candidates to the live broker", async () => {
    const desk = testDesk({ mode: "live", walletKeypairPath: "/test-only" });
    try {
      await desk.submitCandidate(makeToken());
      expect(execute).not.toHaveBeenCalled();
      expect(desk.snapshot().positions).toHaveLength(0);
    } finally { await desk.stop(); }
  });

  it("never calls the live broker from a normal paper candidate", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(candidate());
      expect(execute).not.toHaveBeenCalled();
      expect(desk.snapshot().positions).toHaveLength(1);
    } finally { await desk.stop(); }
  });
});

describe("paper/live ledger isolation", () => {
  it("keeps balances, positions and equity separate across mode changes", async () => {
    const config = testConfig({ resetPaper: false });
    const paper = new Desk(config);
    await paper.submitCandidate(makeToken());
    const cash = paper.snapshot().cashUsd;
    await paper.stop();
    const live = new Desk({ ...config, mode: "live" });
    expect(live.snapshot().positions).toHaveLength(0);
    expect(live.snapshot().cashUsd).toBe(10000);
    expect(live.snapshot().equity).toHaveLength(0);
    await live.stop();
    const resumed = new Desk(config);
    expect(resumed.snapshot().positions).toHaveLength(1);
    expect(resumed.snapshot().cashUsd).toBe(cash);
    await resumed.stop();
  });

  it("restores a legacy paper book without importing it into live mode", () => {
    const store = new DeskStore(":memory:", ":memory:");
    store.writeJson("book", { cashUsd: 75, startingBalanceUsd: 100, startedAt: 0, positions: [], cooldowns: [] });
    expect(store.loadBook("paper")?.cashUsd).toBe(75);
    expect(store.loadBook("live")).toBeNull();
    store.close();
  });
});
