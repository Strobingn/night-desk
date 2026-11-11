import { nextDeskHold } from "../web/src/pump/desk-hold.js";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { startServer } from "../src/server/http.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));

const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });

function armed(): Desk {
  const key = Keypair.generate();
  const desk = new Desk(
    testConfig({
      mode: "live",
      liveRequested: true,
      readWalletSecret: () => JSON.stringify(Array.from(key.secretKey))
    }),
    { walletBalances: rich }
  );
  desk.updateSettings({ autoBuy: false, liveTradeUsd: 5, liveDailyCapUsd: 20, liveAutoBuy: false });
  const strategy = desk.updateStrategy({ enabled: true });
  if (!strategy.ok) throw new Error(strategy.error);
  return desk;
}

const young = (mint: string, symbol: string) =>
  makeToken({ mint, symbol, priceUsd: 0.001, ageSeconds: 600, volume5mUsd: 40_000, discoveredAt: Date.now() });

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { sizeUsd?: number; markPriceUsd?: number }) => {
    const price = req.markPriceUsd && req.markPriceUsd > 0 ? req.markPriceUsd : 1;
    const size = req.sizeUsd ?? 0;
    return { signature: "sig-mock", fillPriceUsd: price, qty: size / price, notionalUsd: size, feeUsd: 0.01, slippage: 0.001 };
  });
});

describe("v13.32 pump watch hold", () => {
  const kill = { ok: false, code: "HARD_KILL", error: "Hard kill on A." };

  it("keeps Buy anyway on the mint that was held", () => {
    const held = nextDeskHold(null, { requestedMint: "A", watchedMint: "A", confirm: false, ...kill });
    expect(held).toEqual({ mint: "A", reason: "Hard kill on A." });
    expect(nextDeskHold(held, { requestedMint: "A", watchedMint: "B", confirm: false, ...kill })).toBe(held);
    expect(nextDeskHold(held, { requestedMint: "A", watchedMint: "A", confirm: true, ok: true })).toBeNull();
  });
});

