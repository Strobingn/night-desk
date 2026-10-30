import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { acceptAdviceLine, phraseAdvice } from "../src/desk/commentary.js";
import { advise, emptyMemory, noteEntry, noteOutcome, type FeatureSample } from "../src/desk/advisor.js";
import { bestDexPrices } from "../src/market/marks.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { startServer } from "../src/server/http.js";
import { HARD_RULES, clampVolumeUsd } from "../src/rules.js";
import { testConfig, testDesk } from "./helpers.js";

describe("manual close, log, and commentary", () => {
  it("closes a winner from the API without banning the mint", async () => {
    const cfg = testConfig();
    const desk = new Desk(cfg);
    const mint = "ManualMint111111111111111111111111111111";
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "HOLD", priceUsd: 1 }));
      await desk.markPrice(mint, 1.4);
      expect(desk.book.positions.has(mint)).toBe(true);

      const denied = await fetch(`http://127.0.0.1:${port}/api/positions/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint: "missing" })
      });
      expect(denied.status).toBe(404);

      const closed = await fetch(`http://127.0.0.1:${port}/api/positions/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint })
      });
      expect(closed.status).toBe(200);
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "MANUAL_CLOSE")).toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "REVENGE_COOLDOWN")).toBe(false);

      await desk.submitCandidate(makeToken({ mint, symbol: "HOLD", priceUsd: 1 }));
      expect(desk.book.positions.has(mint)).toBe(true);

      const log = readFileSync(cfg.logPath, "utf8");
      expect(log).toMatch(/system\tinfo\tMANUAL_CLOSE\tHOLD/);
      expect(log).toMatch(/Manual close requested/);

      const events = await fetch(`http://127.0.0.1:${port}/api/events?limit=50&stage=system`);
      const body = (await events.json()) as { events: Array<{ stage: string; message: string }> };
      expect(events.status).toBe(200);
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.every((event) => event.stage === "system")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });

  it("comments on the tape and does not sell", async () => {
    const desk = testDesk();
    const mint = "NoteMint11111111111111111111111111111111";
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "HOLD", priceUsd: 1 }));
      await desk.markPrice(mint, 1.25);
      const notes = await desk.commentOnce();
      expect(notes.some((note) => /Hold HOLD/.test(note) && /Hard stop/.test(note))).toBe(true);
      expect(desk.snapshot().advice.some((note) => note.stance === "hold")).toBe(true);
      expect(desk.book.positions.has(mint)).toBe(true);
      expect(desk.snapshot().pipeline.fills).toBe(1);
    } finally {
      desk.stop();
    }
  });

  it("learns a weak bucket and will not turn advice into an order", async () => {
    const sample: FeatureSample = {
      volume1hUsd: 180_000,
      top10HolderPct: 0.04,
      liquidityUsd: 180_000,
      ageSeconds: 5_000,
      onBondingCurve: false
    };
    const memory = emptyMemory();
    for (let i = 0; i < 5; i += 1) {
      noteEntry(memory, `m${i}`, "LOST", sample);
      noteOutcome(memory, `m${i}`, -0.06, false);
    }
    const notes = advise(memory, {
      positions: [],
      sessionKills: { VOLUME_TOO_LOW: 8, HOLDER_CONCENTRATION: 2 },
      weak: { mint: "new", symbol: "NEW", score: 0.72, sample }
    });
    expect(notes.some((note) => /VOLUME_TOO_LOW/.test(note.text) && note.stance === "watch")).toBe(true);
    expect(notes.some((note) => note.stance === "skip" && /weak survivor NEW/.test(note.text))).toBe(true);

    const rich = advise(emptyMemory(), {
      positions: [
        {
          mint: "m",
          symbol: "DUB",
          pnlPct: 1.31,
          markPrice: 0.0008697,
          stopPrice: 0.000376 * 0.94,
          entryPrice: 0.000376,
          entryLiquidityUsd: 80_000,
          markLiquidityUsd: 20_000,
          score: 0.8
        }
      ]
    });
    expect(rich[0]?.stance).toBe("sell");
    expect(rich[0]?.text).toMatch(/Consider selling DUB/);
    expect(rich[0]?.text).toMatch(/liquidity thinning/);

    const echoed = await phraseAdvice(["Consider selling DUB — up +131%."], {
      apiKey: "test",
      fetchImpl: async () => Response.json({ choices: [{ message: { content: "Sold DUB at market." } }] })
    });
    expect(echoed).toEqual(["Consider selling DUB — up +131%."]);
    expect(acceptAdviceLine("Sold DUB at market.")).toBe(false);
  });

  it("resets a paper book to $100 and keeps the log, advisor file, and volume floor", async () => {
    expect(HARD_RULES.paperStartingUsd).toBe(100);
    const cfg = testConfig();
    const desk = new Desk(cfg);
    const mint = "ResetMint111111111111111111111111111111";
    try {
      expect(desk.snapshot().startingBalanceUsd).toBe(10_000);
      expect(desk.config.mode).toBe("paper");
      expect(desk.config.liveRequested).toBe(false);
      desk.setMinVolume(12_000);
      await desk.submitCandidate(makeToken({ mint, symbol: "RESET", priceUsd: 1 }));
      expect(desk.book.positions.has(mint)).toBe(true);
      const before = desk.store.queryEvents({ limit: 50 }).length;
      expect(before).toBeGreaterThan(0);
      const advisorBefore = readFileSync(cfg.advisorPath, "utf8");

      const refused = desk.resetPaperBook(false);
      expect(refused.ok).toBe(false);
      expect(desk.book.positions.has(mint)).toBe(true);

      desk.config.mode = "live";
      const live = desk.resetPaperBook(true);
      expect(live.ok).toBe(false);
      expect(desk.book.positions.has(mint)).toBe(true);
      desk.config.mode = "paper";

      const done = desk.resetPaperBook(true);
      expect(done).toEqual({ ok: true, cashUsd: 100, startingBalanceUsd: 100 });
      const snap = desk.snapshot();
      expect(snap.cashUsd).toBe(100);
      expect(snap.equityUsd).toBe(100);
      expect(snap.startingBalanceUsd).toBe(100);
      expect(snap.sessionPnlUsd).toBe(0);
      expect(snap.positions).toEqual([]);
      expect(snap.mode).toBe("paper");
      expect(snap.liveRequested).toBe(false);
      expect(snap.rules.minVolume1hUsd).toBe(12_000);
      expect(desk.store.queryEvents({ limit: 80 }).length).toBeGreaterThan(before);
      expect(readFileSync(cfg.advisorPath, "utf8")).toBe(advisorBefore);
      expect(snap.events.some((event) => event.message.includes("Paper book reset to $100.00"))).toBe(true);
    } finally {
      desk.stop();
    }

    const again = new Desk({ ...cfg, resetPaper: false });
    try {
      expect(again.snapshot().cashUsd).toBe(100);
      expect(again.snapshot().startingBalanceUsd).toBe(100);
      expect(again.snapshot().positions).toEqual([]);
      expect(again.snapshot().rules.minVolume1hUsd).toBe(12_000);
    } finally {
      again.stop();
    }
  });

  it("boots at a $10k volume floor, then the next filter uses a saved lower line", async () => {
    expect(clampVolumeUsd(50)).toBe(1_000);
    expect(clampVolumeUsd(9_000_000)).toBe(500_000);
    expect(clampVolumeUsd(Number.NaN)).toBe(10_000);

    const cfg = testConfig();
    const desk = new Desk(cfg);
    const quiet = "QuietVol1111111111111111111111111111111";
    try {
      expect(desk.snapshot().rules.minVolume1hUsd).toBe(10_000);
      expect(desk.snapshot().rules.analystMinScore).toBe(0.5);
      expect(desk.snapshot().rules.maxTop10Pct).toBe(0.35);
      expect(desk.snapshot().rules.stopLossPct).toBe(0.06);
      await desk.submitCandidate(makeToken({ mint: quiet, symbol: "QUIET", volume1hUsd: 4_000 }));
      expect(desk.snapshot().events.some((event) => event.mint === quiet && event.code === "VOLUME_TOO_LOW")).toBe(true);

      const lowered = desk.setMinVolume(1_000);
      expect(lowered.ok).toBe(true);
      if (lowered.ok) expect(lowered.minVolume1hUsd).toBe(1_000);
      expect(desk.snapshot().rules.minVolume1hUsd).toBe(1_000);

      const louder = "LouderVol111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: louder, symbol: "LOUD", volume1hUsd: 4_000 }));
      expect(desk.snapshot().events.some((event) => event.mint === louder && event.code === "VOLUME_TOO_LOW")).toBe(false);
      expect(desk.snapshot().events.some((event) => event.mint === louder && event.stage === "filter" && event.kind === "pass")).toBe(true);
    } finally {
      desk.stop();
    }

    const again = new Desk({ ...cfg, resetPaper: false });
    try {
      expect(again.snapshot().rules.minVolume1hUsd).toBe(1_000);
    } finally {
      again.stop();
    }
  });

  it("picks the deepest Dex pair for an open mint", () => {
    const best = bestDexPrices([
      { baseToken: { address: "MintA" }, priceUsd: "0.1", liquidity: { usd: 100 } },
      { baseToken: { address: "MintA" }, priceUsd: "0.5", liquidity: { usd: 40_000 } },
      { baseToken: { address: "MintB" }, priceUsd: "0", liquidity: { usd: 9_000 } }
    ]);
    expect(best.get("MintA")).toEqual({ priceUsd: 0.5, liquidityUsd: 40_000 });
    expect(best.has("MintB")).toBe(false);
  });
});
