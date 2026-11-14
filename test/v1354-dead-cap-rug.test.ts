import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { exitQuoteHaircut, realizedFillSlippage, sellImpactRefused } from "../src/market/live-broker.js";
import { streamSkipFreshMs, STREAM_FRESH_MS } from "../src/market/position-pricer.js";
import { assessRugExit, rugSlippageApplies, RUG_EXIT_SLIPPAGE, RUG_WATCH_MS } from "../src/strategy/rug-exit.js";
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

const quote = (at: number, priceUsd: number, liquidityUsd = 180_000) => ({
  at,
  priceUsd,
  vol5mUsd: 40_000,
  vol1hUsd: 180_000,
  change1hPct: 15,
  liquidityUsd
});

async function fill(desk: Desk, mint: string, symbol: string, over: Parameters<typeof makeToken>[0] = {}): Promise<void> {
  const token = makeToken({ mint, symbol, priceUsd: 1, ageSeconds: 600, volume5mUsd: 40_000, liquidityUsd: 180_000, discoveredAt: Date.now(), ...over });
  await desk.submitCandidate(token);
  const t = Date.now();
  await desk.submitStrategyQuote(mint, quote(t + 10_000, 1.01), t + 10_000);
  await desk.submitStrategyQuote(mint, quote(t + 22_000, 1.025), t + 22_000);
}

const buyFill = (req: { sizeUsd?: number; markPriceUsd?: number }) => {
  const mark = req.markPriceUsd ?? 1;
  return { signature: "sig-buy", fillPriceUsd: mark * 1.005, qty: (req.sizeUsd ?? 5) / (mark * 1.005), notionalUsd: req.sizeUsd ?? 5, feeUsd: 0.01, slippage: 0.005 };
};

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number; markPriceUsd?: number }) =>
    req.side === "buy" ? buyFill(req) : { signature: "sig-sell", fillPriceUsd: req.markPriceUsd ?? 1, qty: req.qty ?? 0, notionalUsd: req.qty ?? 0, feeUsd: 0.01, slippage: 0.02 }
  );
});

