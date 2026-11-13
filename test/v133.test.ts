import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/bus.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { classifyStopExit, exitLabel, GAP_TOLERANCE } from "../src/desk/gap.js";
import { CRASH_WINDOW_MS, MomentumTracker } from "../src/market/momentum.js";
import { parseLaunchLabList, parsePumpApiCoins } from "../src/market/listings.js";
import { bucketFor } from "../src/market/net.js";
import { Scout, PUMP_STALE_MS, type PumpSocket } from "../src/agents/scout.js";
import { IdempotencyCache } from "../src/server/idempotency.js";
import { startServer } from "../src/server/http.js";
import type { DeskEvents } from "../src/types.js";
import { testConfig } from "./helpers.js";

const MINT = "OneTap1111111111111111111111111111111111";

function quiet(overrides: Parameters<typeof makeToken>[0] = {}) {
  return makeToken({ mint: MINT, symbol: "TAP", priceUsd: 1, liquidityUsd: 100_000, volume1hUsd: 100, ...overrides });
}

describe("v13.3 honest gap/rug labels", () => {
  it("labels a stop that filled far past the line as GAP_RUG and keeps clean stops as STOP_LOSS", () => {
    // Ghost Cat: 0.0000229 → 0.0000000237 in 45s.
    const ghost = classifyStopExit({ code: "STOP_LOSS", entryPrice: 0.0000229, stopPct: 0.06, fillPrice: 0.0000000237 });
    expect(ghost.code).toBe("GAP_RUG");
    expect(ghost.rug).toBe(true);
    expect(ghost.fillDropPct!).toBeLessThan(-0.99);
    // STEALING / 8Wc4: −12 to −13% against a 6% line is a gap, not a rug.
    const stealing = classifyStopExit({ code: "STOP_LOSS", entryPrice: 1, stopPct: 0.06, fillPrice: 0.875 });
    expect(stealing.code).toBe("GAP_RUG");
    expect(stealing.rug).toBe(false);
    expect(stealing.gapPct).toBeCloseTo(0.065, 6);
    // A fill near the line (paper slippage) is still a clean stop.
    const clean = classifyStopExit({ code: "STOP_LOSS", entryPrice: 1, stopPct: 0.06, fillPrice: 1 - 0.06 - GAP_TOLERANCE + 0.001 });
    expect(clean.code).toBe("STOP_LOSS");
    // Trailing stops and manual sells are never relabelled.
    expect(classifyStopExit({ code: "TRAIL_STOP", entryPrice: 1, stopPct: 0.06, fillPrice: 0.5 }).code).toBe("TRAIL_STOP");
    expect(classifyStopExit({ code: "MANUAL_CLOSE", entryPrice: 1, stopPct: 0.06, fillPrice: 0.5 }).code).toBe("MANUAL_CLOSE");
    expect(exitLabel("GAP_RUG")).toBe("gap/rug");
    expect(exitLabel("STOP_LOSS")).toBe("stop-loss");
  });

  it("records the true fill, stop line and trigger mark, and the recap says gap/rug", async () => {
    const desk = new Desk(testConfig());
    try {
      await desk.submitCandidate(quiet());
      const bought = await desk.manualBuy(MINT, 50);
      expect(bought.ok).toBe(true);
      const held = desk.book.positions.get(MINT)!;
      const entry = held.entryPrice;
      const basis = held.entryMark != null && held.entryMark > 0 ? held.entryMark : entry;
      await desk.markPrice(MINT, entry * 0.001);
      await desk.markPrice(MINT, entry * 0.001);
      expect(desk.book.positions.has(MINT)).toBe(false);
      const closed = desk.snapshot().closed.find((t) => t.mint === MINT)!;
      expect(closed.exitCode).toBe("GAP_RUG");
      expect(closed.exitPrice!).toBeLessThan(entry * 0.01);
      expect(closed.stopPrice!).toBeCloseTo(basis * 0.94, 10);
      expect(closed.triggerPrice!).toBeCloseTo(entry * 0.001, 12);
      const exitEvent = desk.snapshot().events.find((e) => e.code === "GAP_RUG" && e.stage === "risk");
      expect(exitEvent?.message).toContain("gapped through the stop");
      expect(exitEvent?.message).toContain("cannot fill better than the market");
      expect(exitEvent?.message).not.toMatch(/stop (prevents|protects against) gaps/i);
      const text = desk.recap("24h").text;
      expect(text).toContain("gap/rug, fill −");
      expect(text).toMatch(/1 gap\/rug exit: .*A stop cannot fill better than the market/);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.3 pre-buy crash and liquidity-pull guard", () => {
  it("flags a hard drop or a pulled pool inside the window and ignores old history", () => {
    const m = new MomentumTracker();
    const t0 = 1_000_000;
    m.note("A", 1, 50_000, t0);
    m.note("A", 1.05, 50_000, t0 + 10_000);
    expect(m.check("A", 1.0, 50_000, t0 + 20_000)).toBeNull();
    expect(m.check("A", 0.8, 50_000, t0 + 20_000)?.code).toBe("PRICE_CRASH");
    m.note("B", 1, 80_000, t0);
    m.note("B", 1, 40_000, t0 + 20_000);
    expect(m.check("B", 1, 80_000, t0 + 25_000)?.code).toBe("LIQUIDITY_PULL");
    expect(m.check("A", 0.5, 50_000, t0 + 10_000 + CRASH_WINDOW_MS + 1)).toBeNull();
    expect(m.check("unknown", 1, 1, t0)).toBeNull();
  });

  it("refuses a one-tap buy into a coin that just dropped 30%, through all the normal checks", async () => {
    const desk = new Desk(testConfig());
    try {
      await desk.submitCandidate(quiet());
      await desk.markPrice(MINT, 0.7);
      const refused = await desk.manualBuy(MINT, 25);
      expect(refused).toMatchObject({ ok: false, code: "PRICE_CRASH" });
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(desk.snapshot().events.some((e) => e.code === "PRICE_CRASH" && e.kind === "reject")).toBe(true);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.3 paper reset to $1,000 with archive", () => {
  it("archives the session, sets the new start as the saved setting, and keeps trade history", async () => {
    const cfg = testConfig();
    const desk = new Desk(cfg);
    try {
      await desk.submitCandidate(quiet());
      expect((await desk.manualBuy(MINT, 25)).ok).toBe(true);
      expect((await desk.closePosition(MINT, 1)).ok).toBe(true);
      const before = desk.snapshot().closed.length;
      expect(desk.resetPaperBook(true, Number.NaN)).toMatchObject({ ok: false });
      const result = desk.resetPaperBook(true, 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.cashUsd).toBe(1000);
      expect(result.startingBalanceUsd).toBe(1000);
      expect(desk.book.cashUsd).toBe(1000);
      expect(desk.book.positions.size).toBe(0);
      expect(JSON.stringify(desk.snapshot())).toContain('"paperResetUsd":1000');
      expect(result.archivePath).toBeTruthy();
      expect(existsSync(result.archivePath!)).toBe(true);
      expect(path.basename(path.dirname(result.archivePath!))).toBe("archive");
      const archived = JSON.parse(readFileSync(result.archivePath!, "utf8"));
      expect(archived.closed.length).toBe(before);
      expect(archived.nextStartingUsd).toBe(1000);
      // History is kept in the trades table; the 24h recap clips to the reset.
      expect(desk.store.recentClosed(50).length).toBeGreaterThanOrEqual(before);
      expect(desk.recap("24h").closed.length).toBe(0);
      // Per-trade cap scales with the new equity: the test rules' 8% → $80 at $1,000 (Dirk's 50% → $500).
      expect(desk.snapshot().positionCapUsd).toBe(80);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.3 one-tap buy and sell over HTTP", () => {
  it("one order per idemKey, a sell replay does not 404, and Sell all closes everything", async () => {
    const desk = new Desk(testConfig());
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (route: string, body: unknown) =>
      fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await post("/api/paper/reset", { confirm: true, startingUsd: 50 })).status).toBe(400);
      expect((await post("/api/paper/reset", { confirm: true, startingUsd: 20_000 })).status).toBe(400);
      await desk.submitCandidate(quiet());
      const [a, b] = await Promise.all([
        post("/api/positions/buy", { mint: MINT, sizeUsd: 20, idemKey: "tap-1" }),
        post("/api/positions/buy", { mint: MINT, sizeUsd: 20, idemKey: "tap-1" })
      ]);
      const ja = await a.json();
      const jb = await b.json();
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect([ja.replayed, jb.replayed].filter(Boolean)).toHaveLength(1);
      expect(desk.book.positions.get(MINT)?.costUsd).toBe(20);
      expect(typeof ja.ms).toBe("number");
      expect(ja.fillPriceUsd ?? jb.fillPriceUsd).toBeGreaterThan(0);

      const s1 = await post("/api/positions/sell", { mint: MINT, idemKey: "sell-1" });
      const s1j = await s1.json();
      expect(s1.status).toBe(200);
      expect(s1j).toMatchObject({ ok: true, symbol: "TAP" });
      expect(typeof s1j.pnlUsd).toBe("number");
      const s2 = await post("/api/positions/sell", { mint: MINT, idemKey: "sell-1" });
      expect(s2.status).toBe(200);
      expect((await s2.json()).replayed).toBe(true);
      expect(desk.snapshot().closed.filter((t) => t.mint === MINT)).toHaveLength(1);

      const other = "OneTap2222222222222222222222222222222222";
      await desk.submitCandidate(makeToken({ mint: other, symbol: "TWO", priceUsd: 2, liquidityUsd: 100_000, volume1hUsd: 100 }));
      expect((await post("/api/positions/buy", { mint: other, sizeUsd: 10, idemKey: "tap-2" })).status).toBe(200);
      expect((await post("/api/positions/buy", { mint: MINT, sizeUsd: 10, idemKey: "tap-3", ignoreCooldown: true })).status).toBe(200);
      expect(desk.book.positions.size).toBe(2);
      expect((await post("/api/positions/sell-all", {})).status).toBe(400);
      const all = await post("/api/positions/sell-all", { confirm: true, idemKey: "all-1" });
      const allj = await all.json();
      expect(allj.sold).toHaveLength(2);
      expect(desk.book.positions.size).toBe(0);
    } finally {
      server.close();
      desk.stop();
    }
  });

  it("the idempotency cache forgets a key after 60s", async () => {
    let now = 0;
    const cache = new IdempotencyCache(() => now);
    cache.remember("buy", "k", Promise.resolve({ ok: true }), () => 200);
    expect(cache.lookup("buy", "k")).not.toBeNull();
    expect(cache.lookup("sell", "k")).toBeNull();
    now = 61_000;
    expect(cache.lookup("buy", "k")).toBeNull();
    expect(cache.lookup("buy", undefined)).toBeNull();
  });
});

class FakeSocket extends EventEmitter implements PumpSocket {
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit("close");
  }
  terminate(): void {
    this.close();
  }
}

describe("v13.3 Pump stream watchdog", () => {
  afterEach(() => vi.useRealTimers());

  it("marks a silent stream stale (not live), logs it, and reconnects with backoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const sockets: FakeSocket[] = [];
    const logs: Array<[string, string]> = [];
    const scout = new Scout({
      bus: new EventBus<DeskEvents>(),
      feedMode: "live",
      demo: false,
      pumpWsUrl: "wss://example.invalid",
      fetchImpl: (async () => new Response("[]")) as typeof fetch,
      onStatus: () => undefined,
      onLog: (message, code) => logs.push([code, message]),
      pumpSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      }
    });
    (scout as unknown as { connectPump(): void }).connectPump();
    const pumpState = () => scout.report().sources!.find((s) => s.id === "pump")!;
    sockets[0]!.emit("open");
    expect(sockets[0]!.sent.join()).toContain("subscribeNewToken");
    expect(sockets[0]!.sent.join()).toContain("subscribeMigration");
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ mint: "M1", txType: "create", symbol: "A" })));
    expect(pumpState().state).toBe("live");
    const okAt = pumpState().lastOkAt;
    expect(okAt).toBe(Date.now());

    vi.advanceTimersByTime(PUMP_STALE_MS - 1_000);
    scout.checkPumpWatchdog();
    expect(pumpState().state).toBe("live");

    vi.advanceTimersByTime(2_000);
    scout.checkPumpWatchdog();
    expect(pumpState().state).toBe("stale");
    expect(pumpState().detail).toMatch(/no message for 61s/);
    expect(sockets[0]!.closed).toBe(true);
    expect(logs.some(([code]) => code === "PUMP_STALE")).toBe(true);
    expect(logs.some(([code, m]) => code === "PUMP_RECONNECT" && m.includes("in 2s"))).toBe(true);
    expect(scout.pumpReconnectDelayMs).toBe(4_000);

    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("open");
    // Open but still silent: the watchdog fires again and the backoff doubles.
    vi.advanceTimersByTime(PUMP_STALE_MS + 1_000);
    scout.checkPumpWatchdog();
    expect(pumpState().state).toBe("stale");
    expect(logs.some(([code, m]) => code === "PUMP_RECONNECT" && m.includes("in 4s"))).toBe(true);
    vi.advanceTimersByTime(4_000);
    expect(sockets).toHaveLength(3);
    sockets[2]!.emit("open");
    sockets[2]!.emit("message", Buffer.from(JSON.stringify({ message: "Successfully subscribed" })));
    expect(pumpState().state).toBe("live");
    expect(pumpState().lastOkAt).toBe(Date.now());
    expect(logs.some(([code]) => code === "PUMP_BACK")).toBe(true);
    expect(scout.pumpReconnectDelayMs).toBe(2_000);
    scout.stop();
  });
});

