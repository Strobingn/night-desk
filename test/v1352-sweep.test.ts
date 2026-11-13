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
});
