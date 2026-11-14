import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Scout } from "../src/agents/scout.js";
import { EventBus } from "../src/bus.js";
import { KillMemory, type PrefilterThresholds } from "../src/market/prefilter.js";
import { SWEEP_BATCH, SWEEP_LOOKS_MS, SweepSchedule } from "../src/market/sweep.js";
import type { DeskEvents, RawSighting } from "../src/types.js";

const RPC = "https://rpc.example.test";
const DEX = "https://api.dexscreener.com/tokens/v1/solana/";
const LAST = SWEEP_LOOKS_MS[SWEEP_LOOKS_MS.length - 1]!;

const thresholds: PrefilterThresholds = {
  minVolume1hUsd: 10_000,
  minLiquidityUsd: 4_000,
  minAgeSeconds: 0,
  maxAgeSeconds: 0,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  bannedMints: new Set()
};

const mintOf = () => Keypair.generate().publicKey.toBase58();
/** A Pump stream create: a name and a creator, no numbers. */
const create = (mint: string, over: Partial<RawSighting> = {}): RawSighting => ({ mint, symbol: "NEW", name: "New Coin", source: "pumpfun", devWallet: "Dev1111", observedAt: Date.now(), ...over });

type DexRow = { vol?: number; liq?: number; price?: number };

function harness(book: Map<string, DexRow>, opts: { dexFails?: () => boolean } = {}) {
  const dexCalls: string[][] = [];
  let other = 0;
  const kills: Array<{ mint: string; codes: string[] }> = [];
  const memory = new KillMemory();
  const scout = new Scout({
    bus: new EventBus<DeskEvents>(),
    feedMode: "live",
    demo: false,
    rpcUrl: RPC,
    pumpWsUrl: "ws://unused",
    enrichConcurrency: 4,
    fetchImpl: (async (input: unknown) => {
      const url = String(input);
      if (!url.startsWith(DEX)) {
        other += 1;
        return Response.json({ pairs: [] });
      }
      const mints = url.slice(DEX.length).split(",");
      dexCalls.push(mints);
      if (opts.dexFails?.()) return new Response("slow down", { status: 429 });
      return Response.json(
        mints
          .filter((mint) => book.has(mint))
          .map((mint) => {
            const row = book.get(mint)!;
            return {
              baseToken: { address: mint },
              dexId: "pumpfun",
              priceUsd: String(row.price ?? 0.00002),
              volume: { h1: row.vol, m5: row.vol },
              ...(row.liq != null ? { liquidity: { usd: row.liq } } : {}),
              pairCreatedAt: Date.now() - 20_000
            };
          })
      );
    }) as typeof fetch,
    prefilter: () => thresholds,
    killMemory: memory,
    onPrefilterKill: (raw, reasons) => kills.push({ mint: raw.mint, codes: reasons.map((reason) => reason.code) }),
    onStatus: () => {}
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  return { scout, dexCalls, kills, memory, settle, otherCalls: () => other, sweep: () => scout.prefilterView().sweep };
}

describe("v13.52 sweep schedule", () => {
  it("hands out the youngest coins first and spends one look each", () => {
    const sweep = new SweepSchedule();
    sweep.watch(create("old"), 0);
    sweep.watch(create("young"), 5_000);
    expect(sweep.due(9_000, 10)).toEqual([]);
    expect(sweep.due(15_000, 10).map((entry) => entry.item.raw.mint)).toEqual(["young", "old"]);
    expect(sweep.due(15_500, 10)).toEqual([]); // both looks spent until the next age
  });

  it("skips looks it was too busy for and marks the final one", () => {
    const sweep = new SweepSchedule();
    sweep.watch(create("a"), 0);
    const late = sweep.due(130_000, 10); // past the 10 s, 25 s, 45 s, 75 s and 120 s looks
    expect(late).toHaveLength(1);
    expect(late[0]!.last).toBe(false);
    expect(sweep.due(131_000, 10)).toEqual([]);
    expect(sweep.due(LAST, 10)[0]!.last).toBe(true);
  });

  it("gives a look back after a failed request and never re-watches a finished coin", () => {
    const sweep = new SweepSchedule();
    sweep.watch(create("a"), 0);
    expect(sweep.due(10_000, 10)).toHaveLength(1);
    sweep.giveBack("a");
    expect(sweep.due(10_000, 10)).toHaveLength(1);
    sweep.finish("a");
    expect(sweep.watch(create("a"), 20_000)).toBe(false);
    expect(sweep.size).toBe(0);
  });

  it("keeps the earliest creation time when a parked coin is sighted again", () => {
    const sweep = new SweepSchedule();
    sweep.watch(create("a", { createdAt: 1_000 }), 0);
    sweep.watch(create("a", { createdAt: 9_000, volume1hUsd: 5 }), 10);
    const [entry] = sweep.due(10_000, 10);
    expect(entry!.item.raw).toMatchObject({ createdAt: 1_000, volume1hUsd: 5 });
  });

  it("drops the oldest coin when it is full", () => {
    const sweep = new SweepSchedule(SWEEP_LOOKS_MS, 2);
    sweep.watch(create("a"), 0);
    sweep.watch(create("b"), 1);
    sweep.watch(create("c"), 2);
    expect(sweep.has("a")).toBe(false);
    expect(sweep.view()).toMatchObject({ watching: 2, evicted: 1 });
  });
});

describe("v13.52 fast sweep in the scout", () => {
  it("promotes a Pump stream create as soon as its volume clears the floor, with no second list print", async () => {
    const mint = mintOf();
    const h = harness(new Map([[mint, { vol: 50_000, liq: 9_000 }]]));
    h.scout.ingest(create(mint), "pump");
    await h.settle();
    expect(h.dexCalls).toHaveLength(0); // parked, nothing asked yet
    expect(h.otherCalls()).toBe(0); // and no RPC
    expect(h.sweep().watching).toBe(1);
    await h.scout.sweepTick(Date.now() + 11_000);
    await h.settle();
    expect(h.dexCalls).toEqual([[mint]]);
    expect(h.sweep()).toMatchObject({ promoted: 1, watching: 0 });
    expect(h.otherCalls()).toBeGreaterThan(0); // enrich ran
    expect(h.kills).toEqual([]);
    h.scout.stop();
  });

  it("keeps a quiet coin parked and kills it once, on the last look", async () => {
    const mint = mintOf();
    const h = harness(new Map([[mint, { vol: 300, liq: 9_000 }]]));
    h.scout.ingest(create(mint), "pump");
    await h.scout.sweepTick(Date.now() + 11_000);
    expect(h.kills).toEqual([]);
    expect(h.sweep().watching).toBe(1);
    await h.scout.sweepTick(Date.now() + LAST + 1_000);
    expect(h.kills).toEqual([{ mint, codes: ["VOLUME_TOO_LOW"] }]);
    expect(h.sweep()).toMatchObject({ watching: 0, expired: 1, promoted: 0 });
    expect(h.otherCalls()).toBe(0);
    h.scout.stop();
  });

  it("promotes a coin that warms up after a quiet first look", async () => {
    const mint = mintOf();
    const book = new Map<string, DexRow>([[mint, { vol: 300, liq: 9_000 }]]);
    const h = harness(book);
    h.scout.ingest(create(mint), "pump");
    await h.scout.sweepTick(Date.now() + 11_000);
    book.set(mint, { vol: 40_000, liq: 9_000 });
    await h.scout.sweepTick(Date.now() + 26_000);
    expect(h.sweep().promoted).toBe(1);
    expect(h.kills).toEqual([]);
    h.scout.stop();
  });

  it("brings back a coin a list feed killed for low volume, without waiting out the five-minute backoff", async () => {
    const mint = mintOf();
    const book = new Map<string, DexRow>([[mint, { vol: 60_000, liq: 9_000 }]]);
    const h = harness(book);
    h.scout.ingest(create(mint, { devWallet: undefined, volume1hUsd: 300, liquidityUsd: 9_000, priceUsd: 0.00002 }), "dexscreener");
    expect(h.kills).toEqual([{ mint, codes: ["VOLUME_TOO_LOW"] }]);
    await h.scout.sweepTick(Date.now() + 11_000);
    expect(h.sweep().promoted).toBe(1);
    expect(h.kills).toHaveLength(1); // not killed a second time
    h.scout.stop();
  });

  it("promotes on volume when DexScreener prints no depth for the curve", async () => {
    const mint = mintOf();
    const h = harness(new Map([[mint, { vol: 50_000 }]]));
    h.scout.ingest(create(mint), "pump");
    await h.scout.sweepTick(Date.now() + 11_000);
    expect(h.sweep().promoted).toBe(1);
    h.scout.stop();
  });

  it("looks up 45 parked coins in two requests", async () => {
    const mints = Array.from({ length: 45 }, mintOf);
    const h = harness(new Map());
    for (const mint of mints) h.scout.ingest(create(mint), "pump");
    await h.scout.sweepTick(Date.now() + 11_000);
    expect(h.dexCalls.map((call) => call.length).sort((a, b) => b - a)).toEqual([SWEEP_BATCH, 15]);
    expect(h.otherCalls()).toBe(0);
    expect(h.sweep().watching).toBe(45); // not on DexScreener yet: parked, not killed
    h.scout.stop();
  });

  it("decides nothing when DexScreener refuses, and asks again after the pause", async () => {
    const mint = mintOf();
    let failing = true;
    const h = harness(new Map([[mint, { vol: 50_000, liq: 9_000 }]]), { dexFails: () => failing });
    h.scout.ingest(create(mint), "pump");
    await h.scout.sweepTick(Date.now() + 11_000);
    expect(h.kills).toEqual([]);
    expect(h.sweep()).toMatchObject({ watching: 1, promoted: 0 });
    failing = false;
    expect(await h.scout.sweepTick(Date.now() + 12_000)).toBe(0); // cooling off
    await h.scout.sweepTick(Date.now() + 30_000);
    expect(h.sweep().promoted).toBe(1);
    h.scout.stop();
  });

  it("never sweeps a hard kill", async () => {
    const mint = mintOf();
    const h = harness(new Map([[mint, { vol: 50_000, liq: 9_000 }]]));
    h.scout.ingest(create(mint, { symbol: "https://scam.example", volume1hUsd: 50_000, liquidityUsd: 9_000 }), "dexscreener");
    expect(h.kills[0]!.codes).toContain("JUNK_NAME");
    expect(h.sweep().watching).toBe(0);
    await h.scout.sweepTick(Date.now() + 11_000);
    expect(h.dexCalls).toHaveLength(0);
    h.scout.stop();
  });
  it("does not wave a coin through when its age is the missing number", async () => {
    const mint = mintOf();
    const aged = { ...thresholds, maxAgeSeconds: 3_600 };
    const calls: string[] = [];
    const scout = new Scout({
      bus: new EventBus<DeskEvents>(),
      feedMode: "live",
      demo: false,
      rpcUrl: RPC,
      pumpWsUrl: "ws://unused",
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        calls.push(url);
        // Volume clears, depth is there, but no pairCreatedAt.
        if (url.startsWith(DEX)) return Response.json([{ baseToken: { address: mint }, priceUsd: "0.00002", volume: { h1: 50_000 }, liquidity: { usd: 9_000 } }]);
        return Response.json({ pairs: [] });
      }) as typeof fetch,
      prefilter: () => aged,
      killMemory: new KillMemory(),
      onStatus: () => {}
    });
    // A list sighting, not a Pump create: the desk did not see it born.
    scout.ingest(create(mint, { devWallet: undefined, source: "raydium" }), "jupiter");
    await scout.sweepTick(Date.now() + 11_000);
    expect(scout.prefilterView().sweep).toMatchObject({ promoted: 0, watching: 1 });
    expect(calls.every((url) => url.startsWith(DEX))).toBe(true);
    scout.stop();
  });

  it("remembers a hard kill the sweep finds on a coin that was only soft-killed", async () => {
    const mint = mintOf();
    // Price a thousand times the first print: a decimals-scale jump, a hard kill.
    const h = harness(new Map([[mint, { vol: 60_000, liq: 9_000, price: 20 }]]));
    h.scout.ingest(create(mint, { devWallet: undefined, volume1hUsd: 300, liquidityUsd: 9_000, priceUsd: 0.00002 }), "dexscreener");
    expect(h.memory.isHard(mint)).toBe(false);
    await h.scout.sweepTick(Date.now() + 11_000);
    expect(h.sweep()).toMatchObject({ promoted: 0, watching: 0 });
    expect(h.memory.isHard(mint)).toBe(true);
    expect(h.kills).toHaveLength(1); // counted once
    h.scout.stop();
  });
  it("does not promote a pool DexScreener prints with zero depth", async () => {
    const mint = mintOf();
    const h = harness(new Map([[mint, { vol: 50_000, liq: 0 }]]));
    h.scout.ingest(create(mint), "pump");
    await h.scout.sweepTick(Date.now() + 11_000);
    expect(h.sweep()).toMatchObject({ promoted: 0, watching: 1 });
    expect(h.otherCalls()).toBe(0);
    h.scout.stop();
  });

  it("uses the Pump create time as the age, and makes none up for a listing that looks like one", async () => {
    const aged = { ...thresholds, maxAgeSeconds: 3_600 };
    const fromStream = mintOf();
    const fromList = mintOf();
    const scout = new Scout({
      bus: new EventBus<DeskEvents>(),
      feedMode: "live",
      demo: false,
      rpcUrl: RPC,
      pumpWsUrl: "ws://unused",
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        if (!url.startsWith(DEX)) return Response.json({ pairs: [] });
        // No pairCreatedAt on either.
        return Response.json(url.slice(DEX.length).split(",").map((mint) => ({ baseToken: { address: mint }, priceUsd: "0.00002", volume: { h1: 50_000 }, liquidity: { usd: 9_000 } })));
      }) as typeof fetch,
      prefilter: () => aged,
      killMemory: new KillMemory(),
      onStatus: () => {}
    });
    scout.ingest(create(fromStream), "pump");
    // Jupiter's recent list also says pumpfun and names the developer.
    scout.ingest(create(fromList), "jupiter");
    await scout.sweepTick(Date.now() + 11_000);
    expect(scout.prefilterView().sweep).toMatchObject({ promoted: 1, watching: 1 });
    scout.stop();
  });
  it("keeps the earliest birth time when a later look shows a newer pool", async () => {
    const mint = mintOf();
    const aged = { ...thresholds, maxAgeSeconds: 600 };
    const scout = new Scout({
      bus: new EventBus<DeskEvents>(),
      feedMode: "live",
      demo: false,
      rpcUrl: RPC,
      pumpWsUrl: "ws://unused",
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        if (!url.startsWith(DEX)) return Response.json({ pairs: [] });
        // A pool created a few seconds ago, on a coin first listed an hour ago.
        return Response.json([{ baseToken: { address: mint }, priceUsd: "0.00002", volume: { h1: 50_000 }, liquidity: { usd: 9_000 }, pairCreatedAt: Date.now() - 5_000 }]);
      }) as typeof fetch,
      prefilter: () => aged,
      killMemory: new KillMemory(),
      onStatus: () => {}
    });
    scout.ingest(create(mint, { devWallet: undefined, createdAt: Date.now() - 3_600_000, volume1hUsd: 300, liquidityUsd: 9_000 }), "dexscreener");
    scout.ingest(create(mint, { devWallet: undefined }), "jupiter");
    await scout.sweepTick(Date.now() + 11_000);
    expect(scout.prefilterView().sweep.promoted).toBe(0); // still an hour old: past the ten-minute limit
    scout.stop();
  });
});