describe("v13.3 new keyless coin providers", () => {
  it("parses Pump.fun API and LaunchLab lists, drops stale/banned rows, and routes them to their own rate buckets", () => {
    const now = 1_700_000_000_000;
    const pump = parsePumpApiCoins(
      [
        { mint: "PumpNew1pump", symbol: "NEW", name: "New", creator: "Dev1", created_timestamp: now - 5_000 },
        { mint: "PumpOld1pump", symbol: "OLD", created_timestamp: now - 3_600_000 },
        { mint: "PumpBan1pump", symbol: "BAN", created_timestamp: now - 1_000, is_banned: true }
      ],
      now
    );
    expect(pump.map((r) => r.mint)).toEqual(["PumpNew1pump"]);
    expect(pump[0]).toMatchObject({ source: "pumpfun", devWallet: "Dev1" });
    const ll = parseLaunchLabList({ success: true, data: { rows: [{ mint: "Bonk1", symbol: "BNK", createAt: now - 10_000, creator: "D" }, { mint: "Bonk2", createAt: now - 3_600_000 }] } }, now);
    expect(ll.map((r) => r.mint)).toEqual(["Bonk1"]);
    expect(ll[0]!.source).toBe("raydium");
    expect(bucketFor("https://frontend-api-v3.pump.fun/coins?offset=0")?.id).toBe("pumpapi");
    expect(bucketFor("https://launch-mint-v1.raydium.io/get/list?sort=new")?.id).toBe("launchlab");
  });
});

