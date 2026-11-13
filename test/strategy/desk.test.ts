import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { Desk } from "../../src/desk/orchestrator.js";
import { makeToken } from "../../src/demo/tokens.js";
import { STRATEGY } from "../../src/strategy/config.js";
import { testConfig, testDesk } from "../helpers.js";

const MINT = "EngineTest1111111111111111111111111111111";
const young = (over: Parameters<typeof makeToken>[0] = {}) =>
  makeToken({ mint: MINT, symbol: "ENG", priceUsd: 0.001, ageSeconds: 600, volume5mUsd: 40_000, discoveredAt: Date.now(), ...over });
const quote = (at: number, priceUsd: number) => ({ at, priceUsd, vol5mUsd: 40_000, vol1hUsd: 180_000, change1hPct: 15 });

/** Watch a coin and walk it to a launch signal. Returns the signal price. */
async function signal(desk: Desk, token = young()): Promise<number> {
  await desk.submitCandidate(token);
  const t = Date.now();
  const up = token.priceUsd * 1.025;
  await desk.submitStrategyQuote(token.mint, quote(t + 10_000, token.priceUsd * 1.01), t + 10_000);
  await desk.submitStrategyQuote(token.mint, quote(t + 22_000, up), t + 22_000);
  return up;
}

function engineDesk(patch: Record<string, unknown> = {}): Desk {
  const desk = testDesk();
  const result = desk.updateStrategy({ enabled: true, ...patch });
  if (!result.ok) throw new Error(result.error);
  return desk;
}

const codes = (desk: Desk) => desk.snapshot().events.map((e) => e.code).filter(Boolean);