describe("v13.32 manual live override", () => {
  it("lets a manual live buy fill a coin the engine is only watching", async () => {
    const desk = armed();
    const mint = "WatchMint11111111111111111111111111111111";
    try {
      await desk.submitCandidate(young(mint, "WATCH"));
      expect(desk.snapshot().strategy?.watching).toBe(1);
      expect(desk.book.positions.size).toBe(0);
      expect(desk.snapshot().events.some((event) => event.code === "SIGNAL_WATCH")).toBe(true);

      const blocked = await desk.manualBuy(mint, 5, { book: "live" });
      expect(blocked).toMatchObject({ ok: false, code: "OPERATOR_NOT_READY" });
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();

      desk.setOperatorReady(true);
      const bought = await desk.manualBuy(mint, 5, { book: "live" });
      expect(bought.ok).toBe(true);
      if (!bought.ok) return;
      expect(bought.mode).toBe("live");
      expect(bought.sizeUsd).toBe(5);
      expect(bought.warning).toMatch(/Engine is watching/);
      expect(desk.liveBook!.positions.get(mint)?.costUsd).toBe(5);
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      expect(liveBroker.executeLiveSwap.mock.calls[0]?.[0]).toMatchObject({ side: "buy", mint, sizeUsd: 5 });
    } finally {
      desk.stop();
    }
  });

  it("lets a manual live buy and a manual paper buy fill a coin the analyst rejected", async () => {
    const desk = armed();
    desk.setOperatorReady(true);
    const liveMint = "ScoreMint11111111111111111111111111111111";
    const paperMint = "ScorePaper111111111111111111111111111111";
    const quiet = {
      priceUsd: 1,
      liquidityUsd: 20_000,
      volume1hUsd: 12_000,
      ageSeconds: 2 * 86_400,
      top10HolderPct: 0.18,
      holderCount: 40,
      social: { hasWebsite: false, hasTelegram: false, hasTwitter: false, mentions1h: 0 }
    };
    try {
      await desk.submitCandidate(makeToken({ mint: liveMint, symbol: "LOW", ...quiet }));
      expect(desk.book.positions.has(liveMint)).toBe(false);
      expect(desk.liveBook!.positions.has(liveMint)).toBe(false);
      const bought = await desk.manualBuy(liveMint, 5, { book: "live" });
      expect(bought.ok).toBe(true);
      if (!bought.ok) return;
      expect(bought.warning).toMatch(/Analyst scored/);
      expect(bought.warning).toMatch(/Below/);
      expect(desk.liveBook!.positions.has(liveMint)).toBe(true);
      expect(desk.book.positions.has(liveMint)).toBe(false);
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);

      await desk.submitCandidate(makeToken({ mint: paperMint, symbol: "PAP", ...quiet }));
      const paper = await desk.manualBuy(paperMint, 8, { book: "paper" });
      expect(paper.ok).toBe(true);
      if (!paper.ok) return;
      expect(paper.mode).toBe("paper");
      expect(paper.warning).toMatch(/Analyst scored/);
      expect(desk.book.positions.has(paperMint)).toBe(true);
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
    } finally {
      desk.stop();
    }
  });

  it("lets a manual live buy fill a coin a soft filter killed", async () => {
    const desk = armed();
    desk.setOperatorReady(true);
    const mint = "FilterMint1111111111111111111111111111111";
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "THIN", priceUsd: 1, liquidityUsd: 180_000, volume1hUsd: 100 }));
      const bought = await desk.manualBuy(mint, 5, { book: "live" });
      expect(bought.ok).toBe(true);
      if (!bought.ok) return;
      expect(bought.warning).toMatch(/Filter killed/);
      expect(desk.liveBook!.positions.has(mint)).toBe(true);
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
    } finally {
      desk.stop();
    }
  });

  it("holds a hard kill until Buy anyway, then sends the live order", async () => {
    const desk = armed();
    desk.setOperatorReady(true);
    const mint = "KillMint111111111111111111111111111111111";
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "KILL", priceUsd: 1, liquidityUsd: 180_000, mintAuthorityRevoked: false }));
      const held = await desk.manualBuy(mint, 5, { book: "live" });
      expect(held).toMatchObject({ ok: false, code: "HARD_KILL" });
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      const bought = await desk.manualBuy(mint, 5, { book: "live", confirmHardKill: true });
      expect(bought.ok).toBe(true);
      if (!bought.ok) return;
      expect(bought.mode).toBe("live");
      expect(desk.liveBook!.positions.has(mint)).toBe(true);
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
    } finally {
      desk.stop();
    }
  });

  it("keeps an engine signal on the paper book and refuses liveAutoBuy", async () => {
    const desk = armed();
    desk.updateSettings({ autoBuy: true });
    desk.setOperatorReady(true);
    const mint = "SignalMint1111111111111111111111111111111";
    const token = young(mint, "SIG");
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      await desk.submitCandidate(token);
      const t = Date.now();
      const quote = (at: number, priceUsd: number) => ({ at, priceUsd, vol5mUsd: 40_000, vol1hUsd: 180_000, change1hPct: 15 });
      await desk.submitStrategyQuote(mint, quote(t + 10_000, token.priceUsd * 1.01), t + 10_000);
      await desk.submitStrategyQuote(mint, quote(t + 22_000, token.priceUsd * 1.025), t + 22_000);
      expect(desk.book.positions.get(mint)?.entry).toBe("analyst");
      expect(desk.book.positions.get(mint)?.live).toBeUndefined();
      expect(desk.liveBook!.positions.size).toBe(0);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();

      const refused = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ liveAutoBuy: true })
      });
      const body = (await refused.json()) as { ok?: boolean; error?: string };
      expect(refused.status).toBe(400);
      expect(body.error).toMatch(/AI auto-buys stay on the paper book/);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });

  it("still stops at the $20 live daily cap", async () => {
    const desk = armed();
    desk.setOperatorReady(true);
    try {
      for (let i = 0; i < 4; i += 1) {
        const mint = `CapMint${i}111111111111111111111111111111111`.slice(0, 44);
        await desk.submitCandidate(makeToken({ mint, symbol: `C${i}`, priceUsd: 1, liquidityUsd: 180_000 }));
        const bought = await desk.manualBuy(mint, 5, { book: "live" });
        expect(bought.ok).toBe(true);
      }
      const fifth = `CapMint4111111111111111111111111111111111`.slice(0, 44);
      await desk.submitCandidate(makeToken({ mint: fifth, symbol: "C4", priceUsd: 1, liquidityUsd: 180_000 }));
      const capped = await desk.manualBuy(fifth, 5, { book: "live" });
      expect(capped).toMatchObject({ ok: false, code: "LIVE_DAILY_CAP" });
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(4);
    } finally {
      desk.stop();
    }
  });
});
