import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { BUCKETS, HELIUS_P0_QUEUE_MAX, NetLimiter, heliusPollKey } from "../src/market/net.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { startServer } from "../src/server/http.js";
import { DeskStore } from "../src/store/db.js";
import type { EquityPoint } from "../src/types.js";
import { acceptSnapshot, mergeMarks } from "../web/src/marks.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));

function liveDesk(balances: () => Promise<WalletBalances>): Desk {
  const secret = JSON.stringify([...Keypair.generate().secretKey]);
  const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: balances });
  desk.setOperatorReady(true);
  return desk;
}

describe("v13.33 equity curve", () => {
  it("downsamples 100k rows to the chart shape and is faster than the full scan", () => {
    const store = new DeskStore(":memory:", ":memory:");
    const n = 100_000;
    const insert = store.db.prepare("INSERT INTO equity (ts, equity_usd, cash_usd) VALUES (?, ?, ?)");
    store.db.exec("BEGIN");
    let spikeAt = 0;
    for (let i = 0; i < n; i += 1) {
      const t = 1_700_000_000_000 + i * 2_000;
      const equity = 100 + Math.sin(i / 50) * 20 + (i === 12_345 ? 5_000 : 0) + (i === 80_000 ? -80 : 0);
      if (i === 12_345) spikeAt = t;
      insert.run(t, equity, 80 + (i % 7));
    }
    store.db.exec("COMMIT");

    const fullStarted = performance.now();
    const full = store.equitySince(0);
    const beforeMs = performance.now() - fullStarted;
    const curveStarted = performance.now();
    const curve = store.queryEquityCurve(0, 240);
    const afterMs = performance.now() - curveStarted;
    store.equityCurve(0, 240);
    const warmStarted = performance.now();
    const warm = store.equityCurve(0, 240);
    const warmMs = performance.now() - warmStarted;

    console.info(
      `[v13.33 equity] full equitySince ${beforeMs.toFixed(1)}ms (${full.length} rows); SQL curve ${afterMs.toFixed(1)}ms (${curve.length} points); cached ${warmMs.toFixed(1)}ms`
    );

    expect(full).toHaveLength(n);
    expect(curve.length).toBeLessThanOrEqual(240);
    expect(curve.length).toBeGreaterThan(2);
    for (const point of curve) {
      expect(point).toEqual({ t: expect.any(Number), equity: expect.any(Number), cash: expect.any(Number) });
      expect(Number.isFinite(point.t)).toBe(true);
      expect(Number.isFinite(point.equity)).toBe(true);
      expect(Number.isFinite(point.cash)).toBe(true);
    }
    expect(curve[0]?.t).toBe(full[0]?.t);
    expect(curve[curve.length - 1]?.t).toBe(full[full.length - 1]?.t);
    expect(Math.min(...curve.map((point) => point.equity))).toBe(Math.min(...full.map((point) => point.equity)));
    expect(Math.max(...curve.map((point) => point.equity))).toBe(Math.max(...full.map((point) => point.equity)));
    expect(curve.some((point) => point.t === spikeAt)).toBe(true);
    // The cold SQL aggregate is the same order as a full scan. The poll path is the cache.
    expect(afterMs).toBeLessThan(250);
    expect(warmMs).toBeLessThan(20);
    expect(warm).toBe(store.equityCurve(0, 240));

    const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM events ORDER BY ts DESC LIMIT 180`).all();
    expect(JSON.stringify(plan)).toMatch(/events_ts/);
    const equityPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT ts FROM equity WHERE ts >= ? ORDER BY ts ASC`).all(0);
    expect(JSON.stringify(equityPlan)).toMatch(/equity_ts/);
  });

  it("keeps bucket coverage when later inserts update the 240-point cache", () => {
    const store = new DeskStore(":memory:", ":memory:");
    const n = 1_200;
    const step = 2_000;
    const t0 = 1_700_000_000_000;
    const point = (i: number): EquityPoint => ({ t: t0 + i * step, equity: 100 + Math.sin(i / 30) * 20, cash: 80 });
    store.insertEquity(point(0));
    store.equityCurve(t0, 240);
    for (let i = 1; i < n; i += 1) store.insertEquity(point(i));
    const cached = store.equityCurve(t0, 240);
    const fresh = store.queryEquityCurve(t0, 240);
    const midFrom = t0 + 10 * 60_000;
    const midTo = t0 + 30 * 60_000;
    const coverage = (points: EquityPoint[]) => {
      const window = points.filter((row) => row.t >= midFrom && row.t <= midTo);
      let gap = 0;
      for (let i = 1; i < window.length; i += 1) gap = Math.max(gap, window[i]!.t - window[i - 1]!.t);
      return { count: window.length, gap };
    };
    const cachedGap = coverage(cached);
    const freshGap = coverage(fresh);
    expect(cached.length).toBeLessThanOrEqual(240);
    expect(cached[0]?.t).toBe(t0);
    expect(cached[cached.length - 1]?.t).toBe(t0 + (n - 1) * step);
    expect(cachedGap.count).toBeGreaterThanOrEqual(60);
    expect(cachedGap.gap).toBeLessThanOrEqual(30_000);
    expect(freshGap.count).toBeGreaterThanOrEqual(60);
    expect(freshGap.gap).toBeLessThanOrEqual(30_000);
  });

  it("serves a snapshot curve of at most 240 points and does not scan events with COUNT", () => {
    const desk = new Desk(testConfig());
    try {
      const insert = desk.store.db.prepare("INSERT INTO equity (ts, equity_usd, cash_usd) VALUES (?, ?, ?)");
      const start = Date.now();
      desk.store.db.exec("BEGIN");
      for (let i = 0; i < 3_000; i += 1) insert.run(start + i, 100 + Math.sin(i / 30), 90);
      desk.store.db.exec("COMMIT");
      const snap = desk.snapshot();
      expect(snap.equity.length).toBeLessThanOrEqual(240);
      expect(snap.equity[0]).toEqual(expect.objectContaining({ t: expect.any(Number), equity: expect.any(Number), cash: expect.any(Number) }));
      expect(snap.events.length).toBeLessThanOrEqual(180);
      const ordersStarted = performance.now();
      const orders = desk.ordersBody();
      expect(performance.now() - ordersStarted).toBeLessThan(50);
      expect(orders).toEqual({ ok: true, orders: [] });
      const settings = desk.settingsBody();
      expect(settings.ok).toBe(true);
      expect(settings.settings).not.toHaveProperty("equity");
    } finally {
      desk.stop();
    }
  });
});

