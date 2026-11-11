import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quotePaperBuy } from "../src/agents/execution-math.js";
import { formatBuyNotice } from "../src/desk/buy-notice.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { inspectDeskKeypair } from "../src/market/wallet-status.js";
import { startServer } from "../src/server/http.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({
  executeLiveSwap: vi.fn()
}));

vi.mock("../src/market/live-broker.js", () => ({
  executeLiveSwap: liveBroker.executeLiveSwap
}));

const mint = "TapMint111111111111111111111111111111111";

function quietToken(overrides: Parameters<typeof makeToken>[0] = {}) {
  return makeToken({
    mint,
    symbol: "TAP",
    priceUsd: 1,
    liquidityUsd: 100_000,
    volume1hUsd: 100,
    ...overrides
  });
}

describe("manual buy and live-ready checklist", () => {
  beforeEach(() => {
    liveBroker.executeLiveSwap.mockReset();
  });

  it("paper-fills a scouted mint through quotePaperBuy and refuses a second add", async () => {
    const desk = new Desk(testConfig());
    try {
      expect(desk.snapshot().readiness.mode).toBe("paper");
      expect(desk.snapshot().readiness.liveTradingFlag).toBe(false);
      expect(desk.snapshot().readiness.keypairPresent).toBe(false);
      expect(desk.snapshot().readiness.walletPublicKey).toBeNull();

      const missing = await desk.manualBuy(mint, 25);
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.code).toBe("PRICE_UNAVAILABLE");
      expect(desk.book.positions.has(mint)).toBe(false);

      await desk.submitCandidate(quietToken());
      expect(desk.book.positions.has(mint)).toBe(false);

      const bought = await desk.manualBuy(mint, 25);
      expect(bought).toMatchObject({ ok: true, mint, symbol: "TAP", sizeUsd: 25, mode: "paper" });
      const quote = quotePaperBuy(1, 25, 100_000);
      expect(quote.ok).toBe(true);
      if (!quote.ok) return;
      const pos = desk.book.positions.get(mint);
      expect(pos?.qty).toBeCloseTo(quote.qty, 8);
      expect(pos?.entryPrice).toBeCloseTo(quote.fillPrice, 8);
      expect(pos?.costUsd).toBe(25);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();

      const again = await desk.manualBuy(mint, 25);
      expect(again.ok).toBe(false);
      if (!again.ok) {
        expect(again.code).toBe("NO_AVERAGE_DOWN");
        expect(again.error).toBe("Position already open. Adding to a loser or a winner is disabled.");
        expect(formatBuyNotice(again)).toBe(again.error);
      }
      expect(desk.book.positions.get(mint)?.costUsd).toBe(25);
      expect(desk.snapshot().events.some((event) => event.code === "MANUAL_BUY")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("fills an oversized manual buy at the equity cap and shows that size", async () => {
    const desk = new Desk(testConfig());
    try {
      await desk.submitCandidate(quietToken({ symbol: "inu" }));
      desk.book.cashUsd = 88.77;
      expect(desk.snapshot().positionCapUsd).toBe(7.1);
      const bought = await desk.manualBuy(mint, 10);
      expect(bought).toMatchObject({ ok: true, symbol: "inu", sizeUsd: 7.1, mode: "paper", clampedFrom: 10 });
      expect(formatBuyNotice(bought)).toBe(
        "Bought inu for $7.10 (paper). Requested $10.00 was cut to the position cap. Filter killed inu. One-hour volume is $100 (minimum $10,000). Manual paper buy goes through."
      );
      expect(desk.book.positions.get(mint)?.costUsd).toBe(7.1);
      expect(desk.snapshot().events.some((event) => event.message.includes("Refusing"))).toBe(false);
      const pos = desk.snapshot().positions[0];
      expect(pos?.stopPrice).toBeCloseTo(pos!.entryPrice * 0.94, 8);
      const omitted = await desk.manualBuy(mint);
      expect(omitted.ok).toBe(false);
      if (!omitted.ok) expect(formatBuyNotice(omitted)).toBe(omitted.error);
    } finally {
      desk.stop();
    }
  });

  it("keeps the hard stop after a manual buy and does not trail a winner", async () => {
    const desk = new Desk(testConfig());
    try {
      await desk.submitCandidate(quietToken());
      const bought = await desk.manualBuy(mint);
      expect(bought.ok).toBe(true);
      if (bought.ok) expect(bought.sizeUsd).toBe(800);
      await desk.markPrice(mint, 1.4);
      expect(desk.book.positions.has(mint)).toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "TRAIL_STOP")).toBe(false);
      await desk.markPrice(mint, 0.93);
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => (event.code === "STOP_LOSS" || event.code === "GAP_RUG"))).toBe(true);
      const banned = await desk.manualBuy(mint, 10);
      expect(banned.ok).toBe(false);
      if (!banned.ok) expect(banned.code).toBe("PRICE_CRASH");
      expect(desk.snapshot().cooldowns.some((row) => row.mint === mint)).toBe(false);
      expect(desk.book.positions.has(mint)).toBe(false);
      // v13.3: right after a 1.4 → 0.93 fall the crash guard refuses even an override.
      const tooSoon = await desk.manualBuy(mint, 10, { ignoreCooldown: true });
      expect(tooSoon).toMatchObject({ ok: false, code: "PRICE_CRASH" });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 61_000);
      const override = await desk.manualBuy(mint, 10, { ignoreCooldown: true });
      expect(override.ok).toBe(true);
    } finally {
      vi.useRealTimers();
      desk.stop();
    }
  });

  it("uses the live broker only when mode is already live", async () => {
    liveBroker.executeLiveSwap.mockResolvedValue({
      signature: "paper-test-sig",
      fillPriceUsd: 1.02,
      qty: 20,
      notionalUsd: 25,
      feeUsd: 0.03,
      slippage: 0.01
    });
    const desk = new Desk(testConfig({ mode: "live", walletKeypairPath: "/tmp/night-desk-not-used.json", liveRequested: true }), {
      walletBalances: async () => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null })
    });
    try {
      // Live buys use the live per-trade size. The client has to name the live book, and the checklist has to be on.
      desk.updateSettings({ liveTradeUsd: 25 });
      desk.setOperatorReady(true);
      await desk.submitCandidate(quietToken());
      const bought = await desk.manualBuy(mint, 25, { book: "live" });
      expect(bought).toMatchObject({ ok: true, mode: "live", sizeUsd: 25 });
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      expect(liveBroker.executeLiveSwap.mock.calls[0]?.[0]).toMatchObject({ side: "buy", mint, sizeUsd: 25 });
      expect(desk.liveBook!.positions.get(mint)?.entryPrice).toBe(1.02);
      expect(desk.snapshot().mode).toBe("live");
    } finally {
      desk.stop();
    }
  });

  it("does not let the phone set LIVE_TRADING, and shows a host keypair without its secret", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "night-desk-key-"));
    const keyPath = path.join(dir, "id.json");
    const key = Keypair.generate();
    writeFileSync(keyPath, JSON.stringify(Array.from(key.secretKey)));
    const secretNeedle = JSON.stringify(Array.from(key.secretKey).slice(0, 8));
    const status = inspectDeskKeypair(keyPath);
    expect(status).toEqual({ keypairPresent: true, walletPublicKey: key.publicKey.toBase58() });
    expect(JSON.stringify(status)).not.toContain(secretNeedle);

    const cfg = testConfig({ walletKeypairPath: keyPath });
    const desk = new Desk(cfg);
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      expect(desk.config.mode).toBe("paper");
      expect(desk.readiness().keypairPresent).toBe(true);
      expect(desk.readiness().walletPublicKey).toBe(key.publicKey.toBase58());
      expect(JSON.stringify(desk.snapshot())).not.toContain(secretNeedle);
      expect(JSON.stringify(desk.snapshot())).not.toContain(keyPath);

      const armed = await fetch(`http://127.0.0.1:${port}/api/live/ready`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorReady: true, LIVE_TRADING: true, seed: "never" })
      });
      expect(armed.status).toBe(400);
      expect(desk.config.mode).toBe("paper");
      expect(desk.config.liveRequested).toBe(false);
      expect(desk.readiness().operatorReady).toBe(false);

      const noted = await fetch(`http://127.0.0.1:${port}/api/live/ready`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorReady: true })
      });
      expect(noted.status).toBe(200);
      const notedBody = (await noted.json()) as { ok: boolean; readiness: { operatorReady: boolean; mode: string } };
      expect(notedBody.ok).toBe(true);
      expect(notedBody.readiness.operatorReady).toBe(true);
      expect(notedBody.readiness.mode).toBe("paper");
      expect(desk.config.mode).toBe("paper");

      await desk.submitCandidate(quietToken());
      const bought = await fetch(`http://127.0.0.1:${port}/api/positions/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint, sizeUsd: "10" })
      });
      expect(bought.status).toBe(200);
      const body = (await bought.json()) as { ok: boolean; mode: string; sizeUsd: number };
      expect(body).toMatchObject({ ok: true, mode: "paper", sizeUsd: 10 });
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();

      const junk = await fetch(`http://127.0.0.1:${port}/api/positions/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint, sizeUsd: "nope" })
      });
      expect(junk.status).toBe(400);
      const junkBody = (await junk.json()) as { ok: boolean; error: string };
      expect(junkBody.ok).toBe(false);
      expect(formatBuyNotice(junkBody)).toBe("sizeUsd must be a positive number of dollars, or omitted to use the position cap.");

      const stop = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxPositionPct: 4, stopLossPct: 0.2, LIVE_TRADING: true })
      });
      expect(stop.status).toBe(400);
      const stopBody = (await stop.json()) as { ok: boolean; error: string };
      expect(stopBody.error).toContain("hard stop");
      expect(desk.config.rules.stopLossPct).toBe(0.06);
      expect(desk.config.rules.maxPositionPct).toBe(0.08);
      expect(desk.config.mode).toBe("paper");

      const tighter = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxPositionPct: 4, analystMinScore: 0.62, maxTop10Pct: 20, maxOpenPositions: 3, defaultBuyUsd: 5 })
      });
      expect(tighter.status).toBe(200);
      const tighterBody = (await tighter.json()) as { maxPositionPct: number; analystMinScore: number; stopLossPct: number };
      expect(tighterBody.maxPositionPct).toBe(0.04);
      expect(tighterBody.analystMinScore).toBe(0.62);
      expect(tighterBody.stopLossPct).toBe(0.06);
      expect(desk.config.mode).toBe("paper");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }

    const again = new Desk({ ...cfg, resetPaper: false });
    try {
      expect(again.readiness().operatorReady).toBe(true);
      expect(again.readiness().mode).toBe("paper");
      expect(again.snapshot().rules.minVolume1hUsd).toBe(10_000);
      again.setMinVolume(12_000);
      expect(again.readiness().operatorReady).toBe(true);
    } finally {
      again.stop();
    }
  });
});
