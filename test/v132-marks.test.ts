import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { ChainMarkReader, PUMPSWAP_PROGRAM, PUMP_PROGRAM, WSOL_MINT, base58, isPubkey, parseCurve, parsePumpSwapPool, tokenAmount } from "../src/market/chain-marks.js";
import { HeldQuoteBook, SOURCE_MIN_MS } from "../src/market/dex-prices.js";
import { LIVE_FRESH_MS, reanchorCandidate } from "../src/market/mark-guard.js";
import { CAL_MIN, PositionPricer } from "../src/market/position-pricer.js";
import { ERROR_BACKOFF, RATE_LIMIT_BACKOFF, SourceGate } from "../src/market/source-gate.js";
import { parseCoinInput } from "../src/market/coin-input.js";
import { POSITION_REFRESH_BAND, clampPositionRefreshMs } from "../src/rules.js";
import { startServer } from "../src/server/http.js";
import { chartLinks } from "../web/src/format.js";
import { mergeMarks, markFreshness, stampSnapshot, updatedLabel, liveAgeMs } from "../web/src/marks.js";
import type { DeskSnapshot } from "../src/types.js";
import { testConfig, testDesk } from "./helpers.js";

// Real-shaped Solana keys (HALVE and its PumpSwap pool), so the chain reader accepts them.
const MINT = "9dGdEhbke3J8kBNfb3TUmm2qqfVfLZHS7scxxpCNpump";
const POOL = "6WF6bSKyCPrtdu9qd4mdQXotTamCzYe8uvzxxEhcy43x";
const BASE_VAULT = "BJMBw53wYuSMxkvLd2h3zKHMnXa2yskBGX9qie7t3Mg";
const QUOTE_VAULT = "AxcAjRm2bPpFxbdddW8JDkn9p5JnuAm8xbN9h4YnooHG";
const CURVE = "EVtoJMrdcEFSpNuLiSiysXjn7Mr5poj9CSckd6bThfVk";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decode58(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    out.unshift(0);
  }
  while (out.length < 32) out.unshift(0);
  return Uint8Array.from(out);
}
function u64le(buf: Uint8Array, offset: number, value: bigint) {
  new DataView(buf.buffer).setBigUint64(offset, value, true);
}
function poolData(): Uint8Array {
  const d = new Uint8Array(301);
  d.set(decode58(MINT), 43);
  d.set(decode58(WSOL_MINT), 75);
  d.set(decode58(BASE_VAULT), 139);
  d.set(decode58(QUOTE_VAULT), 171);
  return d;
}
function mintData(decimals = 6): Uint8Array {
  const d = new Uint8Array(82);
  d[44] = decimals;
  return d;
}
function tokenAccount(raw: bigint): Uint8Array {
  const d = new Uint8Array(165);
  u64le(d, 64, raw);
  return d;
}
function curveData(vTok: bigint, vSol: bigint, complete = false): Uint8Array {
  const d = new Uint8Array(150);
  u64le(d, 8, vTok);
  u64le(d, 16, vSol);
  d[48] = complete ? 1 : 0;
  return d;
}
const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");

