import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { DEAD_MARKS, deadFromMarks, noteCollapsedSample, readSellRoute } from "../src/market/dead-holding.js";
import type { Priority } from "../src/market/net.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
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
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number }) =>
    req.side === "buy"
      ? { signature: "sig-buy", fillPriceUsd: 1.01, qty: (req.sizeUsd ?? 5) / 1.01, notionalUsd: req.sizeUsd ?? 5, feeUsd: 0.01, slippage: 0.01 }
      : { signature: "sig-sell", fillPriceUsd: 1, qty: req.qty ?? 0, notionalUsd: req.qty ?? 0, feeUsd: 0.01, slippage: 0.01 }
  );
});

describe("v13.51 dead card without a sell", () => {
  it("classifies a collapsed mark from value or from several prints, and ignores one wick", () => {
    expect(deadFromMarks({ entryPrice: 1, qty: 5_000_000, markPrice: 1e-18, marks: [1e-18] })).toBe("value");
    expect(deadFromMarks({ entryPrice: 1, qty: 0.001, markPrice: 1, marks: [1, 1, 1] })).toBeNull();
    const low = 0.005;
    expect(deadFromMarks({ entryPrice: 1, qty: 100, markPrice: low, marks: [low] })).toBeNull();
    expect(deadFromMarks({ entryPrice: 1, qty: 100, markPrice: low, marks: Array(DEAD_MARKS).fill(low) })).toBe("drop");
    let streak = noteCollapsedSample(undefined, true, 1_000);
    expect(streak?.n).toBe(1);
    streak = noteCollapsedSample(streak, true, 1_000 + 1_499);
    expect(streak?.n).toBe(1);
    streak = noteCollapsedSample(streak, true, 1_000 + 1_500);
    expect(streak?.n).toBe(2);
    streak = noteCollapsedSample(streak, true, 1_000 + 3_000);
    expect(streak?.n).toBe(3);
    expect(noteCollapsedSample(streak, false, 9_000)).toBeUndefined();
  });

  it("moves a live dust mark into the dead note without a sell, a stop change, or a ledger write", async () => {
    const desk = liveDesk();
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      expect((await desk.manualBuy(mint, 5, { book: "live" })).ok).toBe(true);
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell").length;
      const pos = desk.liveBook!.positions.get(mint)!;
      const cash = desk.liveBook!.cashUsd;
      const peak = pos.peakPrice;
      const trail = pos.trailArmed;
      const stopPct = desk.snapshot().rules.stopLossPct;
      const events = desk.snapshot().events.length;
      desk.liveBook!.mark(mint, 1e-18);
      const view = desk.snapshot().liveBook?.positions.find((row) => row.mint === mint);
      expect(view?.markPrice).toBeCloseTo(1e-18, 24);
      expect(view?.liquidityNote).toBe("Liquidity gone, no sell route");
      expect(desk.liveBook!.positions.has(mint)).toBe(true);
      expect(desk.liveBook!.cashUsd).toBe(cash);
      expect(pos.peakPrice).toBe(peak);
      expect(pos.trailArmed).toBe(trail);
      expect(desk.snapshot().rules.stopLossPct).toBe(stopPct);
      expect(desk.snapshot().events.length).toBe(events);
      expect(liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell")).toHaveLength(sells);
    } finally {
      desk.stop();
    }
  });

  it("keeps a paper position in the main list until a 99% drop has held, and still does not sell", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      const pos = desk.book.positions.get(mint)!;
      const low = pos.entryPrice * 0.005;
      expect(pos.qty * low).toBeGreaterThan(0.01);
      const now = Date.now();
      desk.book.mark(mint, low);
      desk.book.noteMark(mint, low, now - 8_000);
      expect(desk.snapshot().positions.find((row) => row.mint === mint)?.liquidityNote ?? null).toBeNull();
      desk.book.noteMark(mint, low, now - 4_000);
      desk.book.noteMark(mint, low, now);
      const cash = desk.book.cashUsd;
      const view = desk.snapshot().positions.find((row) => row.mint === mint);
      expect(view?.liquidityNote).toBe("Liquidity gone, no sell route");
      expect(desk.book.positions.has(mint)).toBe(true);
      expect(desk.book.cashUsd).toBe(cash);
      expect(desk.snapshot().events.some((event) => event.code === "STOP_LOSS" || event.code === "MANUAL_CLOSE")).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("counts a collapsed price that the chart folds into one point", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      const pos = desk.book.positions.get(mint)!;
      const low = pos.entryPrice * 0.005;
      expect(pos.qty * low).toBeGreaterThan(0.01);
      const t0 = Date.now();
      for (let i = 0; i < 40; i++) {
        const at = t0 + i * 1_500;
        desk.book.mark(mint, low, at);
        desk.book.noteMark(mint, low, at);
        const note = desk.snapshot().positions.find((row) => row.mint === mint)?.liquidityNote ?? null;
        if (i < 2) expect(note).toBeNull();
      }
      expect(desk.book.points(mint).filter((point) => point.priceUsd === low)).toHaveLength(1);
      expect(desk.snapshot().positions.find((row) => row.mint === mint)?.liquidityNote).toBe("Liquidity gone, no sell route");
      expect(desk.book.positions.has(mint)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("does not call Jupiter for a pump-route coin, and uses the shared quote fetch", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "PUMP", priceUsd: 1, liquidityUsd: 180_000 }));
      const pos = desk.book.positions.get(mint)!;
      pos.dex = "pump.fun";
      pos.priceFeed = "chain";
      const calls: string[] = [];
      const fetchImpl = (async (url: URL | RequestInfo) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ errorCode: "NO_ROUTES_FOUND" }), { status: 400 });
      }) as typeof fetch;
      await desk.probeSellRoutes(fetchImpl);
      expect(calls).toHaveLength(0);
      expect(desk.snapshot().positions.find((row) => row.mint === mint)?.liquidityNote ?? null).toBeNull();

      const priorities: number[] = [];
      const orig = desk.net.fetchAt.bind(desk.net);
      desk.net.fetchAt = ((priority: Priority) => {
        priorities.push(priority);
        return orig(priority);
      }) as typeof desk.net.fetchAt;
      pos.dex = "raydium";
      pos.priceFeed = "dexscreener";
      const quoted = (async () => new Response(JSON.stringify({ outAmount: "1000" }), { status: 200 })) as typeof fetch;
      await desk.probeSellRoutes(quoted);
      expect(priorities).toHaveLength(0);
      priorities.length = 0;
      desk.net.fetchAt = ((priority: Priority) => {
        priorities.push(priority);
        return (async () => new Response(JSON.stringify({ outAmount: "1000" }), { status: 200 })) as typeof fetch;
      }) as typeof desk.net.fetchAt;
      await desk.probeSellRoutes();
      expect(priorities).toEqual([0]);
      expect(desk.book.positions.has(mint)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("a read-only quote with no pool sets the note and never calls the swap", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      const calls: Array<{ method: string; url: string }> = [];
      const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url: String(url) });
        return new Response(JSON.stringify({ errorCode: "NO_ROUTES_FOUND" }), { status: 400, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      await desk.probeSellRoutes(fetchImpl);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toMatch(/\/quote\?/);
      expect(desk.snapshot().positions.find((row) => row.mint === mint)?.liquidityNote).toBe("Liquidity gone, no sell route");
      expect(desk.book.positions.has(mint)).toBe(true);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();

      const quoted = (async () => new Response(JSON.stringify({ outAmount: "1000" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      await desk.probeSellRoutes(quoted);
      expect(desk.snapshot().positions.find((row) => row.mint === mint)?.liquidityNote ?? null).toBeNull();
    } finally {
      desk.stop();
    }
  });

  it("does not keep a no-route flag on a position that was replaced while the quote was in flight", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        if (calls === 1) await gate;
        return new Response(JSON.stringify({ errorCode: "NO_ROUTES_FOUND" }), { status: 400 });
      }) as typeof fetch;
      const first = desk.probeSellRoutes(fetchImpl);
      const second = desk.probeSellRoutes(fetchImpl);
      await Promise.resolve();
      expect(calls).toBe(1);
      desk.book.positions.delete(mint);
      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      release();
      await first;
      await second;
      expect(calls).toBe(1);
      expect(desk.snapshot().positions.find((row) => row.mint === mint)?.liquidityNote ?? null).toBeNull();
      await desk.probeSellRoutes(fetchImpl);
      expect(desk.snapshot().positions.find((row) => row.mint === mint)?.liquidityNote).toBe("Liquidity gone, no sell route");
      expect(desk.resetPaperBook(true).ok).toBe(true);
      await desk.submitCandidate(makeToken({ mint, symbol: "INSANE", priceUsd: 1, liquidityUsd: 180_000 }));
      expect(desk.snapshot().positions.find((row) => row.mint === mint)?.liquidityNote ?? null).toBeNull();
    } finally {
      desk.stop();
    }
  });
});

describe("v13.51 readSellRoute", () => {
  it("reads a quote and does not treat a timeout as a drained pool", async () => {
    const no = await readSellRoute({
      quoteUrl: "https://lite-api.jup.ag/swap/v1/quote",
      inputMint: mint,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000",
      fetchImpl: (async (_url, init) => {
        expect(init?.method).toBe("GET");
        return new Response(JSON.stringify({ errorCode: "NO_ROUTES_FOUND" }), { status: 400 });
      }) as typeof fetch
    });
    expect(no).toBe("no_route");
    const down = await readSellRoute({
      quoteUrl: "https://lite-api.jup.ag/swap/v1/quote",
      inputMint: mint,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000",
      fetchImpl: (async () => {
        throw new Error("timeout");
      }) as typeof fetch
    });
    expect(down).toBe("unknown");
  });
});
