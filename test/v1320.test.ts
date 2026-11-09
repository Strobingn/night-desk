import { describe, expect, it } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { visibleEquity } from "../src/desk/equity-series.js";
import { pumpSwapNative } from "../src/market/chain-marks.js";
import { outlierReason, reanchorCandidate } from "../src/market/mark-guard.js";
import { DeskStore } from "../src/store/db.js";
import { testConfig, testDesk } from "./helpers.js";

const MINT = "PepeMint111111111111111111111111111111111";
const PAIR = "PepePool11111111111111111111111111111111";

describe("v13.20 cooldown off and sane marks", () => {
  it("treats a 1000x print as a unit error and a 50% drop as a real move", () => {
    expect(outlierReason(0.00001, 0.01)).toBe("unit");
    expect(outlierReason(0.00001, 0.5)).toBe("spike");
    expect(outlierReason(0.00001, 0.000005)).toBeNull();
    expect(outlierReason(0.00001, 0.00002)).toBeNull();
  });

  it("does not re-anchor onto a Jupiter spike", () => {
    const step = reanchorCandidate(undefined, { feed: "jupiter" }, 0.5, 0.00001, 1_000);
    expect(step.verdict).toBe("refuse");
  });

  it("drops a PumpSwap virtual reserve that is not on the same scale as the SOL vault", () => {
    const sane = pumpSwapNative(1_000_000_000, 100_000_000, 6, 0n, true);
    expect(sane).toBeCloseTo(0.0001, 8);
    expect(Number.isNaN(pumpSwapNative(1_000_000_000, 100_000_000, 6, 10n ** 24n, true))).toBe(true);
    expect(Number.isNaN(pumpSwapNative(1_000_000_000, 100_000_000, 6, -(10n ** 24n), false))).toBe(true);
  });

  it("retires a stored 6h ban and still keeps the other saved risk values", () => {
    const cfg = testConfig({ resetPaper: false });
    const store = new DeskStore(cfg.dbPath, cfg.jsonlPath, cfg.logPath);
    store.writeJson("settings", { cooldownHours: 6, stopLossPct: 0.05, maxPositionPct: 0.07 });
    store.saveBook({
      cashUsd: 1_000,
      startingBalanceUsd: 1_000,
      startedAt: Date.now(),
      positions: [],
      cooldowns: [[MINT, Date.now() + 6 * 3_600_000]]
    });
    store.close();
    const desk = new Desk(cfg);
    try {
      expect(desk.snapshot().rules.revengeCooldownMs).toBe(0);
      expect(desk.snapshot().rules.stopLossPct).toBe(0.05);
      expect(desk.snapshot().rules.maxPositionPct).toBe(0.07);
      expect(desk.snapshot().cooldowns).toEqual([]);
      const saved = desk.store.readJson("settings") as { cooldownHours: number; cooldownRetired: boolean; stopLossPct: number };
      expect(saved.cooldownRetired).toBe(true);
      expect(saved.cooldownHours).toBe(0);
      expect(saved.stopLossPct).toBe(0.05);
    } finally {
      desk.stop();
    }
  });

  it("hides a million-dollar equity spike on read and keeps the ledger row", () => {
    const points = visibleEquity([
      { t: 1, equity: 1_000, cash: 800 },
      { t: 2, equity: 1_170_000, cash: 800 },
      { t: 3, equity: 990, cash: 800 }
    ]);
    expect(points.map((p) => p.equity)).toEqual([1_000, 990]);
    const desk = testDesk();
    try {
      const now = Date.now();
      desk.store.insertEquity({ t: now, equity: 1_000, cash: 800 });
      desk.store.insertEquity({ t: now + 1, equity: 1_170_000, cash: 800 });
      desk.store.insertEquity({ t: now + 2, equity: 990, cash: 800 });
      expect(desk.snapshot().equity.some((p) => p.equity >= 1_000_000)).toBe(false);
      expect(desk.store.equitySince(0).some((p) => p.equity === 1_170_000)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("keeps Pepetide equity sane on a pumpswap outlier and still stops a real crash", async () => {
    let dex = 0.00001;
    let jup = 0.00001;
    const desk = testDesk(
      {},
      {
        priceFetch: (async (url: string) => {
          const href = String(url);
          if (href.includes("dexscreener")) {
            return Response.json([
              {
                baseToken: { address: MINT },
                priceUsd: String(dex),
                liquidity: { usd: 180_000 },
                pairAddress: PAIR,
                dexId: "pumpswap"
              }
            ]);
          }
          return Response.json({ [MINT]: { usdPrice: jup, liquidity: 50_000 } });
        }) as typeof fetch
      }
    );
    try {
      await desk.submitCandidate(
        makeToken({
          mint: MINT,
          symbol: "PEPETIDE",
          priceUsd: 0.00001,
          liquidityUsd: 180_000,
          source: "pumpfun",
          priceFeed: "dexscreener",
          pairAddress: PAIR,
          dex: "pumpswap"
        })
      );
      expect(desk.book.positions.has(MINT)).toBe(true);
      const before = desk.snapshot().equityUsd;
      const entry = desk.book.positions.get(MINT)!.entryPrice;
      jup = 0.5;
      await desk.repricePositions();
      expect(desk.snapshot().equityUsd).toBeLessThan(before * 2);
      expect(desk.book.price(MINT)).toBeLessThan(entry * 2);
      expect(desk.snapshot().events.some((event) => event.code === "PRICE_SOURCE")).toBe(true);

      dex = 0.5;
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(true);
      expect(desk.snapshot().equityUsd).toBeLessThan(before * 2);
      expect(desk.snapshot().positions.find((p) => p.mint === MINT)?.markPrice ?? 0).toBeLessThan(entry * 2);
      expect(desk.snapshot().events.some((event) => event.code === "PRICE_OUTLIER")).toBe(true);

      dex = entry * 0.5;
      jup = entry * 0.5;
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(true);
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "STOP_LOSS" || event.code === "GAP_RUG")).toBe(true);
      expect(desk.snapshot().equityUsd).toBeLessThan(before);
      expect(desk.snapshot().equityUsd).toBeGreaterThan(100);

      await desk.submitCandidate(
        makeToken({
          mint: MINT,
          symbol: "PEPETIDE",
          priceUsd: entry,
          liquidityUsd: 180_000,
          source: "pumpfun",
          priceFeed: "dexscreener",
          pairAddress: PAIR,
          dex: "pumpswap"
        })
      );
      expect(desk.book.positions.has(MINT)).toBe(true);
      expect(desk.snapshot().cooldowns).toEqual([]);
    } finally {
      desk.stop();
    }
  });
});