describe("v13.3 adjustable slippage (entry up to 50%, exit tolerance)", () => {
  it("reads percents from every client, keeps old fractions, refuses past 50%, and saves an exit tolerance", () => {
    const desk = new Desk(testConfig());
    try {
      expect(desk.snapshot().rules.maxEntrySlippage).toBe(0.03);
      const raised = desk.updateSettings({ maxEntrySlippage: 20 });
      expect(raised.ok && raised.settings.maxEntrySlippage).toBe(0.2);
      const oldWeb = desk.updateSettings({ maxEntrySlippage: 0.02 });
      expect(oldWeb.ok && oldWeb.settings.maxEntrySlippage).toBe(0.02);
      const oldAndroid = desk.updateSettings({ maxEntrySlippage: 0.5 });
      expect(oldAndroid.ok && oldAndroid.settings.maxEntrySlippage).toBe(0.005);
      expect(desk.updateSettings({ maxEntrySlippage: 51 }).ok).toBe(false);
      expect(desk.updateSettings({ maxEntrySlippage: null }).ok).toBe(false);
      const exit = desk.updateSettings({ maxExitSlippage: 10 });
      expect(exit.ok && exit.settings.maxExitSlippage).toBe(0.1);
      const cleared = desk.updateSettings({ maxExitSlippage: null });
      expect(cleared.ok && cleared.settings.maxExitSlippage).toBeNull();
      expect(desk.config.rules.stopLossPct).toBe(0.06);
    } finally {
      desk.stop();
    }
  });

  it("paper buys honor the setting: refused past it (fail closed), filled at the real price inside it, stop unchanged", async () => {
    const desk = new Desk(testConfig());
    const thin = "ThinPool11111111111111111111111111111111";
    try {
      // $50 into a $1,000 pool is ~10% price impact.
      await desk.submitCandidate(makeToken({ mint: thin, symbol: "THIN", priceUsd: 1, liquidityUsd: 1_000, volume1hUsd: 100 }));
      const refused = await desk.manualBuy(thin, 50);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(["ENTRY_SLIPPAGE", "EXIT_IMPACT"]).toContain(refused.code);
      // With a loose exit tolerance the entry cap alone still refuses the fill.
      expect(desk.updateSettings({ maxExitSlippage: 50 }).ok).toBe(true);
      expect(await desk.manualBuy(thin, 50)).toMatchObject({ ok: false, code: "ENTRY_SLIPPAGE" });
      expect(desk.updateSettings({ maxExitSlippage: null }).ok).toBe(true);
      expect(desk.book.positions.has(thin)).toBe(false);

      expect(desk.updateSettings({ maxEntrySlippage: 20 }).ok).toBe(true);
      const filled = await desk.manualBuy(thin, 50);
      expect(filled.ok).toBe(true);
      const pos = desk.book.positions.get(thin)!;
      expect(pos.entryPrice).toBeGreaterThan(1.09);
      expect(pos.entryPrice).toBeLessThan(1.2);
      if (filled.ok) expect(filled.fillPriceUsd).toBeCloseTo(pos.entryPrice, 10);
      const stopBasis = pos.entryMark != null && pos.entryMark > 0 ? pos.entryMark : pos.entryPrice;
      expect(desk.snapshot().positions.find((p) => p.mint === thin)?.stopPrice).toBeCloseTo(stopBasis * 0.94, 10);

      // A tight custom exit tolerance blocks the same buy before it opens.
      const closedThin = await desk.closePosition(thin, 1, undefined, { sellAnyway: true });
      expect(closedThin.ok).toBe(true);
      expect(desk.updateSettings({ maxExitSlippage: 5 }).ok).toBe(true);
      const exitBlocked = await desk.manualBuy(thin, 50, { ignoreCooldown: true });
      expect(exitBlocked).toMatchObject({ ok: false, code: "EXIT_IMPACT" });
      expect(exitBlocked.ok ? "" : exitBlocked.error).toContain("exit slippage setting");
    } finally {
      desk.stop();
    }
  });
});