describe("trading engine on the desk", () => {
  it("defaults on for live feeds, off on the replay tape, and the env switch overrides", () => {
    expect(loadConfig({ FEED_MODE: "live", DEMO_FEED: "0" }).strategyEngine).toBe(true);
    expect(loadConfig({ FEED_MODE: "replay" }).strategyEngine).toBe(false);
    expect(loadConfig({}).strategyEngine).toBe(false);
    expect(loadConfig({ FEED_MODE: "live", DEMO_FEED: "0", STRATEGY_ENGINE: "0" }).strategyEngine).toBe(false);
    expect(loadConfig({ FEED_MODE: "replay", STRATEGY_ENGINE: "1" }).strategyEngine).toBe(true);
    const desk = testDesk();
    try {
      expect(desk.strategy.settings.enabled).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("off: an analyst pass is bought on sight, as before", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(young());
      const pos = desk.book.positions.get(MINT);
      expect(pos).toBeDefined();
      expect(pos?.strategy).toBeUndefined();
    } finally {
      desk.stop();
    }
  });

  it("on: an analyst pass is watched, not bought, until a signal fires", async () => {
    const desk = engineDesk();
    try {
      await desk.submitCandidate(young());
      expect(desk.book.positions.size).toBe(0);
      expect(codes(desk)).toContain("SIGNAL_WATCH");
      expect(desk.snapshot().strategy?.watching).toBe(1);
      const t = Date.now();
      await desk.submitStrategyQuote(MINT, quote(t + 10_000, 0.00101), t + 10_000);
      expect(desk.book.positions.size).toBe(0);
      await desk.submitStrategyQuote(MINT, quote(t + 22_000, 0.001025), t + 22_000);
      const pos = desk.book.positions.get(MINT);
      expect(pos).toBeDefined();
      expect(pos?.costUsd).toBe(50);
      expect(pos?.tag).toBe("launch");
      expect(pos?.entry).toBe("analyst");
      expect(pos?.live).toBeUndefined();
      expect(pos?.strategy).toMatchObject({ variant: "launch-1", signal: "launch", stopPct: 0.01, targetNetUsd: 3, timeLimitMs: STRATEGY.launch.timeLimitMs });
      expect(codes(desk)).toContain("SIGNAL");
      // The three launch shadow books took the same signal.
      expect(desk.snapshot().strategy?.variants.filter((v) => v.open === 1 && !v.trailPct).map((v) => v.variant).sort()).toEqual(["launch-1", "launch-3", "launch-6"]);
      expect(desk.snapshot().strategy?.variants.filter((v) => v.open === 1 && v.trailPct).map((v) => v.variant).sort()).toEqual(
        ["launch-3-t12", "launch-3-t12f", "launch-3-t4", "launch-3-t4f", "launch-3-t8", "launch-3-t8f"]
      );
    } finally {
      desk.stop();
    }
  });

  it("never watches a coin the Filter killed", async () => {
    const desk = engineDesk();
    try {
      await desk.submitCandidate(young({ mintAuthorityRevoked: false }));
      expect(desk.snapshot().strategy?.watching).toBe(0);
      expect(codes(desk)).not.toContain("SIGNAL_WATCH");
    } finally {
      desk.stop();
    }
  });

  it("takes profit on its own once a sell nets $3", async () => {
    const desk = engineDesk();
    try {
      const up = await signal(desk);
      await desk.markPrice(MINT, up * 1.03);
      expect(desk.book.positions.has(MINT)).toBe(true);
      await desk.markPrice(MINT, up * 1.09);
      expect(desk.book.positions.has(MINT)).toBe(false);
      const closed = desk.store.recentClosed(5).find((t) => t.mint === MINT);
      expect(closed?.exitCode).toBe("TAKE_PROFIT");
      expect(closed!.pnlUsd).toBeGreaterThanOrEqual(3);
      expect(closed?.mode).toBe("paper");
    } finally {
      desk.stop();
    }
  });

  it("stops at 1% from the fill, well inside the 6% hard stop", async () => {
    const desk = engineDesk();
    try {
      await signal(desk);
      const entry = desk.book.positions.get(MINT)!.entryPrice;
      await desk.markPrice(MINT, entry * 0.995);
      expect(desk.book.positions.has(MINT)).toBe(true);
      await desk.markPrice(MINT, entry * 0.985);
      const closed = desk.store.recentClosed(5).find((t) => t.mint === MINT);
      expect(closed?.exitCode).toBe("STRATEGY_STOP");
      expect(closed!.pnlUsd).toBeLessThan(0);
      expect(closed!.pnlUsd).toBeGreaterThan(-1.5);
    } finally {
      desk.stop();
    }
  });

  it("the desk's hard stop still goes first", async () => {
    const desk = engineDesk({ active: { launch: "launch-6" } });
    try {
      await signal(desk);
      const pos = desk.book.positions.get(MINT)!;
      expect(pos.strategy?.stopPct).toBe(0.06);
      await desk.markPrice(MINT, pos.entryPrice * 0.93);
      const closed = desk.store.recentClosed(5).find((t) => t.mint === MINT);
      expect(["STOP_LOSS", "GAP_RUG"]).toContain(closed?.exitCode);
    } finally {
      desk.stop();
    }
  });

  it("gives a trade back at breakeven after it was halfway to target", async () => {
    const desk = engineDesk({ active: { launch: "launch-6" } });
    try {
      const up = await signal(desk);
      await desk.markPrice(MINT, up * 1.045);
      expect(desk.book.positions.get(MINT)?.strategy?.breakevenArmed).toBe(true);
      await desk.markPrice(MINT, up * 1.004);
      const closed = desk.store.recentClosed(5).find((t) => t.mint === MINT);
      expect(closed?.exitCode).toBe("BREAKEVEN_STOP");
      expect(Math.abs(closed!.pnlUsd)).toBeLessThan(0.5);
    } finally {
      desk.stop();
    }
  });

  it("closes a stale trade at the time limit", async () => {
    const desk = engineDesk({ active: { launch: "launch-6" } });
    try {
      const up = await signal(desk);
      await desk.markPrice(MINT, up * 1.002);
      desk.strategyPass();
      expect(desk.book.positions.has(MINT)).toBe(true);
      desk.book.positions.get(MINT)!.openedAt = Date.now() - STRATEGY.launch.timeLimitMs - 1_000;
      desk.strategyPass();
      await desk.markPrice(MINT, up * 1.002);
      const closed = desk.store.recentClosed(5).find((t) => t.mint === MINT);
      expect(closed?.exitCode).toBe("TIME_LIMIT");
    } finally {
      desk.stop();
    }
  });

  it("holds two engine positions at most", async () => {
    const desk = engineDesk();
    try {
      for (const n of [1, 2, 3]) {
        await signal(desk, young({ mint: `EngineMany${n}11111111111111111111111111111`, symbol: `EN${n}` }));
      }
      expect([...desk.book.positions.values()].filter((p) => p.strategy).length).toBe(2);
      expect(codes(desk)).toContain("MAX_OPEN_POSITIONS");
    } finally {
      desk.stop();
    }
  });

  it("pauses engine buys once the paper book is $10 down on the day", async () => {
    const desk = engineDesk();
    try {
      desk.store.openTrade({ id: "loss-1", mint: "LossMint", symbol: "LOSS", openedAt: Date.now() - 60_000, costUsd: 50, score: 0.7, mode: "paper" });
      desk.store.closeTrade({
        id: "loss-1",
        mint: "LossMint",
        symbol: "LOSS",
        openedAt: Date.now() - 60_000,
        closedAt: Date.now() - 30_000,
        costUsd: 50,
        proceedsUsd: 39,
        pnlUsd: -11,
        pnlPct: -0.22,
        exitCode: "STOP_LOSS",
        score: 0.7,
        mode: "paper"
      });
      await signal(desk);
      expect(desk.book.positions.size).toBe(0);
      expect(codes(desk)).toContain("DAILY_LOSS");
    } finally {
      desk.stop();
    }
  });

  it("saves the switch and settings across a restart, and rejects a bad patch", async () => {
    const config = testConfig();
    const first = new Desk(config);
    expect(first.updateStrategy({ enabled: true, tradeUsd: 25, active: { momentum: "momentum-3" } }).ok).toBe(true);
    expect(first.updateStrategy({ tradeUsd: "lots" }).ok).toBe(false);
    first.stop();
    const second = new Desk({ ...config, resetPaper: false });
    try {
      expect(second.strategy.settings).toMatchObject({ enabled: true, tradeUsd: 25, active: { launch: "launch-1", momentum: "momentum-3" } });
      expect(second.resetStrategy(false).ok).toBe(false);
      expect(second.resetStrategy(true).ok).toBe(true);
    } finally {
      second.stop();
    }
  });

  it("reports main-book engine positions separately from shadow holdings", async () => {
    const desk = engineDesk({ maxOpen: 1 });
    try {
      await signal(desk, young({ mint: "EngineOpenA11111111111111111111111111111111", symbol: "OPA" }));
      // The second signal is refused on the main book (1 open at most)...
      await signal(desk, young({ mint: "EngineOpenB11111111111111111111111111111111", symbol: "OPB" }));
      const card = desk.snapshot().strategy!;
      expect(card.mainOpen).toBe(1);
      // ...while each shadow book also holds one, so the shadow sum is not the main-book count.
      expect(card.variants.filter((v) => v.signal === "launch").map((v) => v.open)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
      // A scorecard reset wipes the shadow books and leaves the main book alone.
      const reset = desk.resetStrategy(true);
      expect(reset.ok && reset.strategy.mainOpen).toBe(1);
      expect(desk.strategyView().variants.every((v) => v.open === 0)).toBe(true);
      expect(desk.book.positions.size).toBe(1);
    } finally {
      desk.stop();
    }
  });

  it("puts the scorecard and timings on the snapshot", async () => {
    const desk = engineDesk();
    try {
      await signal(desk);
      const snap = desk.snapshot();
      expect(snap.strategy?.variants).toHaveLength(18);
      expect(snap.strategy?.variants.slice(0, 6).map((v) => v.variant)).toEqual(["launch-1", "launch-3", "launch-6", "momentum-1", "momentum-3", "momentum-6"]);
      expect(snap.strategy?.liveVariant).toBeNull();
      expect(snap.strategy?.note).toMatch(/best case/i);
      expect(snap.perf?.candidateToDecision?.count).toBeGreaterThanOrEqual(1);
      expect(snap.perf?.watchToSignal?.count).toBe(1);
    } finally {
      desk.stop();
    }
  });
});
