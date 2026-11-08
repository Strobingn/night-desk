import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { crosses, resolveOrder, type OrderContext } from "../src/desk/orders.js";
import { clampTrailArmFraction, clampTrailArmPct } from "../src/rules.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { SETTINGS_FIELDS } from "../web/src/settingsSchema.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));
const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });
const ADDRESS_ONLY = Keypair.generate().publicKey.toBase58();

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number }) =>
    req.side === "buy"
      ? { signature: "sig-buy", fillPriceUsd: 1.0, qty: req.sizeUsd ?? 0, notionalUsd: req.sizeUsd ?? 0, feeUsd: 0.01, slippage: 0 }
      : { signature: "sig-sell", fillPriceUsd: 1.3, qty: req.qty ?? 0, notionalUsd: (req.qty ?? 0) * 1.3, feeUsd: 0.01, slippage: 0.01 }
  );
});
afterEach(() => vi.restoreAllMocks());

const ctx = (over: Partial<OrderContext> = {}): OrderContext => ({
  symbol: "AAA",
  mark: 1,
  held: true,
  entryPrice: 1,
  hardStopPrice: 0.97,
  hardStopPct: 0.03,
  supply: 1_000_000,
  liveArmed: true,
  ...over
});

describe("v13.11 order tickets (pure)", () => {
  it("turns a price, a market cap, a % from now and a % from entry into one trigger price", () => {
    const p = resolveOrder({ side: "take_profit", mint: "M", basis: "price", value: 1.5 }, ctx());
    expect(p.ok && p.order.triggerPrice).toBe(1.5);
    const m = resolveOrder({ side: "take_profit", mint: "M", basis: "mcap", value: 2_000_000 }, ctx());
    expect(m.ok && m.order.triggerPrice).toBe(2);
    const n = resolveOrder({ side: "take_profit", mint: "M", basis: "pct_now", value: 600 }, ctx({ mark: 2 }));
    expect(n.ok && n.order.triggerPrice).toBeCloseTo(14, 9);
    const e = resolveOrder({ side: "stop_sell", mint: "M", basis: "pct_entry", value: -2 }, ctx({ mark: 1.2 }));
    expect(e.ok && e.order.triggerPrice).toBeCloseTo(0.98, 9);
    const b = resolveOrder({ side: "limit_buy", mint: "M", basis: "pct_now", value: -10, sizeUsd: 25, book: "paper" }, ctx({ held: false, entryPrice: null }));
    expect(b.ok && b.order).toMatchObject({ triggerPrice: 0.9, sizeUsd: 25, book: "paper" });
  });

  it("refuses in plain words: wrong side of the price, looser than the hard stop, no price, live partials", () => {
    const err = (r: ReturnType<typeof resolveOrder>) => (r.ok ? "" : r.error);
    expect(err(resolveOrder({ side: "limit_buy", mint: "M", value: 1.1 }, ctx({ held: false })))).toMatch(/already at .* Use Buy now/);
    expect(err(resolveOrder({ side: "take_profit", mint: "M", value: 0.9 }, ctx()))).toMatch(/Use Sell now/);
    expect(err(resolveOrder({ side: "stop_sell", mint: "M", value: 0.9 }, ctx()))).toMatch(/−3% hard stop at \$0\.97 sells first\. A custom stop can only be tighter/);
    expect(err(resolveOrder({ side: "stop_sell", mint: "M", value: 0.98 }, ctx({ mark: null })))).toMatch(/No fresh price/);
    expect(err(resolveOrder({ side: "stop_sell", mint: "M", value: 0.98 }, ctx({ mark: 0 })))).toMatch(/No fresh price/);
    expect(err(resolveOrder({ side: "take_profit", mint: "M", value: 2, percent: 50, book: "live" }, ctx()))).toMatch(/Live sells close 100%/);
    expect(err(resolveOrder({ side: "take_profit", mint: "M", value: 2, percent: 30 }, ctx()))).toMatch(/25%, 50% or 100%/);
    expect(err(resolveOrder({ side: "stop_sell", mint: "M", value: 0.98 }, ctx({ held: false })))).toMatch(/No open paper position/);
    expect(err(resolveOrder({ side: "take_profit", mint: "M", basis: "mcap", value: 5e6 }, ctx({ supply: null })))).toMatch(/No market cap known/);
    const w = resolveOrder({ side: "limit_buy", mint: "M", value: 0.5, book: "live" }, ctx({ held: false, liveArmed: false }));
    expect(w.ok && w.order.note).toBe("waiting: live not armed");
  });

  it("never crosses on 0 or junk", () => {
    expect(crosses({ side: "stop_sell", triggerPrice: 0.98 }, 0)).toBe(false);
    expect(crosses({ side: "limit_buy", triggerPrice: 0.98 }, Number.NaN)).toBe(false);
    expect(crosses({ side: "stop_sell", triggerPrice: 0.98 }, 0.98)).toBe(true);
    expect(crosses({ side: "take_profit", triggerPrice: 1.2 }, 1.21)).toBe(true);
  });
});