describe("v13.3 web one-tap toasts and the Pump header", () => {
  it("formats buy, sell and gap/rug toasts and never calls a stale stream live", async () => {
    const { buyToast, sellToast, defaultTapUsd } = await import("../web/src/onetap.js");
    const { stateText } = await import("../web/src/feedText.js");
    expect(buyToast("TAP", { ok: true, symbol: "TAP", sizeUsd: 25, fillPriceUsd: 0.0012, mode: "paper" }, 180)).toMatch(/^Bought TAP \$25\.00 @ .+ · paper · 180 ms$/);
    expect(buyToast("TAP", { ok: false, error: "Price is down 30%", code: "PRICE_CRASH" }, 90)).toBe("TAP: Price is down 30% (PRICE_CRASH)");
    expect(sellToast("TAP", { ok: true, symbol: "TAP", proceedsUsd: 2, pnlUsd: -23, pnlPct: -0.92, exitCode: "GAP_RUG" }, 120)).toContain("gap/rug");
    expect(defaultTapUsd(null, 52, 500)).toBe(52);
    expect(defaultTapUsd(null, null, 500)).toBe(500);
    expect(defaultTapUsd(25, 52, 500)).toBe(25);
    const stale = { id: "pump", label: "Pump stream", enabled: true, state: "stale", detail: "no message for 75s, reconnecting", retryAt: null, failingSince: 1, lastOkAt: 1, reqPerMin: 0, budgetPerMin: null, limitPerMin: null, count429: 0, sightingsPerMin: 0 } as const;
    expect(stateText(stale as never, Date.now())).toBe("stale · no message for 75s, reconnecting");
  });
});