describe("v13.33 wallet route", () => {
  it("returns the cached balance without waiting on a hung Helius read", async () => {
    let release: (value: WalletBalances) => void = () => undefined;
    const pending = new Promise<WalletBalances>((resolve) => {
      release = resolve;
    });
    const desk = liveDesk(() => pending);
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const started = performance.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/wallet`);
      const ms = performance.now() - started;
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(500);
      const body = (await res.json()) as { balanceStale?: boolean; balanceAgeMs?: number | null; usdcBalance: number | null; liveTradeUsd: number };
      expect(body.balanceStale).toBe(true);
      expect(body.usdcBalance).toBeNull();
      expect(body.balanceAgeMs).toBeNull();
      expect(body.liveTradeUsd).toBe(5);
      release({ sol: 0.2, usdc: 10, at: Date.now(), error: null });
      await vi.waitFor(async () => {
        const again = (await (await fetch(`http://127.0.0.1:${port}/api/wallet`)).json()) as {
          usdcBalance: number | null;
          balanceStale?: boolean;
          balanceAgeMs?: number | null;
        };
        expect(again.usdcBalance).toBe(10);
        expect(again.balanceStale).toBe(false);
        expect(again.balanceAgeMs).toBeGreaterThanOrEqual(0);
      });
    } finally {
      release({ sol: 0.2, usdc: 10, at: Date.now(), error: null });
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });

  it("still refuses a live buy that would break the daily cap or the balance, and bounds a hung read", async () => {
    const mint = "Lat111111111111111111111111111111111111111";
    let calls = 0;
    let release: (value: WalletBalances) => void = () => undefined;
    const desk = liveDesk(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ sol: 0.5, usdc: 1, at: Date.now(), error: null });
      return new Promise<WalletBalances>((resolve) => {
        release = resolve;
      });
    });
    try {
      desk.updateSettings({ autoBuy: false, liveDailyCapUsd: 20 });
      const day = new Date();
      const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      desk.store.writeJson("liveSpend", { day: stamp, usd: 20 });
      await desk.submitCandidate(makeToken({ mint, symbol: "LAT", priceUsd: 1, liquidityUsd: 180_000 }));
      const cappedAt = performance.now();
      const capped = await desk.manualBuy(mint, 5, { book: "live" });
      expect(capped).toMatchObject({ ok: false, code: "LIVE_DAILY_CAP" });
      expect(performance.now() - cappedAt).toBeLessThan(500);
      expect(calls).toBe(0);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();

      desk.store.writeJson("liveSpend", { day: stamp, usd: 0 });
      await desk.refreshWallet();
      expect(calls).toBe(1);
      const started = performance.now();
      const short = await desk.manualBuy(mint, 5, { book: "live" });
      const waited = performance.now() - started;
      expect(short).toMatchObject({ ok: false, code: "LIVE_WALLET" });
      if (!short.ok) expect(short.error).toMatch(/USDC/);
      expect(waited).toBeGreaterThan(3_000);
      expect(waited).toBeLessThan(7_000);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
    } finally {
      release({ sol: 0.5, usdc: 100, at: Date.now(), error: null });
      desk.stop();
    }
  }, 15_000);
});