/** A mock Solana RPC: a PumpSwap pool with `pool.base` tokens and `pool.quote` SOL. */
function mockRpc(pool: { base: number; quote: number }, calls: string[][] = []) {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params: [string[]] };
    const keys = body.params[0];
    calls.push(keys);
    const value = keys.map((key) => {
      if (key === POOL) return { owner: PUMPSWAP_PROGRAM, data: [b64(poolData()), "base64"] };
      if (key === MINT) return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [b64(mintData()), "base64"] };
      if (key === BASE_VAULT) return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [b64(tokenAccount(BigInt(Math.round(pool.base * 1e6)))), "base64"] };
      if (key === QUOTE_VAULT) return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [b64(tokenAccount(BigInt(Math.round(pool.quote * 1e9)))), "base64"] };
      return null;
    });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value } });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("v13.2 source pacing and backoff", () => {
  it("cools a 429 for 5 s doubling to 60 s, a 5xx for 2 s doubling to 30 s, and resets on success", () => {
    const gate = new SourceGate(1_000);
    expect(gate.due(0)).toBe(true);
    gate.started(0);
    expect(gate.due(500)).toBe(false);
    expect(gate.due(500, true)).toBe(true);
    expect(gate.fail("jupiter HTTP 429", 1_000)).toBe(RATE_LIMIT_BACKOFF.baseMs);
    expect(gate.due(5_999, true)).toBe(false);
    expect(gate.fail("jupiter HTTP 429", 6_000)).toBe(10_000);
    for (let i = 0; i < 6; i += 1) gate.fail("HTTP 429", 20_000);
    expect(gate.fail("HTTP 429", 20_000)).toBe(RATE_LIMIT_BACKOFF.capMs);
    gate.ok(100_000);
    expect(gate.fail("rpc HTTP 503", 100_000)).toBe(ERROR_BACKOFF.baseMs);
    expect(gate.fail("The operation was aborted due to timeout", 100_000)).toBe(4_000);
    gate.ok(200_000);
    expect(gate.fail("HTTP 429", 200_000)).toBe(RATE_LIMIT_BACKOFF.baseMs);
  });

  it("does not call a source while it cools, and keeps pricing from the other one", async () => {
    const book = new HeldQuoteBook();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes("api.jup.ag")) return new Response("", { status: 429 });
      return Response.json([{ baseToken: { address: MINT }, priceUsd: "0.0002", liquidity: { usd: 30_000 }, pairAddress: POOL, dexId: "pumpswap" }]);
    }) as typeof fetch;
    const first = await book.fetchSources([MINT], ["dexscreener", "jupiter"], fetchImpl, 1_000);
    expect(first.find((r) => r.source === "jupiter")?.error).toContain("429");
    expect(first.find((r) => r.source === "dexscreener")?.quotes?.get(MINT)?.priceUsd).toBe(0.0002);
    const jupCalls = urls.filter((u) => u.includes("api.jup.ag")).length;
    await book.fetchSources([MINT], ["dexscreener", "jupiter"], fetchImpl, 3_000);
    expect(urls.filter((u) => u.includes("api.jup.ag")).length).toBe(jupCalls);
    await book.fetchSources([MINT], ["jupiter"], fetchImpl, 6_001);
    expect(urls.filter((u) => u.includes("api.jup.ag")).length).toBe(jupCalls + 1);
  });

  it("publishes the Dex mark while a pool read is still waiting on the RPC queue", async () => {
    let now = 0;
    let release: () => void = () => {};
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ticks: number[] = [];
    let rpcStarts = 0;
    const fetchImpl = (async (url: string) => {
      if (url.startsWith("http://rpc")) {
        rpcStarts += 1;
        await queued;
        return Response.json({ jsonrpc: "2.0", result: { value: [null, null] } });
      }
      if (url.includes("dexscreener")) {
        return Response.json([{ baseToken: { address: MINT }, priceUsd: "1.25", liquidity: { usd: 30_000 }, pairAddress: POOL, dexId: "pumpswap" }]);
      }
      return Response.json({});
    }) as typeof fetch;
    const pricer = new PositionPricer({
      heldMints: () => [MINT],
      pairFor: () => POOL,
      tick: (_mint, price) => ticks.push(price),
      onStale: () => {},
      fetchImpl,
      now: () => now,
      chain: new ChainMarkReader("http://rpc", fetchImpl, 10_000)
    });
    await pricer.cycle(false);
    expect(ticks).toEqual([1.25]);
    expect(rpcStarts).toBe(1);
    now = 4_000;
    await pricer.cycle(false);
    expect(ticks).toEqual([1.25, 1.25]);
    // The 9/min pool read is still queued. A second Dex mark must not wait for it or start another read.
    expect(rpcStarts).toBe(1);
    release();
  });

  it("stamps a pool read that waited out the public RPC queue with the decode time", async () => {
    let now = 0;
    let release: () => void = () => {};
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rpcStarts = 0;
    const live: Array<{ at: number }> = [];
    const curve = curveData(1_000_000_000_000_000n, 30_000_000_000n);
    u64le(curve, 32, 1_000_000_000n);
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.startsWith("http://rpc")) {
        rpcStarts += 1;
        await queued;
        const body = JSON.parse(String(init?.body)) as { params: [string[]] };
        const value = body.params[0].map((key) => {
          if (key === CURVE) return { owner: PUMP_PROGRAM, data: [b64(curve), "base64"] };
          if (key === MINT) return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [b64(mintData()), "base64"] };
          return null;
        });
        return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });
      }
      if (url.includes("dexscreener")) {
        return Response.json([{ baseToken: { address: MINT }, priceUsd: "0.0000045", liquidity: { usd: 30_000 }, pairAddress: CURVE, dexId: "pumpfun" }]);
      }
      if (url.includes("api.jup.ag")) return Response.json({ [WSOL_MINT]: { usdPrice: 150 } });
      return Response.json({});
    }) as typeof fetch;
    const pricer = new PositionPricer({
      heldMints: () => [MINT],
      pairFor: () => CURVE,
      tick: () => {},
      live: (_mint, _price, origin) => live.push({ at: origin.at }),
      onStale: () => {},
      fetchImpl,
      now: () => now,
      chain: new ChainMarkReader("http://rpc", fetchImpl, 10_000)
    });
    await pricer.cycle(false);
    expect(rpcStarts).toBe(1);
    now = 4_000;
    await pricer.cycle(false);
    expect(rpcStarts).toBe(1);
    now = 8_000;
    expect(now - 0).toBeGreaterThan(LIVE_FRESH_MS);
    release();
    await vi.waitUntil(() => live.length === 1);
    // A cycle-start stamp of 0 would already be older than the 5s live window.
    expect(live[0].at).toBe(8_000);
    expect(now - live[0].at).toBeLessThanOrEqual(LIVE_FRESH_MS);
  });

  it("runs a 1.5 s cycle but asks DexScreener at most every 3 s and Jupiter every 5 s", async () => {
    let now = 0;
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes("dexscreener")) return Response.json([{ baseToken: { address: MINT }, priceUsd: "0.0002", liquidity: { usd: 30_000 } }]);
      return Response.json({ [MINT]: { usdPrice: 0.0002 } });
    }) as typeof fetch;
    const pricer = new PositionPricer({ heldMints: () => [MINT], tick: () => {}, onStale: () => {}, fetchImpl, now: () => now });
    for (now = 0; now <= 15_000; now += 1_500) await pricer.cycle(false);
    const dex = urls.filter((u) => u.includes("dexscreener")).length;
    const jup = urls.filter((u) => u.includes("api.jup.ag")).length;
    expect(SOURCE_MIN_MS.dexscreener).toBe(3_000);
    expect(SOURCE_MIN_MS.jupiter).toBe(5_000);
    expect(dex).toBeLessThanOrEqual(6); // 15 s / 3 s + the first
    expect(jup).toBeLessThanOrEqual(4); // 15 s / 5 s + the first
    expect(dex).toBeGreaterThanOrEqual(5);
    expect(jup).toBeGreaterThanOrEqual(3);
  });

  it("a stop confirmation asks the entry feed early, but never inside a cool-off", async () => {
    let now = 0;
    const urls: string[] = [];
    let jupStatus = 200;
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes("api.jup.ag")) return jupStatus === 200 ? Response.json({ [MINT]: { usdPrice: 0.0002 } }) : new Response("", { status: jupStatus });
      return Response.json([]);
    }) as typeof fetch;
    const pricer = new PositionPricer({ heldMints: () => [MINT], tick: () => {}, onStale: () => {}, fetchImpl, now: () => now });
    await pricer.cycle(false);
    const before = urls.filter((u) => u.includes("api.jup.ag")).length;
    now = 1_600;
    pricer.confirm(MINT);
    await pricer.cycle(false);
    expect(urls.filter((u) => u.includes("api.jup.ag")).length).toBe(before + 1);
    jupStatus = 429;
    now = 3_200;
    pricer.confirm(MINT);
    await pricer.cycle(false); // 429 → cools 5 s
    const after429 = urls.filter((u) => u.includes("api.jup.ag")).length;
    now = 4_800;
    pricer.confirm(MINT);
    await pricer.cycle(false);
    expect(urls.filter((u) => u.includes("api.jup.ag")).length).toBe(after429);
  });
});