async function paperDesk() {
  const desk = new Desk(testConfig({ mode: "paper" }));
  desk.updateSettings({ autoBuy: false, stopLossPct: 0.03 });
  return desk;
}

describe("v13.11 paper orders on the desk", () => {
  it("take profit 50% and a tighter stop fire on the same confirmed mark, through the normal sell path", async () => {
    const desk = await paperDesk();
    try {
      const m = "OrderTp111111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "TP", priceUsd: 1, liquidityUsd: 500_000 }));
      expect((await desk.manualBuy(m, 50, { book: "paper" })).ok).toBe(true);
      await desk.markPrice(m, 1);
      const loose = desk.placeOrder({ side: "stop_sell", mint: m, basis: "pct_entry", value: -10 });
      expect(loose.ok).toBe(false);
      const tp = desk.placeOrder({ side: "take_profit", mint: m, basis: "pct_entry", value: 20, percent: 50 });
      const stop = desk.placeOrder({ side: "stop_sell", mint: m, basis: "pct_entry", value: -2 });
      expect(tp.ok && stop.ok).toBe(true);
      const qty = desk.book.positions.get(m)!.qty;
      await desk.markPrice(m, 1.1);
      await desk.ordersSettled();
      expect(desk.book.positions.get(m)!.qty).toBe(qty);
      await desk.markPrice(m, 1.25);
      await desk.ordersSettled();
      expect(desk.book.positions.get(m)!.qty).toBeCloseTo(qty / 2, 6);
      const snap = desk.snapshot();
      expect(snap.orders!.find((o) => tp.ok && o.id === tp.order.id)).toMatchObject({ status: "filled" });
      await desk.markPrice(m, 1.2);
      await desk.markPrice(m, 0.975);
      await desk.ordersSettled();
      expect(desk.book.positions.has(m)).toBe(false);
      expect(desk.snapshot().orders!.find((o) => stop.ok && o.id === stop.order.id)?.status).toBe("filled");
    } finally {
      desk.stop();
    }
  });

  it("limit buy fires at or below the target, never on a 0 or stale price", async () => {
    const desk = await paperDesk();
    try {
      const m = "OrderLb111111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "LB", priceUsd: 1, liquidityUsd: 500_000 }));
      await desk.markPrice(m, 1);
      const lb = desk.placeOrder({ side: "limit_buy", mint: m, basis: "price", value: 0.9, sizeUsd: 40 });
      expect(lb.ok).toBe(true);
      await desk.markPrice(m, 0);
      await desk.markPrice(m, 0.95);
      await desk.ordersSettled();
      expect(desk.book.positions.has(m)).toBe(false);
      // A price older than 30 s never fires.
      const real = Date.now();
      const spy = vi.spyOn(Date, "now").mockReturnValue(real + 31_000);
      desk.checkOrders();
      expect(desk.snapshot().orders![0].note).toMatch(/^waiting: price stale/);
      spy.mockRestore();
      await desk.markPrice(m, 0.89);
      await desk.ordersSettled();
      expect(desk.book.positions.get(m)).toMatchObject({ costUsd: expect.any(Number) });
      expect(desk.snapshot().orders![0]).toMatchObject({ status: "filled" });
    } finally {
      desk.stop();
    }
  });

  it("a refused trigger stays open with the reason, retries, then fails — never a silent fill", async () => {
    const desk = await paperDesk();
    try {
      const m = "OrderRf111111111111111111111111111111111111";
      // A thin pool: selling $5,000 of it would cost far past the exit-impact cap.
      await desk.submitCandidate(makeToken({ mint: m, symbol: "RF", priceUsd: 1, liquidityUsd: 400 }));
      await desk.markPrice(m, 1);
      const lb = desk.placeOrder({ side: "limit_buy", mint: m, basis: "price", value: 0.9, sizeUsd: 5000 });
      expect(lb.ok).toBe(true);
      let now = Date.now();
      const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
      for (let i = 1; i <= 3; i += 1) {
        await desk.markPrice(m, 0.85);
        await desk.ordersSettled();
        const o = desk.snapshot().orders![0];
        if (i < 3) expect(o).toMatchObject({ status: "open", tries: i, note: expect.stringMatching(/^Refused at .* Retrying in 30s/) });
        else expect(o).toMatchObject({ status: "failed", note: expect.stringMatching(/^Refused: /) });
        now += 31_000;
      }
      spy.mockRestore();
      expect(desk.book.positions.has(m)).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("orders persist across a restart; a restored mark never fires them", async () => {
    const cfg = testConfig({ mode: "paper" });
    const m = "OrderPs111111111111111111111111111111111111";
    let desk = new Desk(cfg);
    desk.updateSettings({ autoBuy: false });
    await desk.submitCandidate(makeToken({ mint: m, symbol: "PS", priceUsd: 1, liquidityUsd: 500_000 }));
    await desk.manualBuy(m, 50, { book: "paper" });
    await desk.markPrice(m, 1);
    const tp = desk.placeOrder({ side: "take_profit", mint: m, basis: "price", value: 1.5, percent: 100 });
    expect(tp.ok).toBe(true);
    await desk.markPrice(m, 1.4);
    desk.stop();
    desk = new Desk({ ...cfg, resetPaper: false });
    try {
      const saved = desk.snapshot().orders!;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ status: "open", side: "take_profit", triggerPrice: 1.5 });
      desk.checkOrders();
      await desk.ordersSettled();
      expect(desk.book.positions.has(m)).toBe(true);
      const cancel = desk.cancelOrder(saved[0].id);
      expect(cancel.ok).toBe(true);
      expect(desk.snapshot().orders![0].status).toBe("canceled");
    } finally {
      desk.stop();
    }
  });
});

describe("v13.11 live orders", () => {
  it("unarmed: a live limit buy can be placed, waits 'live not armed', never sends and never falls back to paper", async () => {
    const desk = new Desk(testConfig({ mode: "paper", liveRequested: true, readWalletSecret: () => ADDRESS_ONLY }), { walletBalances: rich });
    try {
      desk.updateSettings({ autoBuy: false });
      const m = "OrderLv111111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "LV", priceUsd: 1, liquidityUsd: 500_000 }));
      await desk.markPrice(m, 1);
      const r = desk.placeOrder({ side: "limit_buy", mint: m, basis: "pct_now", value: -10, book: "live" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.text).toMatch(/waiting: live not armed/);
      const cash = desk.book.cashUsd;
      await desk.markPrice(m, 0.5);
      await desk.ordersSettled();
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(desk.book.positions.has(m)).toBe(false);
      expect(desk.book.cashUsd).toBe(cash);
      expect(desk.snapshot().orders![0]).toMatchObject({ status: "open", waiting: "waiting: live not armed" });
    } finally {
      desk.stop();
    }
  });

  it("armed: a live take profit closes 100% through the live swap; the AI's paper position is untouched", async () => {
    const key = Keypair.generate();
    const secret = JSON.stringify(Array.from(key.secretKey));
    const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: rich });
    try {
      const m = "OrderLa111111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "LA", priceUsd: 1, liquidityUsd: 500_000 }));
      const paperQty = desk.book.positions.get(m)?.qty;
      desk.setOperatorReady(true);
      expect((await desk.manualBuy(m, 5, { book: "live" })).ok).toBe(true);
      await desk.markPrice(m, 1);
      expect(desk.placeOrder({ side: "take_profit", mint: m, value: 1.3, percent: 50, book: "live" }).ok).toBe(false);
      const tp = desk.placeOrder({ side: "take_profit", mint: m, value: 1.3, book: "live" });
      expect(tp.ok).toBe(true);
      await desk.markPrice(m, 1.31);
      await desk.ordersSettled();
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", mint: m }));
      expect(desk.liveBook!.positions.has(m)).toBe(false);
      expect(desk.book.positions.get(m)?.qty).toBe(paperQty);
      expect(desk.snapshot().orders!.find((o) => tp.ok && o.id === tp.order.id)?.status).toBe("filled");
    } finally {
      desk.stop();
    }
  });
});

