import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { Desk } from "../src/desk/orchestrator.js";
import { makeToken } from "../src/demo/tokens.js";
import { MarketRecorder, quotesCsv, recordDays, RECORDER, type RecordedQuote } from "../src/market/recorder.js";
import { startServer } from "../src/server/http.js";
import { replayGrid, replaySaved, rulesLabel } from "../src/strategy/replay.js";
import { testConfig } from "./helpers.js";

const q = (t: number, priceUsd: number, over: Partial<RecordedQuote> = {}): RecordedQuote => ({
  t,
  mint: "MintR",
  symbol: "REC",
  priceUsd,
  liquidityUsd: 200_000,
  vol5mUsd: 40_000,
  vol1hUsd: 180_000,
  change1hPct: 12,
  buys5m: 30,
  sells5m: 20,
  source: "dexscreener",
  ...over
});

describe("13.41 market recorder", () => {
  it("saves quotes in batches, throttles per coin, and reads them back in order", () => {
    const rec = new MarketRecorder(new DatabaseSync(":memory:"), 14);
    expect(rec.quote(q(1_000, 1))).toBe(true);
    expect(rec.quote(q(3_000, 1.01))).toBe(false); // under 5 s
    expect(rec.quote(q(7_000, 1))).toBe(false); // unchanged price, under 30 s
    expect(rec.quote(q(8_000, 1.02))).toBe(true);
    expect(rec.quote(q(40_000, 1.02))).toBe(true); // unchanged, but 30 s on
    expect(rec.quote(q(50_000, 0))).toBe(false);
    // Nothing changed except that the volume reading is fresh again after an outage: saved.
    expect(rec.quote(q(60_000, 3, { mint: "Out", flowAt: 60_000 - 120_000 }))).toBe(true);
    expect(rec.quote(q(66_000, 3, { mint: "Out", flowAt: 66_000 }))).toBe(true);
    expect(rec.quote(q(72_000, 3, { mint: "Out", flowAt: 72_000 }))).toBe(false);
    // Same price, but the pool lost depth: saved, because an exit rule reads depth.
    expect(rec.quote(q(46_000, 1.02, { liquidityUsd: 140_000 }))).toBe(true);
    expect(rec.quote(q(9_000, 2, { mint: "Other" }))).toBe(true);
    expect(rec.stats()).toMatchObject({ enabled: true, days: 14, quotes: 7 });
    const out = rec.quotesBetween({});
    expect(out.rows.map((r) => r.t)).toEqual([1_000, 8_000, 9_000, 40_000, 46_000, 60_000, 66_000]);
    expect(out.rows[0]).toMatchObject({ mint: "MintR", symbol: "REC", priceUsd: 1, buys5m: 30, sells5m: 20, source: "dexscreener" });
    expect(rec.quotesBetween({ mint: "Other" }).rows).toHaveLength(1);
    expect(rec.quotesBetween({ limit: 2 })).toMatchObject({ more: true });
    return rec.latestQuotes(0, 3).then((rows) => expect(rows.map((r) => r.t)).toEqual([9_000, 46_000, 66_000])); // the three saved last, in time order
  });

  it("is off at 0 days and reads the env value safely", () => {
    const rec = new MarketRecorder(new DatabaseSync(":memory:"), 0);
    expect(rec.quote(q(1_000, 1))).toBe(false);
    rec.signal({ t: 1, mint: "M", symbol: "S", kind: "launch", priceUsd: 1, detail: {} });
    expect(rec.stats()).toMatchObject({ enabled: false, quotes: 0, signals: 0 });
    expect(recordDays(undefined)).toBe(RECORDER.defaultDays);
    expect(recordDays("0")).toBe(0);
    expect(recordDays("7")).toBe(7);
    expect(recordDays("9999")).toBe(RECORDER.maxDays);
    expect(recordDays("junk")).toBe(RECORDER.defaultDays);
  });

  it("drops rows past the retention window", () => {
    const rec = new MarketRecorder(new DatabaseSync(":memory:"), 1);
    const now = 10 * 86_400_000;
    rec.quote(q(now - 3 * 86_400_000, 1));
    rec.quote(q(now - 3_600_000, 1.1));
    rec.signal({ t: now - 3 * 86_400_000, mint: "M", symbol: "S", kind: "launch", priceUsd: 1, detail: { risePct: 2 } });
    rec.signal({ t: now - 1_000, mint: "M", symbol: "S", kind: "momentum", priceUsd: 1, detail: { risePct: 3 } });
    rec.flush();
    rec.tidy(now);
    expect(rec.stats()).toMatchObject({ quotes: 1, signals: 1, oldestAt: now - 3_600_000 });
    expect(rec.signalsBetween({})[0]).toMatchObject({ kind: "momentum", detail: { risePct: 3 } });
  });

  it("writes a CSV a spreadsheet cannot run as a formula", () => {
    const csv = quotesCsv([q(1_000, 1.5, { symbol: '=HYPERLINK("x")', liquidityUsd: null })]);
    const [head, row] = csv.trim().split("\n");
    expect(head).toBe("t,mint,symbol,priceUsd,liquidityUsd,vol5mUsd,vol1hUsd,change1hPct,buys5m,sells5m,source");
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row!.split(",")[4]).toBe("");
  });

  it("the desk records the quotes the engine sees and the signals it fires", async () => {
    const desk = new Desk(testConfig());
    try {
      desk.updateStrategy({ enabled: true });
      const mint = "RecDesk11111111111111111111111111111111111";
      const token = makeToken({ mint, symbol: "RCD", priceUsd: 1, ageSeconds: 600, volume5mUsd: 40_000, liquidityUsd: 180_000, discoveredAt: Date.now() });
      await desk.submitCandidate(token);
      const t = Date.now();
      const quote = (at: number, priceUsd: number) => ({ at, priceUsd, vol5mUsd: 40_000, vol1hUsd: 180_000, change1hPct: 15, liquidityUsd: 180_000, buys5m: 12, sells5m: 5 });
      await desk.submitStrategyQuote(mint, quote(t + 10_000, 1.01), t + 10_000);
      await desk.submitStrategyQuote(mint, quote(t + 22_000, 1.025), t + 22_000);
      const signals = desk.marketSignals({});
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ mint, symbol: "RCD", kind: "launch", priceUsd: 1.025 });
      expect(signals[0]!.detail).toMatchObject({ liquidityUsd: 180_000, vol5mUsd: 40_000, buys5m: 12, sells5m: 5, paperVariant: "launch-1", liveVariant: null });
      expect(desk.strategyView().recording).toMatchObject({ enabled: true, signals: 1 });
    } finally {
      desk.stop();
    }
  });
});