describe("v13.52 sweep follow-ups", () => {
  it("anchors the price from a quiet look, so a later print a thousand times higher is a hard kill", async () => {
    const mint = mintOf();
    const book = new Map<string, DexRow>([[mint, { vol: 300, liq: 9_000, price: 0.00002 }]]);
    const h = harness(book);
    h.scout.ingest(create(mint), "pump");
    await h.scout.sweepTick(Date.now() + 11_000);
    book.set(mint, { vol: 60_000, liq: 9_000, price: 0.02 });
    await h.scout.sweepTick(Date.now() + 26_000);
    expect(h.sweep().promoted).toBe(0);
    expect(h.kills.at(-1)!.codes).toContain("PRICE_UNUSABLE");
    expect(h.otherCalls()).toBe(0);
    h.scout.stop();
  });

  it("stamps a promoted coin with the promotion time, not the time it was first seen", async () => {
    const mint = mintOf();
    const seen: number[] = [];
    const bus = new EventBus<DeskEvents>();
    bus.on("scout.candidate", (token) => {
      seen.push(token.discoveredAt);
    });
    const scout = new Scout({
      bus,
      feedMode: "live",
      demo: false,
      pumpWsUrl: "ws://unused",
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        const row = { baseToken: { address: mint, symbol: "NEW", name: "New Coin" }, dexId: "pumpfun", priceUsd: "0.00002", volume: { h1: 50_000 }, liquidity: { usd: 9_000 }, pairCreatedAt: Date.now() - 60_000 };
        if (url.startsWith(DEX)) return Response.json([row]);
        return Response.json({ pairs: [row] });
      }) as typeof fetch,
      prefilter: () => thresholds,
      killMemory: new KillMemory(),
      onStatus: () => {}
    });
    const firstSeen = Date.now() - 8 * 60_000;
    scout.ingest(create(mint, { observedAt: firstSeen }), "pump");
    const before = Date.now();
    await scout.sweepTick(Date.now() + 11_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(scout.prefilterView().sweep.promoted).toBe(1);
    expect(seen.length).toBe(1);
    expect(seen[0]!).toBeGreaterThanOrEqual(before);
    scout.stop();
  });
});

describe("v13.52 DexScreener row depth flag", () => {
  it("says depth is unknown when the priced pair prints none, whatever another pair prints", async () => {
    const { fetchDexTape } = await import("../src/market/tape-quotes.js");
    const mint = mintOf();
    const priced = { baseToken: { address: mint }, priceUsd: "0.00002", volume: { h1: 50_000 } };
    const unpriced = { baseToken: { address: mint }, liquidity: { usd: 9_000 }, volume: { h1: 10 } };
    for (const rows of [[priced, unpriced], [unpriced, priced]]) {
      const out = await fetchDexTape([mint], (async () => Response.json(rows)) as typeof fetch);
      expect(out.get(mint)).toMatchObject({ priceUsd: 0.00002, liquidityUsd: 0 });
      expect(out.get(mint)!.liquidityKnown).toBeUndefined();
    }
  });
});