describe("v13.11 profit cap (trail arm) 80% → 600%", () => {
  it("server accepts up to 600%, refuses above, and a saved 600% survives a restart", () => {
    expect(clampTrailArmPct(600)).toBe(6);
    expect(clampTrailArmPct(80)).toBe(0.8);
    expect(clampTrailArmPct(0.8)).toBe(0.8);
    expect(clampTrailArmFraction(6)).toBe(6);
    expect(clampTrailArmFraction(0.8)).toBe(0.8);
    const cfg = testConfig({ mode: "paper" });
    let desk = new Desk(cfg);
    expect(desk.updateSettings({ trailArmPct: 601 }).ok).toBe(false);
    const ok = desk.updateSettings({ trailArmPct: 600 });
    expect(ok.ok).toBe(true);
    expect(desk.snapshot().rules.trailArmPct).toBe(6);
    desk.stop();
    desk = new Desk({ ...cfg, resetPaper: false });
    expect(desk.snapshot().rules.trailArmPct).toBe(6);
    desk.stop();
  });

  it("web slider goes to 600 and sends a percent", () => {
    const field = SETTINGS_FIELDS.find((f) => f.key === "trailArmPct") as import("../web/src/settingsSchema.js").SliderField;
    expect(field.max).toBe(600);
    expect(field.toWire(600)).toBe(600);
    expect(field.toWire(150)).toBe(150);
    expect(field.fromState(0.8)).toBe(80);
  });
});
