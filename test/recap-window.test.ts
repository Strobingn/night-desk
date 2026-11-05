import { describe, expect, it } from "vitest";
import { Desk } from "../src/desk/orchestrator.js";
import {
  RECAP_CLOSED_LIMIT,
  buildRecap,
  recapReport,
  resetAtFromEquity,
  resolveRecapSince
} from "../src/desk/recap.js";
import { DeskStore } from "../src/store/db.js";
import type { ClosedTrade } from "../src/types.js";
import { testConfig, testDesk } from "./helpers.js";

function trade(id: string, closedAt: number, symbol = id): ClosedTrade {
  return {
    id,
    mint: id,
    symbol,
    openedAt: closedAt - 1,
    closedAt,
    costUsd: 800,
    proceedsUsd: 700,
    pnlUsd: -100,
    pnlPct: -0.125,
    exitCode: "STOP_LOSS",
    score: 0.5,
    mode: "paper"
  };
}

describe("recap stays on the current book", () => {
  it("finds the $10,000 to $100 stamp and ignores a drift around $100", () => {
    const jump = resetAtFromEquity([
      { t: 1_000, equity: 10_000, cash: 10_000 },
      { t: 2_000, equity: 9_200, cash: 8_400 },
      { t: 3_000, equity: 100, cash: 100 },
      { t: 4_000, equity: 92, cash: 92 }
    ]);
    expect(jump).toBe(3_000);
    expect(
      resetAtFromEquity([
        { t: 1, equity: 100, cash: 100 },
        { t: 2, equity: 108, cash: 108 },
        { t: 3, equity: 97, cash: 97 }
      ])
    ).toBeNull();
  });

  it("clips 24h and 7d to the reset and treats Since reset as that instant", () => {
    const now = 1_000_000_000;
    const floor = now - 60 * 60_000;
    expect(resolveRecapSince("24h", floor, now)).toBe(floor);
    expect(resolveRecapSince("7d", floor, now)).toBe(floor);
    expect(resolveRecapSince("reset", floor, now)).toBe(floor);
    expect(resolveRecapSince("12h", floor - 86_400_000, now)).toBe(now - 12 * 3_600_000);
  });

  it("ships a summary and the last 50 closes, not every win list", () => {
    const closed = Array.from({ length: 80 }, (_, i) => trade(`t${i}`, i + 1, i === 10 ? "DUBBLE" : `N${i}`));
    const report = recapReport(
      buildRecap({
        since: 0,
        until: 100,
        events: [],
        equity: [
          { t: 1, equity: 100, cash: 100 },
          { t: 90, equity: 92, cash: 92 }
        ],
        closed,
        open: [],
        startingBalanceUsd: 100
      })
    );
    expect(report.closedCount).toBe(80);
    expect(report.closed).toHaveLength(RECAP_CLOSED_LIMIT);
    expect(report.closed[0]?.id).toBe("t30");
    expect(report.closed.some((row) => row.symbol === "DUBBLE")).toBe(false);
    expect(report.winCount).toBe(0);
    expect(report.lossCount).toBe(80);
    expect(report.text).toContain("Recent closes: last 50 of 80");
    expect(report.text).toContain("Starting equity: $100.00");
    const body = report as unknown as Record<string, unknown>;
    expect(body.wins).toBeUndefined();
    expect(body.losses).toBeUndefined();
    expect(JSON.stringify(report).length).toBeLessThan(40_000);
  });

  it("backfills resetAt from the equity jump and leaves the old $800 book out of a 24h recap", () => {
    const cfg = testConfig({ resetPaper: false });
    const now = Date.now();
    const jump = now - 30 * 60_000;
    const seed = new DeskStore(cfg.dbPath, cfg.jsonlPath, cfg.logPath);
    seed.insertEquity({ t: jump - 20 * 3_600_000, equity: 10_000, cash: 10_000 });
    seed.insertEquity({ t: jump - 3_600_000, equity: 9_200, cash: 8_400 });
    seed.insertEquity({ t: jump, equity: 100, cash: 100 });
    seed.insertEquity({ t: now - 1_000, equity: 92, cash: 92 });
    seed.saveBook({
      cashUsd: 92,
      startingBalanceUsd: 100,
      startedAt: jump - 7 * 86_400_000,
      positions: [],
      cooldowns: []
    });
    seed.openTrade({ id: "old", mint: "dub", symbol: "DUBBLE", openedAt: jump - 4_000, costUsd: 800, score: 0.4, mode: "paper" });
    seed.closeTrade(trade("old", jump - 2_000, "DUBBLE"));
    seed.openTrade({ id: "new", mint: "new", symbol: "AFTER", openedAt: jump + 1_000, costUsd: 8, score: 0.4, mode: "paper" });
    seed.closeTrade({ ...trade("new", jump + 2_000, "AFTER"), costUsd: 8, proceedsUsd: 7, pnlUsd: -1, pnlPct: -0.125 });
    seed.close();

    const desk = new Desk(cfg);
    try {
      expect(desk.store.readJson("resetAt")).toBe(jump);
      const report = desk.recap("24h");
      expect(report.since).toBe(jump);
      expect(report.startingEquity).toBe(100);
      expect(report.endingEquity).toBe(92);
      expect(report.pnlUsd).toBeCloseTo(-8, 5);
      expect(report.closed.map((row) => row.symbol)).toEqual(["AFTER"]);
      expect(report.text).not.toContain("DUBBLE");
      expect(report.text).toContain("AFTER");
      const week = desk.recap("7d");
      expect(week.since).toBe(jump);
      expect(week.closed.map((row) => row.symbol)).toEqual(["AFTER"]);
      expect(desk.recap("reset").since).toBe(jump);
    } finally {
      desk.stop();
    }
  });

  it("moves the floor forward when the paper book is reset", () => {
    const desk = testDesk();
    try {
      const old = Date.now() - 3_600_000;
      desk.store.insertEquity({ t: old, equity: 10_000, cash: 10_000 });
      desk.store.openTrade({ id: "old", mint: "dub", symbol: "DUBBLE", openedAt: old, costUsd: 800, score: 0.4, mode: "paper" });
      desk.store.closeTrade(trade("old", old + 1_000, "DUBBLE"));
      const before = Date.now();
      const reset = desk.resetPaperBook(true);
      expect(reset.ok).toBe(true);
      const marker = desk.store.readJson("resetAt");
      expect(typeof marker).toBe("number");
      expect(marker as number).toBeGreaterThanOrEqual(before);
      const report = desk.recap("24h");
      expect(report.since).toBe(marker);
      expect(report.startingEquity).toBe(100);
      expect(report.closed).toHaveLength(0);
      expect(report.text).not.toContain("DUBBLE");
      expect(report.pnlUsd).toBe(0);
    } finally {
      desk.stop();
    }
  });
});