describe("13.41 replay on saved data", () => {
  it("ranks exit rules on the same saved trades, and a trailing rule rides a run a fixed target sells", async () => {
    const t0 = 1_700_000_000_000;
    const path = [1, 1.03, 1.08, 1.2, 1.5, 1.9, 1.7, 1.2];
    const quotes = path.map((p, i) => q(t0 + (i + 1) * 10_000, p));
    const signals = [{ t: t0, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1, detail: { liquidityUsd: 200_000, vol5mUsd: 40_000 } }];
    const out = await replaySaved(quotes, signals, { yieldEvery: 1_000 });
    expect(out.quotes).toBe(8);
    expect(out.signals).toBe(1);
    expect(out.rows).toHaveLength(replayGrid().length * 2);
    const launch = out.rows.filter((r) => r.signal === "launch");
    expect(launch.every((r) => r.trades === 1)).toBe(true);
    const fixed = launch.find((r) => r.label === "3% stop, sell at target")!;
    const trail = launch.find((r) => r.label === "3% stop, 12% trail, lock breakeven")!;
    expect(fixed.netUsd).toBeGreaterThan(2.9);
    expect(trail.netUsd).toBeGreaterThan(fixed.netUsd * 2);
    expect(out.rows[0]!.netUsd).toBeGreaterThanOrEqual(out.rows[1]!.netUsd);
    expect(out.rows.filter((r) => r.signal === "momentum").every((r) => r.trades === 0)).toBe(true);
    expect(out.note).toMatch(/under the 200/);
    expect(rulesLabel({ stopPct: 0.03, trailPct: 0.08, lockShare: 0.5, fade: true })).toBe("3% stop, 8% trail, lock 50% of target, fade");
  });

  it("takes a repeat signal for every rule set, even while a slow rule still holds the coin", async () => {
    const t0 = 1_700_000_000_000;
    // First signal runs and keeps trailing; the coin signals again 31 minutes later.
    const quotes = [
      q(t0 + 10_000, 1.09),
      q(t0 + 20_000, 1.2),
      q(t0 + 31 * 60_000 + 10_000, 1.3),
      q(t0 + 31 * 60_000 + 20_000, 1.4),
      q(t0 + 31 * 60_000 + 30_000, 1.0)
    ];
    const detail = { liquidityUsd: 200_000, vol5mUsd: 40_000 };
    const signals = [
      { t: t0, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1, detail },
      { t: t0 + 31 * 60_000, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1.25, detail }
    ];
    const out = await replaySaved(quotes, signals, { yieldEvery: 1 });
    const launch = out.rows.filter((r) => r.signal === "launch");
    expect(launch.every((r) => r.trades + r.open === 2)).toBe(true);
    expect(launch.find((r) => r.label === "3% stop, sell at target")!.trades).toBe(2);
    expect(launch.find((r) => r.label === "3% stop, 12% trail, lock breakeven")!.trades).toBe(2);
  });

  it("opens a signal on its own firing quote, keeps late signals open, and honours a stale flow time", async () => {
    const t0 = 1_700_000_000_000;
    const detail = { liquidityUsd: 200_000, vol5mUsd: 40_000 };
    // Signal stamped with its firing quote's time: the trade opens on that quote and rides the next one.
    const out = await replaySaved([q(t0, 1), q(t0 + 10_000, 1.09)], [
      { t: t0, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1, detail },
      { t: t0 + 60_000, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1.1, detail }
    ]);
    const fixed = out.rows.find((r) => r.signal === "launch" && r.label === "3% stop, sell at target")!;
    expect(fixed).toMatchObject({ trades: 1, open: 1 });
    // Volume carried over an outage (old flowAt) must not fire a volume fade in the replay.
    const run = (flowAt: number | null) =>
      replaySaved(
        [q(t0 + 10_000, 1.09), q(t0 + 20_000, 1.1), q(t0 + 30_000, 1.11, { vol5mUsd: 1_000, flowAt }), q(t0 + 40_000, 1.5), q(t0 + 50_000, 1.0)],
        [{ t: t0, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1, detail }]
      ).then((r) => r.rows.find((row) => row.signal === "launch" && row.label === "3% stop, 12% trail, lock breakeven, fade")!);
    const fresh = await run(null);
    const stale = await run(t0 - 600_000);
    // Fresh reading: the fade sells at 1.11. Stale reading: no fade, so the trade rides on to the later prices.
    expect(fresh.netUsd).toBeGreaterThan(4);
    expect(stale.netUsd).toBeLessThan(0);
  });

  it("sells on a timer that falls between two saved quotes, at the earlier price", async () => {
    const t0 = 1_700_000_000_000;
    const detail = { liquidityUsd: 200_000, vol5mUsd: 40_000 };
    const out = await replaySaved([q(t0 + 590_000, 1), q(t0 + 610_000, 1.2)], [{ t: t0, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1, detail }]);
    const fixed = out.rows.find((r) => r.signal === "launch" && r.label === "3% stop, sell at target")!;
    expect(fixed.trades).toBe(1);
    expect(fixed.netUsd).toBeLessThan(0);
  });

  it("leaves a position open when its deadline falls after the saved data ends", async () => {
    const t0 = 1_700_000_000_000;
    const detail = { liquidityUsd: 200_000, vol5mUsd: 40_000 };
    const signals = [{ t: t0, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1, detail }];
    const quotes = [q(t0, 1), q(t0 + 590_000, 1)];
    const fixedOf = (r: Awaited<ReturnType<typeof replaySaved>>) => r.rows.find((row) => row.signal === "launch" && row.label === "3% stop, sell at target")!;
    expect(fixedOf(await replaySaved(quotes, signals))).toMatchObject({ trades: 0, open: 1 });
    // Asked 20 s later: the 600 s limit has passed on a still-fresh mark, so it is closed.
    expect(fixedOf(await replaySaved(quotes, signals, { until: t0 + 610_000 }))).toMatchObject({ trades: 1, open: 0 });
  });

  it("ranks rule sets that lost money above rule sets that never traded", async () => {
    const t0 = 1_700_000_000_000;
    const detail = { liquidityUsd: 200_000, vol5mUsd: 40_000 };
    const out = await replaySaved([q(t0 + 10_000, 0.98)], [{ t: t0, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1, detail }]);
    const scored = out.rows.filter((r) => r.trades > 0).length;
    expect(scored).toBeGreaterThan(0);
    expect(out.rows.slice(0, scored).every((r) => r.trades > 0 && r.netUsd < 0)).toBe(true);
  });

  it("stops on a saved tick between two quotes, and a tick does not wipe the volume reading", async () => {
    const t0 = 1_700_000_000_000;
    const detail = { liquidityUsd: 200_000, vol5mUsd: 40_000, feed: "dexscreener" };
    const tick = (t: number, p: number) => q(t, p, { source: "tick", vol5mUsd: null, vol1hUsd: null, buys5m: null, sells5m: null, change1hPct: null });
    const out = await replaySaved([tick(t0 + 5_000, 0.95), q(t0 + 10_000, 1.2)], [{ t: t0, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1, detail }]);
    const fixed = out.rows.find((r) => r.signal === "launch" && r.label === "3% stop, sell at target")!;
    expect(fixed.trades).toBe(1);
    expect(fixed.netUsd).toBeLessThan(-1);
    const rec = new MarketRecorder(new DatabaseSync(":memory:"), 14);
    expect(rec.tick(1_000, "M", "S", 1, 50_000)).toBe(true);
    expect(rec.tick(1_500, "M", "S", 1.001, 50_000)).toBe(false); // under 2 s and under 0.5%
    expect(rec.tick(1_600, "M", "S", 0.99, 50_000)).toBe(true); // a 1% move is always kept
    expect(rec.tick(4_000, "M", "S", 0.99, 50_000)).toBe(false); // unchanged
    expect(rec.quotesBetween({}).rows.map((r) => r.source)).toEqual(["tick", "tick"]);
  });

  it("ignores a quote from a feed the position is not marked by", async () => {
    const t0 = 1_700_000_000_000;
    const detail = { liquidityUsd: 200_000, vol5mUsd: 40_000, feed: "dexscreener" };
    const out = await replaySaved(
      [q(t0 + 10_000, 0.95, { source: "jupiter" }), q(t0 + 20_000, 1.2)],
      [{ t: t0, mint: "MintR", symbol: "REC", kind: "launch", priceUsd: 1, detail }]
    );
    const fixed = out.rows.find((r) => r.signal === "launch" && r.label === "3% stop, sell at target")!;
    expect(fixed.trades).toBe(1);
    expect(fixed.netUsd).toBeGreaterThan(3);
  });

  it("says so when there is nothing to replay", async () => {
    const out = await replaySaved([], []);
    expect(out.rows.every((r) => r.trades === 0)).toBe(true);
    expect(out.note).toMatch(/No saved signal/);
    expect(out.from).toBeNull();
  });
});

