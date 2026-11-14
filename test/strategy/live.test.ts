import { describe, expect, it, vi, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../../src/demo/tokens.js";
import { Desk } from "../../src/desk/orchestrator.js";
import { STRATEGY } from "../../src/strategy/config.js";
import type { WalletBalances } from "../../src/market/wallet-status.js";
import { testConfig } from "../helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));

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
    while (carry) {
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

const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });

function liveDesk(ready = true): Desk {
  const secret = base58Encode(Keypair.generate().secretKey);
  const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: rich });
  desk.setOperatorReady(ready);
  return desk;
}

const MINT = "EngineLive111111111111111111111111111111111";
const young = (over: Parameters<typeof makeToken>[0] = {}) =>
  makeToken({ mint: MINT, symbol: "ELV", priceUsd: 1, ageSeconds: 600, volume5mUsd: 40_000, liquidityUsd: 180_000, discoveredAt: Date.now(), ...over });
const quote = (at: number, priceUsd: number) => ({ at, priceUsd, vol5mUsd: 40_000, vol1hUsd: 180_000, change1hPct: 15, liquidityUsd: 180_000 });

async function signal(desk: Desk, token = young()): Promise<void> {
  await desk.submitCandidate(token);
  const t = Date.now();
  await desk.submitStrategyQuote(token.mint, quote(t + 10_000, token.priceUsd * 1.01), t + 10_000);
  await desk.submitStrategyQuote(token.mint, quote(t + 22_000, token.priceUsd * 1.025), t + 22_000);
}

const buys = () => liveBroker.executeLiveSwap.mock.calls.filter((c) => c[0].side === "buy");
const codes = (desk: Desk) => desk.snapshot().events.map((e) => e.code).filter(Boolean);

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number; markPriceUsd?: number }) =>
    req.side === "buy"
      ? { signature: "sig-buy", fillPriceUsd: (req.markPriceUsd ?? 1) * 1.005, qty: (req.sizeUsd ?? 0) / ((req.markPriceUsd ?? 1) * 1.005), notionalUsd: req.sizeUsd ?? 0, feeUsd: 0.01, slippage: 0.005 }
      : { signature: "sig-sell", fillPriceUsd: 1, qty: req.qty ?? 0, notionalUsd: req.qty ?? 0, feeUsd: 0.01, slippage: 0.01 }
  );
});