describe("v13.2 on-chain pool marks", () => {
  it("decodes keys, curves, PumpSwap pools and token balances", () => {
    expect(base58(decode58(POOL))).toBe(POOL);
    expect(isPubkey(POOL)).toBe(true);
    expect(isPubkey("CURVE")).toBe(false);
    expect(isPubkey("CmoMint11111111111111111111111111111111111")).toBe(false);
    const curve = parseCurve(curveData(1_000_000_000_000_000n, 30_000_000_000n), 6);
    expect(curve?.native).toBeCloseTo(3e-8, 15);
    expect(curve?.complete).toBe(false);
    expect(parseCurve(curveData(0n, 1n), 6)).toBeNull();
    const pool = parsePumpSwapPool(poolData());
    expect(pool).toEqual({ baseMint: MINT, quoteMint: WSOL_MINT, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT, virtualQuoteReserves: 0n });
    expect(tokenAmount(tokenAccount(123n))).toBe(123);
  });

  it("does not restamp a websocket copy when the poll clock has moved on", async () => {
    let calls = 0;
    const curve = curveData(1_000_000_000_000_000n, 30_000_000_000n);
    u64le(curve, 32, 1_000_000_000n);
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { params: [string[]] };
      const value = body.params[0].map((key) => {
        if (key === CURVE) return { owner: PUMP_PROGRAM, data: [b64(curve), "base64"] };
        if (key === MINT) return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [b64(mintData()), "base64"] };
        return null;
      });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });
    }) as typeof fetch;
    const reader = new ChainMarkReader("http://rpc", fetchImpl, 0);
    const first = await reader.read([{ mint: MINT, pair: CURVE }], 1_000);
    expect(first.get(MINT)?.at).toBe(1_000);
    reader.noteAccount(CURVE, curve, 1_000);
    const callsAfterPoll = calls;
    const cached = await reader.read([{ mint: MINT, pair: CURVE }], 20_000, 60_000, () => 99_000);
    expect(cached.get(MINT)?.at).toBe(1_000);
    expect(calls).toBe(callsAfterPoll);
    expect(99_000 - 1_000).toBeGreaterThan(LIVE_FRESH_MS);
  });

  it("reads a PumpSwap pool in one batched call, skips fixtures and dead curves", async () => {
    const calls: string[][] = [];
    const reader = new ChainMarkReader("http://rpc", mockRpc({ base: 100_000_000, quote: 125 }, calls));
    const reads = await reader.read(
      [
        { mint: MINT, pair: POOL },
        { mint: "CmoMint11111111111111111111111111111111111", pair: "CURVE" }
      ],
      1_000
    );
    expect(reads.get(MINT)?.native).toBeCloseTo(1.25e-6, 12);
    expect(reads.get(MINT)?.kind).toBe("pumpswap");
    expect(calls.flat()).not.toContain("CURVE");
    const again = await reader.read([{ mint: MINT, pair: POOL }], 2_000);
    expect(again.get(MINT)?.native).toBeCloseTo(1.25e-6, 12);
    expect(calls[calls.length - 1]).toEqual([BASE_VAULT, QUOTE_VAULT]);
  });

  it("prices a PumpSwap pool as vault ratio times SOL/USD once a quote agrees, and stops when the quote disagrees", async () => {
    let now = 0;
    let jup = 2.1e-4;
    const lives: number[] = [];
    const fetchImpl = (async (url: string) => {
      if (url.includes("api.jup.ag")) return Response.json({ [MINT]: { usdPrice: jup }, [WSOL_MINT]: { usdPrice: 150 } });
      return Response.json([]);
    }) as typeof fetch;
    const pricer = new PositionPricer({
      heldMints: () => [MINT],
      pairFor: () => POOL,
      tick: () => {},
      live: (_m, p) => lives.push(p),
      onStale: () => {},
      fetchImpl,
      now: () => now,
      chain: new ChainMarkReader("http://rpc", mockRpc({ base: 100_000_000, quote: 125 }))
    });
    await pricer.poll();
    expect(CAL_MIN).toBe(2);
    // 125 SOL / 1e8 coins = 1.25e-6 SOL, times $150. The Jupiter print is the cross-check, not the mark.
    expect(lives).toHaveLength(1);
    expect(lives[0]).toBeCloseTo(1.25e-6 * 150, 10);
    // Jupiter 20% off SOL/USD fails the cross-check: the chain mark does not follow it.
    jup = 2.52e-4;
    now = 12_000;
    await pricer.poll();
    expect(lives).toHaveLength(1);
  });
});