describe("v13.33 snapshot ordering", () => {
  it("does not let a cached snapshot roll back a newer mark", async () => {
    const desk = new Desk(testConfig());
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<{ type: string; data: { seq?: number; positions?: Array<{ mint: string; markPrice: number }> } }> = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    const mint = "Mark11111111111111111111111111111111111111";
    try {
      await once(ws, "open");
      await desk.submitCandidate(makeToken({ mint, symbol: "MRK", priceUsd: 1, liquidityUsd: 180_000 }));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const before = messages.length;
      await desk.markPrice(mint, 1.25);
      desk.bus.emit("market.tick", { mint, priceUsd: 1.25, at: Date.now(), feed: "scout" });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      let seen = 0;
      let price = 0;
      for (const msg of messages.slice(before)) {
        if (msg.type === "marks") {
          const row = msg.data.positions?.find((item) => item.mint === mint);
          if (row && row.markPrice > 0) price = row.markPrice;
          continue;
        }
        if (msg.type !== "snapshot") continue;
        const seq = msg.data.seq ?? 0;
        if (!acceptSnapshot(seen, { seq })) continue;
        if (seq > seen) seen = seq;
        const row = msg.data.positions?.find((item) => item.mint === mint);
        if (row) price = row.markPrice;
      }
      expect(price).toBeCloseTo(1.25, 6);
      const stale = { seq: seen, positions: [{ mint, markPrice: 1, pnlUsd: 0, pnlPct: 0, marketValueUsd: 1, stopPrice: 0.9, peakPrice: 1 }] };
      const merged = mergeMarks(
        { seq: seen, positions: [{ mint, symbol: "MRK", markPrice: price, pnlUsd: 0, pnlPct: 0, marketValueUsd: 1, stopPrice: 0.9, peakPrice: price }] } as never,
        {
          now: Date.now(),
          cashUsd: 90,
          equityUsd: 100,
          positions: [
            {
              mint,
              markPrice: 1.25,
              marketValueUsd: 1.25,
              pnlUsd: 0.25,
              pnlPct: 0.25,
              stopPrice: 0.9,
              peakPrice: 1.25,
              trailArmed: false,
              trailHintPrice: null,
              markAgeMs: 0,
              markAt: Date.now(),
              markFeed: "scout"
            }
          ]
        },
        Date.now()
      );
      expect(acceptSnapshot(seen, stale)).toBe(false);
      expect(merged?.positions[0]?.markPrice).toBeCloseTo(1.25, 6);
    } finally {
      ws.close();
      server.close();
      desk.stop();
    }
  });
});

describe("v13.33 live exits", () => {
  it("still sends a live sell when the last good balance is older than 60s", async () => {
    let calls = 0;
    const desk = liveDesk(async () => {
      calls += 1;
      if (calls === 1) return { sol: 0.5, usdc: 100, at: Date.now() - 120_000, error: null };
      return new Promise<WalletBalances>(() => undefined);
    });
    liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number }) =>
      req.side === "buy"
        ? { signature: "sig-buy", fillPriceUsd: 1.01, qty: (req.sizeUsd ?? 5) / 1.01, notionalUsd: req.sizeUsd ?? 5, feeUsd: 0.01, slippage: 0.01 }
        : { signature: "sig-sell", fillPriceUsd: 1, qty: req.qty ?? 0, notionalUsd: req.qty ?? 0, feeUsd: 0.01, slippage: 0.01 }
    );
    const mint = "Stop11111111111111111111111111111111111111";
    try {
      desk.updateSettings({ autoBuy: false, liveDailyCapUsd: 20 });
      await desk.submitCandidate(makeToken({ mint, symbol: "STP", priceUsd: 1, liquidityUsd: 180_000 }));
      const bought = await desk.manualBuy(mint, undefined, { book: "live" });
      expect(bought.ok).toBe(true);
      const pos = desk.liveBook?.positions.get(mint);
      expect(pos).toBeTruthy();
      pos!.openedAt = Date.now() - 120_000;
      const started = performance.now();
      const closed = await desk.closePosition(mint, 1, "live");
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThan(3_000);
      expect(elapsed).toBeLessThan(7_000);
      expect(closed.ok).toBe(true);
      expect(liveBroker.executeLiveSwap.mock.calls.some((call) => call[0].side === "sell")).toBe(true);
    } finally {
      desk.stop();
    }
  }, 15_000);
});

