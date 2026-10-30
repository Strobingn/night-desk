import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { assessPosition } from "../src/agents/risk.js";
import { evaluateFilter } from "../src/agents/filter.js";
import { parseDexPaprika } from "../src/market/listings.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { resolveRules } from "../src/rules.js";
import { testConfig, testDesk } from "./helpers.js";

const rules = resolveRules({});
const clean = { status: "clean" as const };

describe("v10 settings stay fail-closed", () => {
  it("keeps every previous setting and adds the new gates", () => {
    const desk = testDesk();
    try {
      const before = desk.updateSettings({ minVolume1hUsd: 12_000 });
      expect(before.ok).toBe(true);
      const saved = desk.updateSettings({
        minLiquidityUsd: 50_000,
        minTokenAgeMin: 30,
        maxTokenAgeMin: 0,
        minHolderCount: 100,
        maxDevHoldingPct: 20,
        maxTradesPerHour: 4,
        dailyMaxLossUsd: 25,
        cooldownHours: 8,
        stopLossPct: 4,
        trailArmPct: 15,
        trailGapPct: 2,
        trailTakeProfit: false,
        autoBuy: false,
        scoutDexscreener: true,
        scoutGecko: false,
        scoutJupiter: true,
        scoutDexpaprika: true,
        scoutBitquery: false,
        notifyNearMiss: false,
        notifyFills: true,
        notifyStops: true,
        pnlAlertPct: 5,
        defaultBuyUsd: 12,
        maxOpenPositions: 4,
        allowUnlockedLp: true,
        analystMinScore: 0.55,
        maxTop10Pct: 30,
        maxPositionPct: 5,
        maxEntrySlippage: 1
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.settings.minVolume1hUsd).toBe(12_000);
      expect(saved.settings.analystMinScore).toBe(0.55);
      expect(saved.settings.maxTop10Pct).toBe(0.3);
      expect(saved.settings.maxPositionPct).toBe(0.05);
      expect(saved.settings.maxEntrySlippage).toBe(0.01);
      expect(saved.settings.defaultBuyUsd).toBe(12);
      expect(saved.settings.maxOpenPositions).toBe(4);
      expect(saved.settings.allowUnlockedLp).toBe(true);
      expect(saved.settings.minLiquidityUsd).toBe(50_000);
      expect(saved.settings.stopLossPct).toBe(0.04);
      expect(saved.settings.cooldownHours).toBe(8);
      expect(saved.settings.autoBuy).toBe(false);
      expect(saved.settings.trailTakeProfit).toBe(false);
      expect(saved.settings.scoutDexpaprika).toBe(true);
      expect(saved.settings.scoutGecko).toBe(false);
      expect(desk.snapshot().prefs.autoBuy).toBe(false);
      expect(desk.snapshot().rules.stopLossPct).toBe(0.04);

      const loose = desk.updateSettings({ stopLossPct: 8 });
      expect(loose.ok).toBe(false);
      expect(desk.snapshot().rules.stopLossPct).toBe(0.04);
      const shortBan = desk.updateSettings({ cooldownHours: 2 });
      expect(shortBan.ok).toBe(false);
      expect(desk.snapshot().rules.revengeCooldownMs).toBe(8 * 3_600_000);
      const easyTrail = desk.updateSettings({ trailArmPct: 5 });
      expect(easyTrail.ok).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("fails closed on the new filter floors and leaves them off at zero", () => {
    const token = makeToken({ liquidityUsd: 1_000, ageSeconds: 60, holderCount: 4, devHoldingPct: 0.4 });
    expect(evaluateFilter(token, clean, rules).decision).toBe("pass");
    const gated = evaluateFilter(token, clean, rules, {
      minLiquidityUsd: 10_000,
      minAgeSeconds: 30 * 60,
      maxAgeSeconds: 7 * 24 * 60 * 60,
      minHolderCount: 50,
      maxDevHoldingPct: 0.2
    });
    const codes = gated.reasons.map((reason) => reason.code);
    expect(codes).toEqual(expect.arrayContaining(["LIQUIDITY_TOO_THIN", "TOKEN_TOO_NEW", "HOLDER_COUNT", "DEV_HOLDING"]));
    const unknown = evaluateFilter(makeToken({ devHoldingPct: null, holderCount: null }), clean, rules, {
      maxDevHoldingPct: 0.1,
      minHolderCount: 10
    });
    expect(unknown.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["DEV_HOLDING", "HOLDER_COUNT"]));
  });

  it("pauses auto-buys and still allows a manual buy", async () => {
    const desk = testDesk();
    try {
      desk.updateSettings({ autoBuy: false, maxTradesPerHour: 1, dailyMaxLossUsd: 0 });
      const mint = "AutoMint11111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint, symbol: "AUTO" }));
      expect(desk.book.positions.has(mint)).toBe(false);
      const manual = await desk.manualBuy(mint, 10);
      expect(manual.ok).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("does not trail-sell until the toggle is on", () => {
    const pos = { entryPrice: 1, peakPrice: 1.2, trailArmed: true };
    const held = assessPosition(pos, 1.1, rules);
    expect(held.action).toBe("hold");
    const sold = assessPosition(pos, 1.1, rules, { trailExits: true });
    expect(sold.action).toBe("stop");
    expect(sold.code).toBe("TRAIL_STOP");
    const hard = assessPosition(pos, 0.9, rules, { trailExits: true });
    expect(hard.code).toBe("STOP_LOSS");
  });

  it("reads a DexPaprika pool list and ignores quote mints", () => {
    const rows = parseDexPaprika({
      pools: [
        {
          dex_name: "meteora",
          price_usd: 0.01,
          tokens: [
            { id: "So11111111111111111111111111111111111111112", symbol: "SOL" },
            { id: "PaprikaMint111111111111111111111111111111", symbol: "PAP", name: "Paprika" }
          ]
        }
      ]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe("PAP");
    expect(parseDexPaprika(null)).toEqual([]);
  });

  it("round-trips the new fields on /api/state and keeps the old ones", async () => {
    const { startServer } = await import("../src/server/http.js");
    const cfg = testConfig();
    const desk = new Desk(cfg);
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const posted = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ minLiquidityUsd: 25000, autoBuy: true, scoutDexpaprika: false, cooldownHours: 6 })
      });
      expect(posted.status).toBe(200);
      const state = await fetch(`http://127.0.0.1:${port}/api/state`);
      const body = (await state.json()) as {
        rules: { stopLossPct: number; minVolume1hUsd: number };
        prefs: { minLiquidityUsd: number; autoBuy: boolean; maxOpenPositions: number; allowUnlockedLp: boolean };
      };
      expect(body.rules.stopLossPct).toBeLessThanOrEqual(0.06);
      expect(body.rules.minVolume1hUsd).toBeGreaterThan(0);
      expect(body.prefs.minLiquidityUsd).toBe(25000);
      expect(body.prefs.autoBuy).toBe(true);
      expect(body.prefs.maxOpenPositions).toBeGreaterThan(0);
      expect(typeof body.prefs.allowUnlockedLp).toBe("boolean");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });
});
