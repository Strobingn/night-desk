import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../../src/desk/orchestrator.js";
import { makeToken } from "../../src/demo/tokens.js";
import { testConfig } from "../helpers.js";

const MINT = "TapePath11111111111111111111111111111111";

/** A DexScreener /tokens/v1 stand-in whose price the test moves. */
function dex(state: { priceUsd: number; calls: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("api.dexscreener.com/tokens/v1/solana/")) return new Response("[]", { status: 404 });
    state.calls += 1;
    const body = [
      {
        baseToken: { address: MINT },
        priceUsd: String(state.priceUsd),
        liquidity: { usd: 180_000 },
        volume: { h1: 180_000, m5: 40_000 },
        priceChange: { h1: 15 },
        dexId: "raydium"
      }
    ];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function run(priceFeed: "dexscreener" | "jupiter" | undefined) {
  const state = { priceUsd: 0.001, calls: 0 };
  const desk = new Desk(testConfig(), { depthFetch: dex(state) });
  desk.updateStrategy({ enabled: true });
  await desk.submitCandidate(makeToken({ mint: MINT, symbol: "TAPE", priceUsd: 0.001, ageSeconds: 600, volume5mUsd: 40_000, discoveredAt: Date.now(), priceFeed }));
  const step = async (priceUsd: number) => {
    state.priceUsd = priceUsd;
    vi.setSystemTime(Date.now() + 12_000);
    await desk.tape!.tick();
    desk.strategyPass();
    await desk.submitStrategyQuote("nothing", { at: Date.now(), priceUsd: 1, vol5mUsd: null, vol1hUsd: null, change1hPct: null });
  };
  await step(0.00101);
  const afterFirst = desk.book.positions.has(MINT);
  await step(0.00103);
  return { desk, state, afterFirst };
}

describe("engine on the real Tape path", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T15:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("pins a watched coin on the Tape quoter and buys when its quotes fire a signal", async () => {
    const { desk, state, afterFirst } = await run("dexscreener");
    try {
      expect(state.calls).toBe(2);
      expect(afterFirst).toBe(false);
      const pos = desk.book.positions.get(MINT);
      expect(pos?.strategy?.signal).toBe("launch");
      expect(pos?.costUsd).toBe(50);
      // Still quoted while the shadow books hold it.
      expect(desk.strategy.pinned()).toContain(MINT);
    } finally {
      desk.stop();
    }
  });

  it("ignores quotes from a feed other than the one the coin is anchored to", async () => {
    const { desk } = await run("jupiter");
    try {
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(desk.snapshot().strategy?.stats.signals.launch).toBe(0);
    } finally {
      desk.stop();
    }
  });
});