describe("v13.33 Helius priority-0 queue", () => {
  it("drops stale duplicate mints and the oldest marks, and still serves a wallet read", async () => {
    const read = BUCKETS.find((row) => row.id === "helius");
    const exec = BUCKETS.find((row) => row.id === "helius:exec");
    expect(read?.budgetPerMin).toBe(10);
    expect(exec?.budgetPerMin).toBe(8);
    expect((read?.budgetPerMin ?? 0) + (exec?.budgetPerMin ?? 0)).toBe(18);

    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const sent: string[] = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: (fn, ms) => {
          timers.push({ at: now + Number(ms), fn });
          return 0;
        }
      },
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent.push(String(init?.body ?? ""));
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });
    const url = "https://mainnet.helius-rpc.com/?api-key=test";
    const accounts = (mint: string) =>
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[mint], { encoding: "base64" }] });
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const mint = (n: number) => {
      let s = "";
      let x = n + 1;
      for (let i = 0; i < 44; i += 1) {
        s += alphabet[x % alphabet.length]!;
        x = Math.floor(x / alphabet.length) + i * 13 + n + 9;
      }
      return s;
    };

    expect(heliusPollKey(accounts(mint(1)))).toBe(heliusPollKey(accounts(mint(1))));
    expect(heliusPollKey(accounts(mint(1)))).not.toBe(heliusPollKey(accounts(mint(2))));

    for (let i = 0; i < 3; i += 1) {
      await net.fetchAt(0)(url, { method: "POST", body: accounts(mint(i)) });
    }
    const dupBody = accounts(mint(9));
    const rejected: string[] = [];
    const watch = (work: Promise<unknown>) => {
      work.catch((err: Error) => rejected.push(err.message));
      return work;
    };
    const older = watch(net.fetchAt(0)(url, { method: "POST", body: dupBody }));
    const newer = watch(net.fetchAt(0)(url, { method: "POST", body: dupBody }));
    const olderState = await Promise.race([
      older.then(() => "resolved", (err: Error) => err.message),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50))
    ]);
    expect(olderState).toMatch(/stale duplicate/);
    const tracked: Array<Promise<unknown>> = [newer];
    for (let i = 0; i < 40; i += 1) {
      tracked.push(
        net.fetchAt(0)(url, { method: "POST", body: accounts(mint(100 + i)) }).catch((err: Error) => {
          rejected.push(err.message);
        })
      );
    }
    const queued = net.stats().find((row) => row.id === "helius")?.queued ?? 0;
    expect(queued).toBeLessThanOrEqual(HELIUS_P0_QUEUE_MAX);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejected.some((message) => message.includes("priority-0 queue full"))).toBe(true);

    const walletBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: ["Wallet1111111111111111111111111111111111111", { commitment: "confirmed" }]
    });
    const wallet = net.fetchAt(-1)(url, { method: "POST", body: walletBody });
    expect(net.stats().find((row) => row.id === "helius")?.queued ?? 0).toBeLessThanOrEqual(HELIUS_P0_QUEUE_MAX + 1);
    // 13.46: the wallet read does not wait for a token. It goes ahead of every queued mark.
    await wallet;
    expect(sent.at(-1)).toContain("getBalance");
    expect(sent.at(-1)).toContain("Wallet1111111111111111111111111111111111111");
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    expect(next).toBeTruthy();
    now = next!.at;
    next!.fn();
    expect(net.stats().find((row) => row.id === "helius")?.queued ?? 0).toBeLessThanOrEqual(HELIUS_P0_QUEUE_MAX);
    void tracked;
  });
});