describe("13.41 live equity curve", () => {
  it("is absent on a paper desk and stores live samples apart from the paper curve", () => {
    const desk = new Desk(testConfig());
    try {
      expect(desk.snapshot().liveBook ?? null).toBeNull();
      desk.store.insertLiveEquity({ t: 1_000, equity: 20, cash: 20 });
      desk.store.insertLiveEquity({ t: 2_000, equity: 21.5, cash: 16 });
      expect(desk.store.liveEquityCurve(0)).toEqual([
        { t: 1_000, equity: 20, cash: 20 },
        { t: 2_000, equity: 21.5, cash: 16 }
      ]);
      expect(desk.store.equitySince(0).some((p) => p.equity === 21.5)).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("keeps the high and the low when a long curve is thinned to 240 points", () => {
    const desk = new Desk(testConfig());
    try {
      for (let i = 0; i < 5_000; i += 1) desk.store.insertLiveEquity({ t: 1_000 + i * 10_000, equity: i === 2_500 ? 99 : i === 3_000 ? 1 : 20 + (i % 7) * 0.01, cash: 5 });
      const curve = desk.store.liveEquityCurve(0);
      expect(curve.length).toBeLessThanOrEqual(240);
      expect(Math.max(...curve.map((p) => p.equity))).toBe(99);
      expect(Math.min(...curve.map((p) => p.equity))).toBe(1);
      expect(curve[0]!.t).toBe(1_000);
      expect(curve[curve.length - 1]!.t).toBe(1_000 + 4_999 * 10_000);
      expect(desk.store.liveEquityCurve(0)).toBe(curve);
    } finally {
      desk.stop();
    }
  });

  it("samples the live book only while the wallet read is good", async () => {
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const encode = (bytes: Uint8Array) => {
      let n = 0n;
      for (const b of bytes) n = n * 256n + BigInt(b);
      let out = "";
      while (n > 0n) {
        out = B58[Number(n % 58n)] + out;
        n /= 58n;
      }
      return out;
    };
    const secret = encode(Keypair.generate().secretKey);
    let fail = true;
    const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), {
      walletBalances: async () => (fail ? { sol: null, usdc: null, at: Date.now(), error: "RPC down" } : { sol: 0.5, usdc: 42, at: Date.now(), error: null })
    });
    try {
      const raw = desk as unknown as { markEquity: (force?: boolean) => void; lastLiveEquityAt: number };
      await desk.refreshWallet();
      raw.markEquity(true);
      expect(desk.store.liveEquityCurve(0)).toHaveLength(0);
      fail = false;
      await desk.refreshWallet();
      raw.markEquity(true);
      const curve = desk.store.liveEquityCurve(0);
      expect(curve).toHaveLength(1);
      expect(curve[0]).toMatchObject({ equity: 42, cash: 42 });
      expect(desk.snapshot().liveBook?.equity).toHaveLength(1);
      // Unchanged and inside a minute: not saved again.
      raw.lastLiveEquityAt -= 20_000;
      raw.markEquity(true);
      expect(desk.store.liveEquityCurve(0)).toHaveLength(1);
    } finally {
      desk.stop();
    }
  });
});

describe("13.41 gzip", () => {
  it("gzips a large JSON reply for a client that accepts it, and sends small ones plain", async () => {
    const desk = new Desk(testConfig());
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const http = await import("node:http");
      const get = (path: string, accept: string) =>
        new Promise<{ headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
          http
            .get(`${base}${path}`, { headers: { "accept-encoding": accept } }, (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
            })
            .on("error", reject);
        });
      const packed = await get("/api/state", "gzip");
      expect(packed.headers["content-encoding"]).toBe("gzip");
      const state = JSON.parse(gunzipSync(packed.body).toString("utf8"));
      expect(state.mode).toBe("paper");
      const plain = await get("/api/state", "identity");
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(JSON.parse(plain.body.toString("utf8")).mode).toBe("paper");
      expect(packed.body.length).toBeLessThan(plain.body.length / 2);
      const replay = await (await fetch(`${base}/api/market/replay?days=2`)).json();
      expect(replay).toMatchObject({ ok: true, quotes: 0, stats: { enabled: true } });
      const csv = await fetch(`${base}/api/market/quotes?format=csv`);
      expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
      expect((await csv.text()).startsWith("t,mint,symbol")).toBe(true);
    } finally {
      server.close();
      desk.stop();
    }
  });
});
