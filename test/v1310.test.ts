import { describe, expect, it } from "vitest";
import { coinCards, parsePxText } from "../web/src/coins";
import { shortPx } from "../web/src/tapeToolbar";
import { fetchDexTape, TapeQuoter, TAPE_DEX_COOLOFF_MS, TAPE_STALE_MS, type DexTapeRow } from "../src/market/tape-quotes";
import type { FeedEvent } from "../src/types";

const ev = (over: Partial<FeedEvent>): FeedEvent => ({ id: Math.random().toString(36), ts: 1, stage: "scout", kind: "info", message: "", ...over });
const row = (p: number | null, extra: Partial<DexTapeRow> = {}): DexTapeRow => ({ priceUsd: p, vol1hUsd: 1000, vol5mUsd: 50, change1hPct: 4.2, liquidityUsd: 10, ...extra });

describe("v13.10 Tape prices", () => {
  it("parses the v13.8 subscript price text and never returns 0", () => {
    expect(parsePxText("0.0₅207")).toBeCloseTo(0.00000207, 15);
    expect(parsePxText("0.0₁₀4194")).toBeCloseTo(0.00000000004194, 20);
    expect(parsePxText("1.25")).toBe(1.25);
    expect(parsePxText("0")).toBeUndefined();
    expect(parsePxText("0.0")).toBeUndefined();
    expect(shortPx(0)).toBe("—");
  });

  it("a subscript Mark on the scout line is a real price (was the bug: parsed as 0)", () => {
    const [c] = coinCards([ev({ mint: "A", symbol: "A", detail: "raydium", message: "Scout found A on raydium. Mark 0.0₅207, 1h volume $1,200." })], new Set());
    expect(c.mark).toBeCloseTo(0.00000207, 15);
  });

  it("live quotes win over the frozen first sighting; a missing price carries a reason", () => {
    const events = [
      ev({ ts: 1, mint: "A", symbol: "A", detail: "pumpfun", message: "Scout found A on pumpfun. Mark 0, 1h volume $0.00." }),
      ev({ ts: 2, mint: "B", symbol: "B", detail: "pumpfun", message: "Scout found B on pumpfun. Mark 0, 1h volume $0.00." })
    ];
    const cards = coinCards(events, new Set(), 60, {
      A: { priceUsd: 0.0000123, vol1hUsd: 3066, vol5mUsd: 410, change1hPct: -2.5, source: "dexscreener", at: 5, why: null },
      B: { priceUsd: 0, vol1hUsd: null, vol5mUsd: null, change1hPct: null, source: null, at: 5, why: "curve done, no pool yet" }
    });
    const a = cards.find((c) => c.mint === "A")!;
    const b = cards.find((c) => c.mint === "B")!;
    expect(a.mark).toBeCloseTo(0.0000123, 12);
    expect(a.vol1h).toBe(3066);
    expect(a.vol5m).toBe(410);
    expect(a.change1h).toBe(-2.5);
    expect(b.mark).toBeUndefined();
    expect(b.why).toBe("curve done, no pool yet");
    const [c] = coinCards([ev({ mint: "C", symbol: "C", detail: "pumpfun", message: "Scout found C on pumpfun. Mark 0.0₅8092, 1h volume $9,407.82." })], new Set(), 60, {
      C: { priceUsd: null, vol1hUsd: 0, vol5mUsd: 0, change1hPct: null, source: null, at: 5, why: "no trades yet" }
    });
    expect(c.vol1h).toBeCloseTo(9407.82, 2);
    expect(c.mark).toBeCloseTo(0.000008092, 15);
  });
});

