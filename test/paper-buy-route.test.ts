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

const rich = async (): Promise<WalletBalances> => ({ sol: 0.073786759, usdc: 22.636332, at: Date.now(), error: null });
const MINT = "J1c4tDDUziWwZQ4D8c6kxuAXHg5hcBX8GTNFUEaBpump";

/** The paper lightning button. Global mode is not in the body. */
const paperButton = {
  mint: MINT,
  sizeUsd: 100,
  book: "paper",
  idemKey: "paper-button-1",
  oneTap: true
};
/** The LIVE strip. This is the only manual body that may reach the swap. */
const liveButton = {
  mint: MINT,
  sizeUsd: 5,
  book: "live",
  idemKey: "live-strip-1",
  oneTap: true
};
/** What the phone posted before this fix: no book field at all. */
const omittedBook = {
  mint: MINT,
  sizeUsd: 100,
  idemKey: "omitted-book-1",
  oneTap: true
};

function armedDesk(): Desk {
  const key = Keypair.generate();
  const secret = JSON.stringify(Array.from(key.secretKey));
  const desk = new Desk(
    testConfig({
      mode: "live",
      liveRequested: true,
      startingBalanceUsd: 94.52,
      readWalletSecret: () => secret
    }),
    { walletBalances: rich }
  );
  desk.updateSettings({
    autoBuy: false,
    maxPositionPct: 0.295,
    positionSizeUsd: null,
    maxExposurePct: 0.25,
    maxOpenPositions: 2,
    liveTradeUsd: 5,
    liveDailyCapUsd: 20,
    liveAutoBuy: false
  });
  return desk;
}

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number }) => ({
    signature: "sig-mock",
    fillPriceUsd: 1,
    qty: req.sizeUsd ?? 0,
    notionalUsd: req.sizeUsd ?? 0,
    feeUsd: 0.01,
    slippage: 0.01
  }));
});

