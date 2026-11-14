import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { clampLiveDailyCapUsd } from "../src/rules.js";
import {
  LIVE_SURVIVAL_MS,
  LIVE_SURVIVAL_QUOTE_GRACE_MS,
  noteSurvival,
  SurvivalWindow,
  OVERNIGHT_RUGS,
  OVERNIGHT_SURVIVORS,
  overnightBlocked,
  overnightCoins,
  overnightSurvivor
} from "../src/strategy/live-rug-gate.js";
import { engineSellRouteStub, holdLiveEntryRead, testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", async () => {
  const actual = await vi.importActual<typeof import("../src/market/live-broker.js")>("../src/market/live-broker.js");
  return { ...actual, executeLiveSwap: liveBroker.executeLiveSwap };
});

const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 500, at: Date.now(), error: null });

function liveDesk(): Desk {
  const secret = JSON.stringify([...Keypair.generate().secretKey]);
  const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: rich, sellRoute: engineSellRouteStub });
  holdLiveEntryRead(desk);
  desk.setOperatorReady(true);
  desk.updateStrategy({ enabled: true, liveVariant: "launch-1", maxOpen: 2 });
  return desk;
}

const quote = (at: number, priceUsd: number, liquidityUsd: number | null = 180_000) => ({
  at,
  priceUsd,
  vol5mUsd: 40_000,
  vol1hUsd: 180_000,
  change1hPct: 15,
  liquidityUsd
});

async function arm(desk: Desk, mint: string, symbol: string, over: Parameters<typeof makeToken>[0] = {}): Promise<number> {
  const token = makeToken({
    mint,
    symbol,
    priceUsd: 1,
    ageSeconds: 30,
    volume5mUsd: 40_000,
    liquidityUsd: 180_000,
    discoveredAt: Date.now(),
    devWallet: mint,
    ...over
  });
  await desk.submitCandidate(token);
  const t = Date.now();
  await desk.submitStrategyQuote(mint, quote(t + 10_000, 1.01), t + 10_000);
  await desk.submitStrategyQuote(mint, quote(t + 22_000, 1.025), t + 22_000);
  return t + 22_000;
}

const buys = () => liveBroker.executeLiveSwap.mock.calls.filter((call) => call[0].side === "buy");

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number; markPriceUsd?: number }) =>
    req.side === "buy"
      ? { signature: "sig-buy", fillPriceUsd: (req.markPriceUsd ?? 1) * 1.005, qty: (req.sizeUsd ?? 5) / ((req.markPriceUsd ?? 1) * 1.005), notionalUsd: req.sizeUsd ?? 5, feeUsd: 0.01, slippage: 0.005 }
      : { signature: "sig-sell", fillPriceUsd: req.markPriceUsd ?? 1, qty: req.qty ?? 0, notionalUsd: req.qty ?? 0, feeUsd: 0.01, slippage: 0.02 }
  );
});

