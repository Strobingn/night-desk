import { describe, expect, it } from "vitest";
import { Desk } from "../src/desk/orchestrator.js";
import { DeskStore } from "../src/store/db.js";
import { testConfig } from "./helpers.js";

/**
 * Oracle preflight: paper cash and equity 94.52 from a $100 start, no open
 * positions, maxPositionPct 0.295, positionSizeUsd null, liveTradeUsd 5,
 * liveDailyCapUsd 20, liveAutoBuy false. A restart must keep that row.
 */
describe("oracle paper prefs survive a restart", () => {
  it("keeps the 94.52 book and does not move the saved caps back", () => {
    const cfg = testConfig({ resetPaper: false, startingBalanceUsd: 100, demoFeed: false, feedMode: "live" });
    const store = new DeskStore(cfg.dbPath, cfg.jsonlPath, cfg.logPath);
    store.saveBook({
      cashUsd: 94.52,
      startingBalanceUsd: 100,
      startedAt: 1_700_000_000_000,
      positions: [],
      cooldowns: []
    });
    store.writeJson("settings", {
      maxPositionPct: 0.295,
      positionSizeUsd: null,
      liveTradeUsd: 5,
      liveDailyCapUsd: 20,
      liveAutoBuy: false,
      maxExposurePct: 0.25,
      maxOpenPositions: 2,
      maxTradesPerHour: 4,
      dailyMaxLossUsd: 15,
      stopLossPct: 0.05,
      trailArmPct: 0.25,
      trailGapPct: 0.03,
      maxEntrySlippage: 0.03,
      minVolume1hUsd: 50_000,
      analystMinScore: 0.6,
      autoBuy: true,
      paperResetUsd: 100
    });
    store.close();
    const desk = new Desk(cfg);
    try {
      const snap = desk.snapshot();
      expect(snap.cashUsd).toBe(94.52);
      expect(snap.equityUsd).toBe(94.52);
      expect(desk.config.startingBalanceUsd).toBe(100);
      expect(snap.positions).toHaveLength(0);
      expect(snap.orders ?? []).toHaveLength(0);
      expect(snap.rules.maxPositionPct).toBe(0.295);
      expect(snap.rules.stopLossPct).toBe(0.05);
      expect(snap.rules.trailArmPct).toBe(0.25);
      expect(snap.rules.trailGapPct).toBe(0.03);
      expect(snap.rules.analystMinScore).toBe(0.6);
      expect(snap.rules.minVolume1hUsd).toBe(50_000);
      expect(snap.prefs.positionSizeUsd).toBeNull();
      expect(snap.prefs.liveTradeUsd).toBe(5);
      expect(snap.prefs.liveDailyCapUsd).toBe(20);
      expect(snap.prefs.liveAutoBuy).toBe(false);
      expect(snap.prefs.maxExposurePct).toBe(0.25);
      expect(snap.prefs.maxOpenPositions).toBe(2);
      expect(snap.prefs.maxTradesPerHour).toBe(4);
      expect(snap.prefs.dailyMaxLossUsd).toBe(15);
      expect(snap.prefs.autoBuy).toBe(true);
      expect(snap.mode).toBe("paper");
      expect(desk.readiness().lines.join("\n")).toMatch(/liveAutoBuy cannot be turned on/);
      expect(desk.readiness().lines.join("\n")).toMatch(/SOLANA_RPC_URL/);
      expect(desk.readiness().lines.join("\n")).toMatch(/JUPITER_QUOTE_URL/);
      expect(desk.readiness().liveTradingFlag).toBe(false);
    } finally {
      desk.stop();
    }
  });
});