describe("v13.2 the fast loop cannot create a false stop", () => {
  const entryToken = (overrides = {}) =>
    makeToken({ mint: MINT, symbol: "HALVE", priceUsd: 0.0002, liquidityUsd: 180_000, source: "pumpfun", priceFeed: "dexscreener", pairAddress: POOL, dex: "pumpswap", ...overrides });

  function dexDesk(price: () => string) {
    return testDesk(
      {},
      {
        priceFetch: (async (url: string) => {
          if (String(url).includes("dexscreener")) return Response.json([{ baseToken: { address: MINT }, priceUsd: price(), liquidity: { usd: 180_000 }, pairAddress: POOL, dexId: "pumpswap" }]);
          return Response.json({});
        }) as typeof fetch
      }
    );
  }

  it("ignores 0 and NaN marks and logs PRICE_UNUSABLE once", async () => {
    let p = "0";
    const desk = dexDesk(() => p);
    try {
      await desk.submitCandidate(entryToken());
      for (const bad of ["0", "NaN", "0", "-1"]) {
        p = bad;
        await desk.repricePositions();
      }
      expect(desk.book.positions.has(MINT)).toBe(true);
      expect(desk.snapshot().closed).toHaveLength(0);
    } finally {
      desk.stop();
    }
  });

  it("holds one >30% outlier print, and stops when the same feed repeats it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    let p = "0.0002";
    const desk = dexDesk(() => p);
    try {
      await desk.submitCandidate(entryToken());
      const entry = desk.book.positions.get(MINT)!.entryPrice;
      vi.setSystemTime(1_800_000_015_000); // past the 10 s entry window
      p = String(entry * 0.5);
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(true);
      expect(desk.snapshot().events.some((e) => e.code === "PRICE_UNCONFIRMED" && e.message.includes("jump"))).toBe(true);
      vi.setSystemTime(1_800_000_016_500);
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(desk.snapshot().events.some((e) => (e.code === "STOP_LOSS" || e.code === "GAP_RUG"))).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("still stops at −6% on the first valid mark from the entry feed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    let p = "0.0002";
    const desk = dexDesk(() => p);
    try {
      await desk.submitCandidate(entryToken());
      const held = desk.book.positions.get(MINT)!;
      const basis = held.entryMark != null && held.entryMark > 0 ? held.entryMark : held.entryPrice;
      vi.setSystemTime(1_800_000_020_000);
      p = String(basis * 0.95);
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(true);
      vi.setSystemTime(1_800_000_021_500);
      p = String(basis * 0.935);
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(desk.snapshot().events.some((e) => (e.code === "STOP_LOSS" || e.code === "GAP_RUG"))).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("re-anchors a position whose entry feed went silent (the DSGHOST hole) and then stops it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_000_000;
    vi.setSystemTime(t0);
    let dexPrice = "0.0002";
    const desk = testDesk(
      {},
      {
        priceFetch: (async (url: string) => {
          if (String(url).includes("dexscreener")) return Response.json([{ baseToken: { address: MINT }, priceUsd: dexPrice, liquidity: { usd: 900 }, pairAddress: POOL, dexId: "pumpswap" }]);
          return Response.json({}); // Jupiter stopped quoting the coin
        }) as typeof fetch
      }
    );
    try {
      await desk.submitCandidate(entryToken({ priceFeed: "jupiter", pairAddress: undefined }));
      const entry = desk.book.positions.get(MINT)!.entryPrice;
      dexPrice = String(entry * 0.036); // the real price after the rug
      for (const dt of [5_000, 10_000, 15_000]) {
        vi.setSystemTime(t0 + dt);
        await desk.repricePositions();
      }
      expect(desk.book.positions.has(MINT)).toBe(true); // not silent long enough yet
      vi.setSystemTime(t0 + 21_000);
      await desk.repricePositions(); // candidate
      vi.setSystemTime(t0 + 22_000);
      await desk.repricePositions(); // too soon to confirm
      expect(desk.book.positions.has(MINT)).toBe(true);
      vi.setSystemTime(t0 + 24_000);
      await desk.repricePositions(); // confirmed → re-anchor → stop
      const events = desk.snapshot().events;
      expect(events.some((e) => e.code === "PRICE_REANCHOR")).toBe(true);
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(events.some((e) => (e.code === "STOP_LOSS" || e.code === "GAP_RUG"))).toBe(true);
      // The rejects before the re-anchor were logged once, not once per tick.
      expect(events.filter((e) => e.code === "PRICE_SOURCE")).toHaveLength(1);
    } finally {
      desk.stop();
    }
  });

  it("never re-anchors onto a dust print", () => {
    const origin = { feed: "jupiter" };
    expect(reanchorCandidate(undefined, origin, 1e-12, 0.0002, 0).verdict).toBe("refuse");
    expect(reanchorCandidate(undefined, { feed: "chain", pairAddress: POOL }, 0.0002, 0.0002, 0).verdict).toBe("refuse");
    const first = reanchorCandidate(undefined, origin, 0.0001, 0.0002, 0);
    expect(first.verdict).toBe("wait");
    expect(reanchorCandidate(first.next, origin, 0.0001, 0.0002, 1_000).verdict).toBe("wait");
    expect(reanchorCandidate(first.next, origin, 0.0002, 0.0002, 3_000).verdict).toBe("wait"); // disagrees by 100%
    expect(reanchorCandidate(first.next, origin, 0.00011, 0.0002, 3_000).verdict).toBe("adopt");
  });

  it("a live pool mark below the stop moves the card but never closes the position; the entry feed does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_000_000;
    vi.setSystemTime(t0);
    const pool = { base: 100_000_000, quote: 125 };
    let jupStatus = 200;
    let price = 2.1e-4;
    let dexPrice = 2.1e-4;
    const desk = new Desk(testConfig(), {
      priceFetch: (async (url: string) => {
        if (String(url).includes("api.jup.ag")) {
          if (jupStatus !== 200) return new Response("", { status: jupStatus });
          return Response.json({ [MINT]: { usdPrice: price }, [WSOL_MINT]: { usdPrice: 150 } });
        }
        return Response.json([{ baseToken: { address: MINT }, priceUsd: String(dexPrice), liquidity: { usd: 180_000 }, pairAddress: POOL, dexId: "pumpswap" }]);
      }) as typeof fetch,
      chainFetch: mockRpc(pool)
    });
    try {
      await desk.submitCandidate(entryToken({ priceUsd: 2.1e-4 }));
      const entry = desk.book.positions.get(MINT)!.entryPrice;
      price = entry;
      dexPrice = entry;
      for (const dt of [6_000, 12_000]) {
        vi.setSystemTime(t0 + dt);
        await desk.repricePositions();
      }
      expect(desk.snapshot().positions[0]?.markFeed).toBe("chain");
      // The pool drops 10%. DexScreener still serves its cached print and Jupiter is rate-limited.
      pool.quote = 112.5;
      jupStatus = 429;
      vi.setSystemTime(t0 + 18_000);
      await desk.repricePositions();
      const card = desk.snapshot().positions[0]!;
      expect(card.markFeed).toBe("chain");
      expect(card.markPrice).toBeLessThan(card.stopPrice);
      expect(desk.book.positions.has(MINT)).toBe(true);
      expect(desk.snapshot().closed).toHaveLength(0);
      // The entry pool on DexScreener prints the drop: that is the mark the stop uses.
      dexPrice = entry * 0.9;
      vi.setSystemTime(t0 + 30_000);
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(false);
      expect(desk.snapshot().events.some((e) => (e.code === "STOP_LOSS" || e.code === "GAP_RUG"))).toBe(true);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.2 marks reach the phone as small deltas", () => {
  it("a marks delta is under 1 KB per position and carries markAt and the feed", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "HALVE", priceUsd: 0.0002, source: "pumpfun" }));
      await desk.markPrice(MINT, 0.000201);
      const delta = desk.marksDelta();
      expect(delta.positions).toHaveLength(1);
      expect(JSON.stringify({ type: "marks", data: delta }).length).toBeLessThan(1_000);
      expect(delta.positions[0]!.markAt).toBeGreaterThan(0);
      expect(JSON.stringify({ type: "snapshot", data: desk.snapshot() }).length).toBeGreaterThan(5 * JSON.stringify(delta).length);
    } finally {
      desk.stop();
    }
  });

  it("the server pushes {type:'marks'} after a position mark", async () => {
    const desk = new Desk(testConfig());
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const types: string[] = [];
    ws.on("message", (raw) => types.push((JSON.parse(String(raw)) as { type: string }).type));
    try {
      await once(ws, "open");
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "HALVE", priceUsd: 0.0002, source: "pumpfun" }));
      await desk.markPrice(MINT, 0.000202);
      await new Promise((r) => setTimeout(r, 600));
      expect(types).toContain("marks");
    } finally {
      ws.close();
      server.close();
      desk.stop();
    }
  });

  it("web merges deltas, ignores bad marks, and ages the card live", () => {
    const pos = { mint: MINT, symbol: "HALVE", markPrice: 1, markAgeMs: 500, pnlUsd: 0, pnlPct: 0, marketValueUsd: 10, stopPrice: 0.94, peakPrice: 1 };
    const snap = stampSnapshot({ positions: [pos], cashUsd: 90, equityUsd: 100 } as unknown as DeskSnapshot, 10_000);
    expect(snap.positions[0]!.markLocalAt).toBe(9_500);
    const delta = {
      now: 0,
      cashUsd: 90,
      equityUsd: 101,
      positions: [
        { mint: MINT, markPrice: 1.1, marketValueUsd: 11, pnlUsd: 1, pnlPct: 0.1, stopPrice: 0.94, peakPrice: 1.1, trailArmed: false, trailHintPrice: null, markAgeMs: 200, markAt: 1, markFeed: "chain" },
        { mint: "Other", markPrice: 5, marketValueUsd: 0, pnlUsd: 0, pnlPct: 0, stopPrice: 0, peakPrice: 0, trailArmed: false, trailHintPrice: null, markAgeMs: 0, markAt: 1, markFeed: "chain" }
      ]
    };
    const next = mergeMarks(snap, delta, 20_000)!;
    expect(next.positions).toHaveLength(1);
    expect(next.positions[0]!.markPrice).toBe(1.1);
    expect(next.positions[0]!.markFeed).toBe("chain");
    expect(next.equityUsd).toBe(101);
    expect(liveAgeMs(next.positions[0]!, 20_000 + 3_000)).toBe(3_200);
    const zero = mergeMarks(next, { ...delta, positions: [{ ...delta.positions[0]!, markPrice: 0 }] }, 30_000)!;
    expect(zero.positions[0]!.markPrice).toBe(1.1);
    expect(markFreshness(2_000)).toBe("fresh");
    expect(markFreshness(10_001)).toBe("amber");
    expect(markFreshness(30_001)).toBe("red");
    expect(updatedLabel(3_400)).toBe("updated 3s ago");
    expect(updatedLabel(500)).toBe("updated just now");
  });
});