describe("v13.10 TapeQuoter", () => {
  it("DexScreener first, then the pump.fun curve, then Jupiter; reasons, never 0", async () => {
    let t = 1000;
    const q = new TapeQuoter({
      now: () => t,
      dex: async () => new Map([["D1", row(0.5)], ["P1", row(null)]]),
      curves: async (m) => ({ prices: new Map([["P1", 0.00001], ["P0", 0]]), missing: new Map([["P2", "pump.fun curve is complete (migrated)"], ["P3", "No SOL has traded on the curve"]]).set("P0", "x") }),
      jupiter: async () => new Map([["J1", 2], ["X1", 0]])
    });
    for (const [m, s] of [["D1", "raydium"], ["P1", "pumpfun"], ["P0", "pumpfun"], ["P2", "pumpfun"], ["P3", "pumpfun"], ["J1", "raydium"], ["X1", "raydium"]]) q.note(m, s);
    expect(await q.tick()).toBe(7);
    const v = q.view();
    expect(v.D1).toMatchObject({ priceUsd: 0.5, vol1hUsd: 1000, vol5mUsd: 50, change1hPct: 4.2, source: "dexscreener", why: null });
    expect(v.P1).toMatchObject({ priceUsd: 0.00001, source: "pump.fun curve" });
    expect(v.J1).toMatchObject({ priceUsd: 2, source: "jupiter" });
    expect(v.P2).toMatchObject({ priceUsd: null, why: "curve done, no pool yet" });
    expect(v.P3).toMatchObject({ priceUsd: null, why: "no trades yet" });
    expect(v.X1).toMatchObject({ priceUsd: null, why: "not listed yet" });
    expect(v.P0.priceUsd).toBeNull();
    for (const x of Object.values(v)) expect(x.priceUsd === null || x.priceUsd > 0).toBe(true);
  });

  it("batches ≤30, never-quoted first, re-quotes only stale coins", async () => {
    let t = 0;
    const calls: string[][] = [];
    const q = new TapeQuoter({ now: () => t, dex: async (m) => { calls.push(m); return new Map(m.map((x) => [x, row(1)])); } });
    for (let i = 0; i < 45; i++) q.note(`M${i}`, "raydium");
    await q.tick();
    expect(calls[0].length).toBe(30);
    expect(calls[0][0]).toBe("M44"); // newest first
    await q.tick();
    expect(calls[1].length).toBe(15); // the rest, not the fresh ones
    t += 1000;
    expect(await q.tick()).toBe(0);
    t += TAPE_STALE_MS;
    expect(q.due().length).toBe(30);
  });

  it("DexScreener error cools off for a minute, keeps old values, says 'price source busy' otherwise", async () => {
    let t = 0;
    let fail = false;
    let dexCalls = 0;
    const q = new TapeQuoter({ now: () => t, dex: async (m) => { dexCalls++; if (fail) throw new Error("429"); return new Map(m.filter((x) => x === "A").map((x) => [x, row(0.2)])); } });
    q.note("A", "raydium");
    await q.tick();
    fail = true;
    q.note("B", "raydium");
    t += TAPE_STALE_MS;
    await q.tick();
    expect(q.get("A")).toMatchObject({ priceUsd: 0.2, vol1hUsd: 1000 });
    expect(q.get("B")).toMatchObject({ priceUsd: null, why: "price source busy" });
    t += TAPE_STALE_MS;
    await q.tick();
    expect(dexCalls).toBe(2); // paused, no hammering
    t += TAPE_DEX_COOLOFF_MS;
    fail = false;
    await q.tick();
    expect(dexCalls).toBe(3);
  });

  it("fetchDexTape picks the priced, deepest pair per mint", async () => {
    const fake = (async (url: string) => {
      expect(url).toContain("/tokens/v1/solana/A,B");
      return new Response(JSON.stringify([
        { baseToken: { address: "A" }, priceUsd: "0", liquidity: { usd: 999 } },
        { baseToken: { address: "A" }, priceUsd: "0.0001", liquidity: { usd: 5 }, volume: { h1: 70, m5: 3 }, priceChange: { h1: -1 }, dexId: "pumpswap" },
        { baseToken: { address: "A" }, priceUsd: "0.0002", liquidity: { usd: 50 }, volume: { h1: 700, m5: 30 }, priceChange: { h1: 9 } },
        { baseToken: { address: "Z" }, priceUsd: "1" }
      ]), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchDexTape(["A", "B", "A"], fake);
    expect(out.get("A")).toMatchObject({ priceUsd: 0.0002, vol1hUsd: 700, vol5mUsd: 30, change1hPct: 9 });
    const out2 = await fetchDexTape(["A", "B"], (async () => new Response(JSON.stringify([
      { baseToken: { address: "A" }, priceUsd: "0.0002", liquidity: { usd: 50 }, volume: { h1: 100, m5: 1 } },
      { baseToken: { address: "A" }, priceUsd: "0.0001", liquidity: { usd: 5 }, volume: { h1: 900, m5: 40 } }
    ]))) as unknown as typeof fetch);
    expect(out2.get("A")).toMatchObject({ priceUsd: 0.0002, vol1hUsd: 900, vol5mUsd: 40 });
    expect(out.has("B")).toBe(false);
    expect(out.has("Z")).toBe(false);
  });
});