describe("engine live variant", () => {
  it("sends nothing live while no live variant is set", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true });
      await signal(desk);
      expect(desk.book.positions.get(MINT)?.strategy?.variant).toBe("launch-1");
      expect(buys()).toHaveLength(0);
      expect(desk.liveBook!.positions.size).toBe(0);
      expect(desk.strategyView().live?.blocked).toMatch(/No live variant/);
    } finally {
      desk.stop();
    }
  });

  it("buys live at the live size with the live variant's rules, next to the paper trade", async () => {
    const desk = liveDesk();
    try {
      const set = desk.updateStrategy({ enabled: true, liveVariant: "launch-3-t8f" });
      expect(set.ok && set.strategy.live).toMatchObject({ open: 0, tradeUsd: 5, targetNetUsd: 0.3, blocked: null });
      await signal(desk);
      expect(buys()).toHaveLength(1);
      expect(buys()[0]?.[0]).toMatchObject({ side: "buy", sizeUsd: 5 });
      const pos = desk.liveBook!.positions.get(MINT);
      expect(pos?.live).toBe(true);
      expect(pos?.strategy).toMatchObject({ variant: "launch-3-t8f", stopPct: 0.03, trailPct: 0.08, fade: true, targetNetUsd: 0.3 });
      expect(desk.book.positions.get(MINT)?.strategy?.variant).toBe("launch-1");
      expect(desk.strategyView().live?.open).toBe(1);
      expect(codes(desk)).toContain("STRATEGY");
    } finally {
      desk.stop();
    }
  });

  it("a momentum live variant does not buy on a launch signal", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "momentum-3" });
      await signal(desk);
      expect(buys()).toHaveLength(0);
      expect(desk.book.positions.has(MINT)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("refuses while the live checklist is off, and the paper trade still happens", async () => {
    const desk = liveDesk(false);
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      expect(desk.strategyView().live?.blocked).toMatch(/checklist/);
      await signal(desk);
      expect(buys()).toHaveLength(0);
      expect(desk.book.positions.has(MINT)).toBe(true);
      expect(codes(desk)).toContain("ENGINE_LIVE_PAUSED");
    } finally {
      desk.stop();
    }
  });

  it("respects the live daily cap and the engine's open limit", async () => {
    const desk = liveDesk();
    try {
      desk.updateSettings({ liveDailyCapUsd: 5 });
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3", maxOpen: 1 });
      await signal(desk);
      expect(buys()).toHaveLength(1);
      await signal(desk, young({ mint: "EngineLive222222222222222222222222222222222", symbol: "EL2" }));
      expect(buys()).toHaveLength(1);
      expect(desk.liveBook!.positions.size).toBe(1);
    } finally {
      desk.stop();
    }
  });

  it("a dead holding does not hold an engine slot, and is reported as dead, not open", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3", maxOpen: 1 });
      await signal(desk);
      expect(buys()).toHaveLength(1);
      expect(desk.strategyView().live).toMatchObject({ open: 1, dead: 0 });
      // The coin is rugged: no sell route. It stays on the book.
      (desk as unknown as { noRoute: Set<string> }).noRoute.add(`live:${MINT}`);
      expect(desk.strategyView().live).toMatchObject({ open: 0, dead: 1 });
      await signal(desk, young({ mint: "EngineLive444444444444444444444444444444444", symbol: "EL4" }));
      expect(buys()).toHaveLength(2);
      expect(desk.liveBook!.positions.size).toBe(2);
      expect(desk.strategyView().live).toMatchObject({ open: 1, dead: 1 });
    } finally {
      desk.stop();
    }
  });

  it("two signals in the same pass cannot both take the last live slot", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3", maxOpen: 1 });
      const other = "EngineLive333333333333333333333333333333333";
      await desk.submitCandidate(young());
      await desk.submitCandidate(young({ mint: other, symbol: "EL3" }));
      const t = Date.now();
      for (const m of [MINT, other]) desk.strategyQuote(m, quote(t + 10_000, 1.01), t + 10_000);
      // Both signals fire before either buy has finished.
      for (const m of [MINT, other]) desk.strategyQuote(m, quote(t + 22_000, 1.025), t + 22_000);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(buys()).toHaveLength(1);
      expect(desk.liveBook!.positions.size).toBe(1);
    } finally {
      desk.stop();
    }
  });

  it("the manual live trail does not sell a live engine position before its own rules", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3-t8" });
      await signal(desk);
      const pos = desk.liveBook!.positions.get(MINT)!;
      const feed = pos.priceFeed ?? "test";
      const tick = async (priceUsd: number) => {
        desk.bus.emit("market.tick", { mint: MINT, priceUsd, liquidityUsd: 180_000, at: Date.now(), feed } as never);
        await (desk as unknown as { drain: () => Promise<void> }).drain();
      };
      // Up 2%, then back 1.5%: past the 1% manual live trail, inside the engine's 3% stop.
      await tick(1.025 * 1.02);
      await tick(1.025 * 1.02 * 0.985);
      expect(liveBroker.executeLiveSwap.mock.calls.filter((c) => c[0].side === "sell")).toHaveLength(0);
      expect(desk.liveBook!.positions.has(MINT)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("two live buys in one pass cannot both pass the daily cap", async () => {
    const desk = liveDesk();
    try {
      desk.updateSettings({ liveDailyCapUsd: 5 });
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3", maxOpen: 2 });
      const other = "EngineLive444444444444444444444444444444444";
      await desk.submitCandidate(young());
      await desk.submitCandidate(young({ mint: other, symbol: "EL4" }));
      const t = Date.now();
      for (const m of [MINT, other]) desk.strategyQuote(m, quote(t + 10_000, 1.01), t + 10_000);
      for (const m of [MINT, other]) desk.strategyQuote(m, quote(t + 22_000, 1.025), t + 22_000);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(buys()).toHaveLength(1);
      expect(desk.liveSpentTodayUsd()).toBe(5);
    } finally {
      desk.stop();
    }
  });

  it("says so everywhere once the engine can spend live", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true });
      expect(desk.snapshot().liveScope).toBe("manual");
      desk.updateStrategy({ liveVariant: "launch-3" });
      const snap = desk.snapshot();
      expect(snap.liveScope).toBe("all");
      expect(snap.wallet?.liveScopeLine).toMatch(/you and the engine \(launch-3\)/);
      expect(desk.readiness().liveScope).toBe("all");
      desk.updateStrategy({ enabled: false });
      expect(desk.snapshot().liveScope).toBe("manual");
    } finally {
      desk.stop();
    }
  });

  it("turning live off while a buy waits on the wallet cancels it before anything is sent", async () => {
    const secret = base58Encode(Keypair.generate().secretKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let slow = false;
    const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), {
      walletBalances: async () => {
        if (slow) await gate;
        return { sol: 0.5, usdc: 100, at: Date.now(), error: null };
      }
    });
    desk.setOperatorReady(true);
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      await desk.submitCandidate(young());
      const t = Date.now();
      desk.strategyQuote(MINT, quote(t + 10_000, 1.01), t + 10_000);
      slow = true;
      desk.strategyQuote(MINT, quote(t + 22_000, 1.025), t + 22_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      desk.updateStrategy({ liveVariant: null });
      release();
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      expect(buys()).toHaveLength(0);
      expect(desk.liveBook!.positions.size).toBe(0);
    } finally {
      release();
      desk.stop();
    }
  });

  it("still refuses any other AI live buy", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      const raw = desk as unknown as { executeBuy: (...args: unknown[]) => Promise<{ ok: boolean; code?: string }> };
      const meta = { variant: "launch-1", signal: "launch", stopPct: 0.01, targetNetUsd: 3, timeLimitMs: STRATEGY.launch.timeLimitMs };
      const wrongVariant = await raw.executeBuy(young(), 0.8, 5, "analyst", false, { book: "live", engineLive: true, strategy: meta });
      expect(wrongVariant).toMatchObject({ ok: false, code: "LIVE_AI_BLOCKED" });
      const noFlag = await raw.executeBuy(young(), 0.8, 5, "analyst", false, { book: "live" });
      expect(noFlag).toMatchObject({ ok: false, code: "LIVE_AI_BLOCKED" });
      expect(buys()).toHaveLength(0);
    } finally {
      desk.stop();
    }
  });

  function closed(
    desk: Desk,
    id: string,
    mode: "paper" | "live",
    pnlUsd: number
  ): void {
    const now = Date.now();
    desk.store.openTrade({ id, mint: `${id}Mint`, symbol: id.toUpperCase(), openedAt: now - 60_000, costUsd: 50, score: 0.7, mode });
    desk.store.closeTrade({
      id,
      mint: `${id}Mint`,
      symbol: id.toUpperCase(),
      openedAt: now - 60_000,
      closedAt: now - 30_000,
      costUsd: 50,
      proceedsUsd: 50 + pnlUsd,
      pnlUsd,
      pnlPct: pnlUsd / 50,
      exitCode: "STOP_LOSS",
      score: 0.7,
      mode
    });
  }

  it("paper pause tripped, live pause not tripped means live launch entry allowed and paper entry blocked", async () => {
    const desk = liveDesk();
    try {
      desk.updateSettings({ dailyMaxLossUsd: 10 });
      desk.updateStrategy({ enabled: true, liveVariant: "launch-1" });
      closed(desk, "paper-loss", "paper", -11);
      await signal(desk);
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(codes(desk)).toContain("DAILY_LOSS");
      expect(desk.snapshot().events.some((e) => /Auto-buys wait/.test(e.message))).toBe(false);
      expect(buys()).toHaveLength(1);
      expect(buys()[0]?.[0]).toMatchObject({ side: "buy", sizeUsd: 5 });
      expect(desk.liveBook!.positions.get(MINT)?.strategy?.variant).toBe("launch-1");
      expect(codes(desk)).not.toContain("ENGINE_LIVE_PAUSED");
      expect(desk.strategyView().live?.blocked).toBeNull();
    } finally {
      desk.stop();
    }
  });

  it("live pause tripped means live blocked", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-1" });
      closed(desk, "live-loss", "live", -6);
      await signal(desk);
      expect(buys()).toHaveLength(0);
      expect(desk.liveBook!.positions.has(MINT)).toBe(false);
      expect(codes(desk)).toContain("ENGINE_LIVE_PAUSED");
      expect(desk.strategyView().live?.blocked).toMatch(/\$5 live pause/);
      expect(desk.book.positions.get(MINT)?.strategy?.variant).toBe("launch-1");
      expect(codes(desk)).not.toContain("DAILY_LOSS");
    } finally {
      desk.stop();
    }
  });

  it("both clear means both allowed", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-1" });
      await signal(desk);
      expect(desk.book.positions.get(MINT)?.strategy?.variant).toBe("launch-1");
      expect(buys()).toHaveLength(1);
      expect(desk.liveBook!.positions.get(MINT)?.strategy?.variant).toBe("launch-1");
      expect(codes(desk)).not.toContain("DAILY_LOSS");
      expect(codes(desk)).not.toContain("ENGINE_LIVE_PAUSED");
      expect(desk.strategyView().live?.blocked).toBeNull();
    } finally {
      desk.stop();
    }
  });

  it("sells a live engine position at its engine stop, as a live sell", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      await signal(desk);
      expect(desk.liveBook!.positions.has(MINT)).toBe(true);
      // −4% from the signal mark: through the 3% engine stop, inside the 6% hard stop.
      const feed = desk.liveBook!.positions.get(MINT)!.priceFeed ?? "test";
      desk.bus.emit("market.tick", { mint: MINT, priceUsd: 1.025 * 0.96, liquidityUsd: 180_000, at: Date.now(), feed } as never);
      await (desk as unknown as { drain: () => Promise<void> }).drain();
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((c) => c[0].side === "sell");
      expect(sells).toHaveLength(1);
      expect(desk.liveBook!.positions.has(MINT)).toBe(false);
      expect(codes(desk)).toContain("STRATEGY_STOP");
    } finally {
      desk.stop();
    }
  });

  it("reports why live has not bought: no signal, the wrong kind, a refusal, then a buy", async () => {
    const desk = liveDesk();
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "momentum-3" });
      expect(desk.strategyView().live).toMatchObject({ signals: 0, otherSignals: 0, buys: 0, lastSkip: null, blocked: null });
      await signal(desk);
      expect(desk.strategyView().live).toMatchObject({ signals: 0, otherSignals: 1, buys: 0 });
      desk.updateStrategy({ liveVariant: "launch-3" });
      // A new live variant starts its own count: the momentum variant's tally does not carry over.
      expect(desk.strategyView().live).toMatchObject({ signals: 0, otherSignals: 0, buys: 0, lastSkip: null });
      desk.updateSettings({ liveDailyCapUsd: 5 });
      await signal(desk, young({ mint: "EngineLive555555555555555555555555555555555", symbol: "EL5" }));
      expect(desk.strategyView().live).toMatchObject({ signals: 1, buys: 1, lastSkip: null, spentTodayUsd: 5, dailyCapUsd: 5 });
      expect(desk.strategyView().live?.lastBuyAt).toBeGreaterThan(0);
      await signal(desk, young({ mint: "EngineLive666666666666666666666666666666666", symbol: "EL6" }));
      const live = desk.strategyView().live!;
      expect(live).toMatchObject({ signals: 2, buys: 1 });
      expect(live.lastSkip).toMatchObject({ symbol: "EL6", code: "LIVE_DAILY_CAP" });
      expect(live.lastSkip!.message).toMatch(/daily cap/i);
    } finally {
      desk.stop();
    }
  });

  it("paper engine buys do not use up the live hourly limit", async () => {
    const desk = liveDesk();
    try {
      desk.updateSettings({ maxTradesPerHour: 1 });
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      // The paper buy for this signal is one buy this hour. Before 13.44 that alone refused the live buy.
      await signal(desk);
      expect(buys()).toHaveLength(1);
      expect(desk.liveBook!.positions.has(MINT)).toBe(true);
      // The live limit still counts live buys.
      await signal(desk, young({ mint: "EngineLive777777777777777777777777777777777", symbol: "EL7" }));
      expect(buys()).toHaveLength(1);
      expect(desk.strategyView().live?.lastSkip).toMatchObject({ symbol: "EL7", code: "TRADE_RATE" });
    } finally {
      desk.stop();
    }
  });
});