describe("v13.57 engine live rug gate", () => {
  it("does not live-buy on the signal, then buys once the pool has stayed liquid", async () => {
    const desk = liveDesk();
    try {
      const mint = "Survive111111111111111111111111111111111";
      const signalAt = await arm(desk, mint, "HOLD");
      expect(buys()).toHaveLength(0);
      expect(desk.book.positions.has(mint)).toBe(true);
      const confirm = signalAt + LIVE_SURVIVAL_MS;
      await desk.submitStrategyQuote(mint, quote(confirm, 1.1), confirm);
      expect(buys()).toHaveLength(1);
      expect(buys()[0]?.[0].markPriceUsd).toBe(1.1);
      expect(desk.liveBook!.positions.has(mint)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("refuses when liquidity drops more than 20% or the pool is younger than the window", async () => {
    const desk = liveDesk();
    try {
      const mint = "DropRug11111111111111111111111111111111";
      const signalAt = await arm(desk, mint, "DROP");
      const confirm = signalAt + LIVE_SURVIVAL_MS;
      await desk.submitStrategyQuote(mint, quote(confirm, 1.03, 100_000), confirm);
      expect(buys()).toHaveLength(0);
      expect(desk.strategyView().live?.lastSkip?.message).toMatch(/Liquidity dropped/);
    } finally {
      desk.stop();
    }
  });

  it("fails closed when LP, freeze, the sell route, or the bundle is unverified", async () => {
    const desk = liveDesk();
    try {
      const unlocked = "Unlock111111111111111111111111111111111";
      const signalAt = await arm(desk, unlocked, "UNLOCK", { lpLockedOrBurned: null, onBondingCurve: true });
      const confirm = signalAt + LIVE_SURVIVAL_MS;
      await desk.submitStrategyQuote(unlocked, quote(confirm, 1.03), confirm);
      expect(buys()).toHaveLength(0);
      expect(desk.strategyView().live?.lastSkip?.message).toMatch(/LP lock unverified/);

      desk.sellRouteOverride = async () => "unknown";
      const mint = "NoRoute11111111111111111111111111111111";
      const at = await arm(desk, mint, "NORTE");
      await desk.submitStrategyQuote(mint, quote(at + LIVE_SURVIVAL_MS, 1.03), at + LIVE_SURVIVAL_MS);
      expect(buys()).toHaveLength(0);
      expect(desk.strategyView().live?.lastSkip?.message).toMatch(/Sell route unverified/);
    } finally {
      desk.stop();
    }
  });

  it("still lets a manual live buy through while the engine is waiting", async () => {
    const desk = liveDesk();
    try {
      const mint = "Manual111111111111111111111111111111111";
      await arm(desk, mint, "HAND", { lpLockedOrBurned: null, ageSeconds: 8, freezeAuthorityRevoked: false });
      expect(buys()).toHaveLength(0);
      expect((await desk.manualBuy(mint, 5, { book: "live" })).ok).toBe(true);
      expect(buys()).toHaveLength(1);
    } finally {
      desk.stop();
    }
  });

  it("refuses a later engine live buy from a deployer whose pool already died", async () => {
    const desk = liveDesk();
    try {
      const first = "RugDev111111111111111111111111111111111";
      const dev = "DevWallet111111111111111111111111111111";
      const signalAt = await arm(desk, first, "DEAD", { devWallet: dev });
      const confirm = signalAt + LIVE_SURVIVAL_MS;
      await desk.submitStrategyQuote(first, quote(confirm, 1.03), confirm);
      expect(buys()).toHaveLength(1);
      (desk as unknown as { sightings: Map<string, unknown> }).sightings.delete(first);
      desk.liveBook!.mark(first, 1e-18, Date.now());
      const next = "NextDev11111111111111111111111111111111";
      const at = await arm(desk, next, "NEXT", { devWallet: dev });
      await desk.submitStrategyQuote(next, quote(at + LIVE_SURVIVAL_MS, 1.03), at + LIVE_SURVIVAL_MS);
      expect(buys()).toHaveLength(1);
      expect(desk.strategyView().live?.lastSkip?.message).toMatch(/rug list/);
    } finally {
      desk.stop();
    }
  });

  function gapsOf(step: number): number[] {
    const gaps: number[] = [];
    for (let covered = 0; covered < LIVE_SURVIVAL_MS + step; covered += step) gaps.push(step);
    return gaps;
  }

  /** Poll expire every 2s between quotes, the way strategyPass does. A short window must stay open. */
  function survivesCadence(gaps: number[]): boolean {
    const window = new SurvivalWindow<string>();
    let at = 0;
    window.note("m", { at, liquidityUsd: 20_000, ageSeconds: 120 }, at, "fired", 1);
    for (const gap of gaps) {
      const next = at + gap;
      for (let now = at + 2_000; now < next; now += 2_000) {
        if (window.expire(now).length) return false;
      }
      at = next;
      const status = window.note("m", { at, liquidityUsd: 20_000, ageSeconds: 120 }, at, "fired", 1.03);
      if (status.status === "fail") return false;
      if (status.status === "ready") return window.has("m");
    }
    return false;
  }

  async function armPool(desk: Desk, mint: string, liquidityUsd: number): Promise<number> {
    const token = makeToken({
      mint,
      symbol: mint.slice(0, 6),
      priceUsd: 1,
      ageSeconds: 120,
      volume5mUsd: 40_000,
      liquidityUsd,
      discoveredAt: Date.now(),
      devWallet: mint
    });
    await desk.submitCandidate(token);
    const t = Date.now();
    await desk.submitStrategyQuote(mint, quote(t + 10_000, 1.01, liquidityUsd), t + 10_000);
    await desk.submitStrategyQuote(mint, quote(t + 22_000, 1.025, liquidityUsd), t + 22_000);
    return t + 22_000;
  }

  async function buysOnCadence(mint: string, gaps: number[]): Promise<void> {
    liveBroker.executeLiveSwap.mockClear();
    const desk = liveDesk();
    desk.liveEntryRead = async () => ({ priceUsd: 1.4, liquidityUsd: 20_000 });
    try {
      expect(survivesCadence(gaps)).toBe(true);
      let at = await armPool(desk, mint, 20_000);
      expect(buys()).toHaveLength(0);
      for (const gap of gaps) {
        const next = at + gap;
        for (let now = at + 2_000; now < next; now += 2_000) desk.strategyPass(now);
        at = next;
        await desk.submitStrategyQuote(mint, quote(at, 1.03, 20_000), at);
        if (buys().length) break;
      }
      expect(buys()).toHaveLength(1);
      expect(buys()[0]?.[0].markPriceUsd).toBe(1.4);
      expect(desk.strategyView().live?.lastSkip?.message ?? "").not.toMatch(/not rechecked/);
    } finally {
      desk.stop();
    }
  }

  it("buys a stable $20k pool when Tape quotes arrive every 16s, every 8s, or on a jittered gap", async () => {
    const jitter = [11_000, 15_000, 7_000, 16_000, 9_000, 14_000, 12_000, 8_000, 13_000];
    expect(jitter.reduce((sum, gap) => sum + gap, 0)).toBeGreaterThan(LIVE_SURVIVAL_MS);
    await buysOnCadence("Cad16s111111111111111111111111111111111", gapsOf(16_000));
    await buysOnCadence("Cad08s111111111111111111111111111111111", gapsOf(8_000));
    await buysOnCadence("CadJit111111111111111111111111111111111", jitter);
  });

  it("waits out one Tape gap after 90s, then gives up", () => {
    const window = new SurvivalWindow<string>();
    window.note("m", { at: 0, liquidityUsd: 20_000, ageSeconds: 120 }, 0, "fired", 1);
    window.note("m", { at: 80_000, liquidityUsd: 20_000, ageSeconds: 120 }, 80_000, "fired", 1);
    expect(window.expire(LIVE_SURVIVAL_MS + LIVE_SURVIVAL_QUOTE_GRACE_MS - 1_000)).toHaveLength(0);
    expect(window.has("m")).toBe(true);
    expect(window.expire(LIVE_SURVIVAL_MS + LIVE_SURVIVAL_QUOTE_GRACE_MS + 1)).toHaveLength(1);
  });

  it("refuses when the pool drains between the last window sample and the lock read", async () => {
    const desk = liveDesk();
    desk.liveEntryRead = async () => ({ priceUsd: 1.4, liquidityUsd: 1_000 });
    try {
      const mint = "Drain1111111111111111111111111111111111";
      const signalAt = await armPool(desk, mint, 20_000);
      await desk.submitStrategyQuote(mint, quote(signalAt + LIVE_SURVIVAL_MS, 1.03, 20_000), signalAt + LIVE_SURVIVAL_MS);
      expect(buys()).toHaveLength(0);
      expect(desk.strategyView().live?.lastSkip?.message).toMatch(/Liquidity dropped|under the live floor/);
    } finally {
      desk.stop();
    }
  });

  it("blocks all 18 overnight rugs and does not block the two that closed", () => {
    const coins = overnightCoins();
    const rugs = coins.filter((coin) => coin.kind === "rug");
    const survivors = coins.filter((coin) => coin.kind === "survivor");
    expect(rugs.map((coin) => coin.symbol)).toEqual([...OVERNIGHT_RUGS]);
    expect(survivors.map((coin) => coin.symbol)).toEqual([...OVERNIGHT_SURVIVORS]);
    const blockedRugs = rugs.filter((coin) => overnightBlocked(coin).blocked);
    const blockedSurvivors = survivors.filter((coin) => overnightBlocked(coin).blocked);
    expect(blockedRugs).toHaveLength(18);
    expect(blockedSurvivors).toHaveLength(0);
    const stillOnTheCurve = overnightSurvivor("CRED");
    stillOnTheCurve.facts.lpLockedOrBurned = null;
    expect(overnightBlocked(stillOnTheCurve).blocked).toBe(true);
    let dipped = noteSurvival(undefined, { at: 0, liquidityUsd: 11_000, ageSeconds: 30 }, 0);
    dipped = noteSurvival(dipped.track, { at: 30_000, liquidityUsd: 9_500, ageSeconds: 30 }, 30_000);
    expect(dipped.result).toMatchObject({ status: "fail", reason: "Liquidity is under the live floor." });
    expect(clampLiveDailyCapUsd(500)).toBe(500);
    expect(clampLiveDailyCapUsd(100_000)).toBe(100_000);
  });
});