describe("v13.54 dead live positions do not fill the cap", () => {
  it("keeps a collapsed engine position on the book, frees its slot, and (13.57) pauses on the money lost", async () => {
    const desk = liveDesk();
    try {
      const a = "DeadCapA111111111111111111111111111111111";
      const b = "DeadCapB111111111111111111111111111111111";
      const c = "DeadCapC111111111111111111111111111111111";
      const d = "DeadCapD111111111111111111111111111111111";
      await fill(desk, a, "DACITY");
      await fill(desk, b, "CHARITY");
      expect(desk.strategyView().live?.open).toBe(2);
      await fill(desk, c, "HELD");
      expect(desk.liveBook!.positions.has(c)).toBe(false);
      expect(desk.strategyView().live?.lastSkip?.message).toMatch(/2 live/);
      for (const mint of [a, b]) desk.liveBook!.mark(mint, 1e-18, Date.now());
      expect(desk.snapshot().liveBook?.positions.find((row) => row.mint === a)?.liquidityNote).toBe("Liquidity gone, no sell route");
      expect(desk.strategyView().live?.open).toBe(0);
      expect(desk.liveBook!.positions.has(a)).toBe(true);
      expect(desk.liveBook!.positions.has(b)).toBe(true);
      // The slots are free. Since 13.57 the money in the two dead coins counts toward the $5 live pause.
      await fill(desk, d, "NEW");
      expect(desk.liveBook!.positions.has(d)).toBe(false);
      expect(desk.liveBook!.positions.has(a)).toBe(true);
      expect(desk.strategyView().live?.open).toBe(0);
      expect(desk.strategyView().live?.blocked).toMatch(/2 coins that died today and have no pool left/);
    } finally {
      desk.stop();
    }
  });

  it("a live wallet balance of 0 does not count, and the position stays", async () => {
    const desk = liveDesk();
    desk.updateStrategy({ maxOpen: 1 });
    liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; markPriceUsd?: number; qty?: number }) => {
      if (req.side === "sell") throw new Error("LIVE_SWAP_FAILED: wallet holds none of this token");
      return buyFill(req);
    });
    try {
      const a = "ZeroBalA111111111111111111111111111111111";
      const b = "ZeroBalB111111111111111111111111111111111";
      await fill(desk, a, "DACITY");
      const pos = desk.liveBook!.positions.get(a)!;
      const feed = pos.priceFeed ?? "test";
      const mark = (pos.entryMark ?? pos.entryPrice) * 0.98;
      desk.bus.emit("market.tick", { mint: a, priceUsd: mark, liquidityUsd: 180_000, at: Date.now(), feed } as never);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(desk.liveBook!.positions.has(a)).toBe(true);
      expect(desk.strategyView().live?.open).toBe(0);
      expect(desk.snapshot().liveBook?.positions.find((row) => row.mint === a)?.liquidityNote ?? null).toBeNull();
      // Not open, so no slot. Since 13.57 its cost counts toward the $5 live pause, so the next buy waits.
      await fill(desk, b, "NEXT");
      expect(desk.liveBook!.positions.has(b)).toBe(false);
      expect(desk.liveBook!.positions.has(a)).toBe(true);
      expect(desk.strategyView().live?.blocked).toMatch(/live pause/);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.54 rug exit", () => {
  it("sells a young live engine position when the pool drops, past the 6% cap", async () => {
    const desk = liveDesk();
    try {
      const mint = "RugPool1111111111111111111111111111111111";
      await fill(desk, mint, "FOMO");
      const pos = desk.liveBook!.positions.get(mint)!;
      const price = desk.liveBook!.price(mint, pos.entryPrice);
      const feed = pos.priceFeed ?? "test";
      desk.bus.emit("market.tick", { mint, priceUsd: price, liquidityUsd: 180_000 * 0.5, at: Date.now(), feed } as never);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell");
      expect(sells).toHaveLength(1);
      expect(sells[0]?.[0].maxExitSlippage).toBe(RUG_EXIT_SLIPPAGE);
      expect(sells[0]?.[0].markStale).not.toBe(true);
      expect(sells[0]?.[0].sellAnyway).not.toBe(true);
      expect(desk.liveBook!.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "RUG_EXIT")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("keeps a hard stop at 6% inside the rug window", async () => {
    const desk = liveDesk();
    try {
      const mint = "HardStop11111111111111111111111111111111";
      await fill(desk, mint, "STOP");
      const pos = desk.liveBook!.positions.get(mint)!;
      const feed = pos.priceFeed ?? "test";
      const mark = (pos.entryMark ?? pos.entryPrice) * 0.93;
      desk.bus.emit("market.tick", { mint, priceUsd: mark, liquidityUsd: 180_000, at: Date.now(), feed } as never);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell");
      expect(sells).toHaveLength(1);
      expect(sells[0]?.[0].maxExitSlippage).toBeCloseTo(0.06, 5);
      expect(sells[0]?.[0].rugExit).not.toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "STOP_LOSS")).toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "RUG_EXIT")).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("keeps an ordinary engine stop at 6% after the rug window", async () => {
    const desk = liveDesk();
    try {
      const mint = "OldStop111111111111111111111111111111111";
      await fill(desk, mint, "RARE");
      const pos = desk.liveBook!.positions.get(mint)!;
      pos.openedAt = Date.now() - RUG_WATCH_MS - 5_000;
      const feed = pos.priceFeed ?? "test";
      const mark = (pos.entryMark ?? pos.entryPrice) * 0.96;
      desk.bus.emit("market.tick", { mint, priceUsd: mark, liquidityUsd: 180_000, at: Date.now(), feed } as never);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell");
      expect(sells).toHaveLength(1);
      expect(sells[0]?.[0].maxExitSlippage).toBeCloseTo(0.06, 5);
      expect(sells[0]?.[0].markStale).not.toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "STRATEGY_STOP")).toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "RUG_EXIT")).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("does not treat the previous hold's pool depth as a drain on the next fill", async () => {
    const desk = liveDesk();
    try {
      const mint = "Reopen1111111111111111111111111111111111";
      await fill(desk, mint, "AGAIN");
      const first = desk.liveBook!.positions.get(mint)!;
      const feed = first.priceFeed ?? "test";
      const price = desk.liveBook!.price(mint, first.entryPrice);
      desk.bus.emit("market.tick", { mint, priceUsd: price * 0.98, liquidityUsd: 50_000, at: Date.now(), feed } as never);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(desk.liveBook!.positions.has(mint)).toBe(false);
      const sells = () => liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell").length;
      const closed = sells();
      (desk as unknown as { strategy: { signalled: Map<string, number> } }).strategy.signalled.delete(mint);
      await fill(desk, mint, "AGAIN");
      expect(desk.liveBook!.positions.has(mint)).toBe(true);
      desk.strategyPass();
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(sells()).toBe(closed);
      const again = desk.liveBook!.positions.get(mint)!;
      desk.bus.emit("market.tick", { mint, priceUsd: desk.liveBook!.price(mint, again.entryPrice), liquidityUsd: 50_000, at: Date.now(), feed: again.priceFeed ?? feed } as never);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(sells()).toBe(closed + 1);
      expect(desk.snapshot().events.some((event) => event.code === "RUG_EXIT")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("sells when a holder read after the fill shows a dev dump", async () => {
    const desk = liveDesk();
    try {
      const mint = "DevDump111111111111111111111111111111111";
      await fill(desk, mint, "DUMP", { devHoldingPct: 0.3, top10HolderPct: 0.2 });
      const pos = desk.liveBook!.positions.get(mint)!;
      expect(pos.strategy?.entryDevHoldingPct).toBe(0.3);
      desk.strategyPass();
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(desk.liveBook!.positions.has(mint)).toBe(true);
      desk.bus.emit(
        "scout.candidate",
        makeToken({
          mint,
          symbol: "DUMP",
          priceUsd: desk.liveBook!.price(mint, pos.entryPrice),
          liquidityUsd: 180_000,
          devHoldingPct: 0.05,
          top10HolderPct: 0.2,
          discoveredAt: Date.now()
        })
      );
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(desk.liveBook!.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "RUG_EXIT")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("fires the engine stop on a stale live mark", async () => {
    const desk = liveDesk();
    try {
      const mint = "StaleStop11111111111111111111111111111111";
      await fill(desk, mint, "JEV");
      const pos = desk.liveBook!.positions.get(mint)!;
      const mark = (pos.entryMark ?? pos.entryPrice) * 0.98;
      desk.liveBook!.mark(mint, mark, Date.now() - 45_000);
      desk.strategyPass();
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "sell");
      expect(sells).toHaveLength(1);
      expect(sells[0]?.[0].markStale).toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "STRATEGY_STOP")).toBe(true);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.54 fill slippage and a quiet stream", () => {
  it("records the fill against the mark, not a 1% placeholder", () => {
    expect(realizedFillSlippage("buy", 1, 1.012)).toBeCloseTo(0.012, 6);
    expect(realizedFillSlippage("sell", 1, 0.97)).toBeCloseTo(0.03, 6);
    expect(realizedFillSlippage("buy", 1, 1)).toBe(0);
    expect(realizedFillSlippage("sell", 1, 1.02)).toBe(0);
    const stale = exitQuoteHaircut(0.8, 0.02, true);
    expect(stale).toBeCloseTo(0.02, 6);
    expect(sellImpactRefused(stale ?? 0, 0.06, false)).toBe(false);
    expect(sellImpactRefused(exitQuoteHaircut(0.08, 0.02, false) ?? 0, 0.06, false)).toBe(true);
    expect(sellImpactRefused(exitQuoteHaircut(0.8, 0.6, true) ?? 0, 0.5, false)).toBe(true);
    expect(sellImpactRefused(exitQuoteHaircut(0, 0.07, false) ?? 0, 0.06, false)).toBe(true);
    expect(assessRugExit({ now: 10_000, openedAt: 0, entryLiquidityUsd: 100, liquidityUsd: 60 })).toMatchObject({ code: "RUG_EXIT" });
    expect(assessRugExit({ now: 10_000, openedAt: 0, entryLiquidityUsd: 100, liquidityUsd: 90 })).toBeNull();
    expect(assessRugExit({ now: RUG_WATCH_MS + 5, openedAt: 0, entryLiquidityUsd: 100, liquidityUsd: 10 })).toBeNull();
    expect(assessRugExit({ now: 1_000, openedAt: 0, entryDevHoldingPct: 0.2, devHoldingPct: 0.05 })?.code).toBe("RUG_EXIT");
    const young = { strategy: { variant: "launch-1", signal: "launch" as const, stopPct: 0.01, targetNetUsd: 1, timeLimitMs: 60_000 }, openedAt: 0 };
    expect(rugSlippageApplies(young, "RUG_EXIT", 1_000)).toBe(true);
    expect(rugSlippageApplies(young, "STOP_LOSS", 1_000)).toBe(false);
    expect(rugSlippageApplies(young, "STRATEGY_STOP", 1_000)).toBe(false);
    expect(rugSlippageApplies(young, "LIQUIDITY_DROP", 1_000)).toBe(false);
    expect(rugSlippageApplies(young, "GAP_RUG", 1_000)).toBe(false);
  });

  it("does not skip the price poll when the stream is connected but silent", () => {
    const silent = { connected: () => true, stats: () => ({ lastUpdateAt: null, updates: 0 }) };
    expect(streamSkipFreshMs(silent, 10_000)).toBe(0);
    const quiet = { connected: () => true, stats: () => ({ lastUpdateAt: 10_000 - STREAM_FRESH_MS - 1, updates: 4 }) };
    expect(streamSkipFreshMs(quiet, 10_000)).toBe(0);
    const live = { connected: () => true, stats: () => ({ lastUpdateAt: 9_500, updates: 4 }) };
    expect(streamSkipFreshMs(live, 10_000)).toBe(STREAM_FRESH_MS);
  });
});