describe("v13.2 Birdeye and the refresh setting", () => {
  it("links Birdeye at /solana/token/<mint> (the old ?chain=solana URL is a 404)", () => {
    const bird = chartLinks(MINT).find((l) => l.label === "Birdeye")!;
    expect(bird.href).toBe(`https://birdeye.so/solana/token/${MINT}`);
    expect(bird.href).not.toContain("?chain=");
  });

  it("Add coin takes Birdeye and Birdeye Terminal links, and refuses other chains", () => {
    for (const url of [
      `https://birdeye.so/solana/token/${MINT}`,
      `https://birdeyeterminal.com/solana/token/${MINT}`,
      `https://birdeye.so/token/${MINT}?chain=solana`
    ]) {
      const parsed = parseCoinInput(url);
      expect(parsed.ok, url).toBe(true);
      if (parsed.ok) expect(parsed.address).toBe(MINT);
    }
    expect(parseCoinInput(`https://birdeye.so/bsc/token/${MINT}`).ok).toBe(false);
  });

  it("clamps the Position price refresh to 1–10 s in 0.5 s steps, default 1.5 s", () => {
    expect(POSITION_REFRESH_BAND.fallback).toBe(1_500);
    expect(clampPositionRefreshMs(1_500)).toBe(1_500);
    expect(clampPositionRefreshMs(200)).toBe(1_000);
    expect(clampPositionRefreshMs(2)).toBe(2_000);
    expect(clampPositionRefreshMs(99_999)).toBe(10_000);
    expect(clampPositionRefreshMs(Number.NaN)).toBe(1_500);
  });

  it("saving the refresh changes only that key; saved settings without it keep 1.5 s", () => {
    const desk = testDesk();
    try {
      expect(desk.updateSettings({ maxOpenPositions: 7 }).ok).toBe(true);
      expect(desk.snapshot().prefs.positionRefreshMs).toBe(1_500);
      const saved = desk.updateSettings({ positionRefreshMs: 2_500 });
      expect(saved.ok).toBe(true);
      const stored = desk.store.readJson("settings") as Record<string, unknown>;
      expect(stored.maxOpenPositions).toBe(7);
      expect(stored.positionRefreshMs).toBe(2_500);
      expect(desk.snapshot().prefs.positionRefreshMs).toBe(2_500);
      expect(desk.pricerStats().pollMs).toBe(2_500);
    } finally {
      desk.stop();
    }
  });
});