describe("paper button vs live strip", () => {
  it("prints the route bodies and refuses an omitted book on an armed desk", () => {
    expect(paperButton).toEqual({
      mint: MINT,
      sizeUsd: 100,
      book: "paper",
      idemKey: "paper-button-1",
      oneTap: true
    });
    expect(liveButton.book).toBe("live");
    expect(omittedBook).not.toHaveProperty("book");
    expect(JSON.stringify(paperButton)).toContain('"book":"paper"');
    expect(JSON.stringify(liveButton)).toContain('"book":"live"');
    expect(JSON.stringify(omittedBook)).not.toContain('"book"');
  });

  it("a paper button fills paper while the desk mode is live and the checklist is off", async () => {
    const desk = armedDesk();
    try {
      expect(desk.readiness().operatorReady).toBe(false);
      expect(desk.snapshot().mode).toBe("live");
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "MI", priceUsd: 1, liquidityUsd: 180_000 }));
      const out = await desk.manualBuy(paperButton.mint, paperButton.sizeUsd, { book: "paper" });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.mode).toBe("paper");
        expect(out.sizeUsd).toBeLessThan(paperButton.sizeUsd);
        expect(out.clampedFrom).toBe(paperButton.sizeUsd);
      }
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(desk.liveBook!.positions.size).toBe(0);
      expect(desk.book.positions.has(MINT)).toBe(true);
      expect(desk.book.cashUsd).toBeLessThan(94.52);
    } finally {
      desk.stop();
    }
  });

  it("an omitted book sends nothing and fills nothing when the desk is armed", async () => {
    const desk = armedDesk();
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "MI", priceUsd: 1, liquidityUsd: 180_000 }));
      const cash = desk.book.cashUsd;
      const res = await fetch(`http://127.0.0.1:${port}/api/positions/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(omittedBook)
      });
      const body = (await res.json()) as { ok: boolean; code?: string; error?: string };
      expect(res.status).toBe(400);
      expect(body).toMatchObject({ ok: false, code: "BOOK_REQUIRED" });
      expect(body.error).toMatch(/did not name paper or live/);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(desk.book.cashUsd).toBe(cash);
      expect(desk.book.positions.size).toBe(0);
      expect(desk.liveBook!.positions.size).toBe(0);
      expect(desk.readiness().operatorReady).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });

  it("an explicit live body is refused while operatorReady is false, then the mock swap sees only that body", async () => {
    const desk = armedDesk();
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "MI", priceUsd: 1, liquidityUsd: 180_000 }));
      const blocked = await fetch(`http://127.0.0.1:${port}/api/positions/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(liveButton)
      });
      const blockedBody = (await blocked.json()) as { ok: boolean; code?: string; error?: string };
      expect(blockedBody).toMatchObject({ ok: false, code: "OPERATOR_NOT_READY" });
      expect(blockedBody.error).toMatch(/operatorReady is false/);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(desk.book.positions.size).toBe(0);
      expect(desk.liveBook!.positions.size).toBe(0);

      const ready = await fetch(`http://127.0.0.1:${port}/api/live/ready`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorReady: true })
      });
      expect(ready.status).toBe(200);

      const sent = await fetch(`http://127.0.0.1:${port}/api/positions/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...liveButton, idemKey: "live-strip-2" })
      });
      const sentBody = (await sent.json()) as { ok: boolean; mode?: string; sizeUsd?: number };
      expect(sentBody).toMatchObject({ ok: true, mode: "live", sizeUsd: 5 });
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      expect(liveBroker.executeLiveSwap.mock.calls[0]?.[0]).toMatchObject({ side: "buy", mint: MINT, sizeUsd: 5 });
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(desk.liveBook!.positions.get(MINT)?.costUsd).toBe(5);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });

  it("paper buy, paper sell, and /api/state stay fast while a live swap is still hanging", async () => {
    const desk = armedDesk();
    desk.setOperatorReady(true);
    const other = "PaperSlow11111111111111111111111111111111";
    const fill = { signature: "sig-hang", fillPriceUsd: 1, qty: 5, notionalUsd: 5, feeUsd: 0.01, slippage: 0 };
    let release: (value: typeof fill) => void = () => undefined;
    const hung = new Promise<typeof fill>((resolve) => {
      release = resolve;
    });
    liveBroker.executeLiveSwap.mockImplementation(() => hung);
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "MI", priceUsd: 1, liquidityUsd: 180_000 }));
      await desk.submitCandidate(makeToken({ mint: other, symbol: "PAP", priceUsd: 1, liquidityUsd: 180_000 }));
      const liveBody = { mint: MINT, sizeUsd: 5, book: "live", idemKey: "live-hang", oneTap: true };
      const live = fetch(`${base}/api/positions/buy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(liveBody) });
      await vi.waitFor(() => expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1));

      const t0 = performance.now();
      const bought = await fetch(`${base}/api/positions/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...paperButton, mint: other, idemKey: "paper-while-live" })
      });
      const boughtBody = (await bought.json()) as { ok: boolean; mode?: string };
      const buyMs = performance.now() - t0;
      expect(boughtBody).toMatchObject({ ok: true, mode: "paper" });
      expect(buyMs).toBeLessThan(500);
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);

      const s0 = performance.now();
      const state = await fetch(`${base}/api/state`);
      expect(state.status).toBe(200);
      expect(performance.now() - s0).toBeLessThan(200);

      const tick0 = performance.now();
      desk.bus.emit("market.tick", { mint: other, priceUsd: 1.01, liquidityUsd: 180_000, at: Date.now(), feed: "test" });
      expect(performance.now() - tick0).toBeLessThan(50);

      const sold = await fetch(`${base}/api/positions/sell`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint: other, percent: 100, book: "paper" })
      });
      expect(((await sold.json()) as { ok: boolean }).ok).toBe(true);
      expect(desk.book.positions.has(other)).toBe(false);
      expect(desk.liveBook!.positions.size).toBe(0);
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);

      const again = fetch(`${base}/api/positions/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(liveBody)
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      release(fill);
      const first = (await (await live).json()) as { ok: boolean; mode?: string };
      const second = (await (await again).json()) as { ok: boolean; mode?: string; replayed?: boolean };
      expect(first).toMatchObject({ ok: true, mode: "live" });
      expect(second).toMatchObject({ ok: true, mode: "live", replayed: true });
    } finally {
      release(fill);
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });
});
