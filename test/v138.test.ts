import { describe, expect, it } from "vitest";
import { Desk } from "../src/desk/orchestrator.js";
import { makeToken } from "../src/demo/tokens.js";
import { testConfig } from "./helpers.js";
import { tinyPx } from "../src/price-text.js";
import { px, tinyPx as webTinyPx } from "../web/src/format.js";
import { stopLabel } from "../web/src/format.js";
import { sourceAgeLabel } from "../web/src/marks.js";
import { decodePool, dlmmNative, sqrtNative, WSOL_MINT, type PoolInfo } from "../src/market/chain-marks.js";
import { ChainStream, wsUrlFor } from "../src/market/chain-stream.js";
import { exitImpactAllowed, quotePaperBuy } from "../src/agents/execution-math.js";
import { PositionPricer } from "../src/market/position-pricer.js";

const MINT = "ECWgmTJEPbcS5ZrxrxjTy7BV1e6uVzJgLcgS1Wmc1vzm";
const POOL = "CJfj7BoD8pyer9dCLfm5T6ieJQoNCBJZwkidDfyjWGAP";

function q64(price: number): Buffer {
  // sqrt(price) in Q64.64, little-endian u128.
  const s = Math.sqrt(price) * 2 ** 64;
  const hi = Math.floor(s / 2 ** 64);
  const lo = BigInt(Math.round(s - hi * 2 ** 64));
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(lo < 0n ? 0n : lo, 0);
  b.writeBigUInt64LE(BigInt(hi), 8);
  return b;
}

describe("v13.8 tiny prices", () => {
  it("folds leading zeros into a subscript, 4 significant digits, never 0.00000000", () => {
    expect(tinyPx(4.194341397423741e-11)).toBe("0.0₁₀4194");
    expect(tinyPx(4.143e-11)).toBe("0.0₁₀4143");
    expect(tinyPx(8.41406416135225e-6)).toBe("0.0₅8414");
    expect(tinyPx(0.00123456)).toBe("0.001235");
    expect(tinyPx(9.99996e-9)).toBe("0.0₇1");
    expect(webTinyPx(4.143e-11)).toBe(tinyPx(4.143e-11));
    expect(px(4.0685111555010286e-11)).toBe("0.0₁₀4069");
    expect(px(1.5)).toBe("1.5000");
    expect(px(0)).toBe("—");
  });
});

describe("v13.8 stop label", () => {
  it("says the stop level from entry and how far the mark is from it", () => {
    // PEPPER: entry 4.194e-11, stop −3%, mark −1.22% → 1.8% away.
    const entry = 4.194341397423741e-11;
    const stop = entry * 0.97;
    const mark = 4.143e-11;
    expect(stopLabel(stop / entry - 1, stop / mark - 1)).toBe("Stop −3.0% · 1.8% away");
    expect(stopLabel(0.2, 0.01)).toBe("Stop +20.0% · at the stop");
  });
  it("card source line reads on-chain · 0.3s", () => {
    expect(sourceAgeLabel("chain", 300)).toBe("on-chain · 0.3s");
    expect(sourceAgeLabel("dexscreener", 12_400)).toBe("DexScreener · 12s");
  });
});

describe("v13.8 pool decoders", () => {
  const base = { pair: POOL, mint: MINT, decimals: 6, keys: [POOL] };
  it("sqrt-price pools: coin as A or B, decimal-adjusted SOL per coin", () => {
    // coin A (6 dec), SOL B (9 dec): A-in-B raw = native × 10^(9-6)
    const native = 1.5e-7;
    const a = Buffer.alloc(600);
    q64(native * 10 ** (9 - 6)).copy(a, 456);
    expect(sqrtNative(a, 456, true, 6)).toBeCloseTo(native, 12);
    // coin B: A = SOL; A-in-B raw = (1/native) × 10^(6-9)
    const b = Buffer.alloc(600);
    q64((1 / native) * 10 ** (6 - 9)).copy(b, 456);
    expect(sqrtNative(b, 456, false, 6) / native).toBeCloseTo(1, 6);
    const p: PoolInfo = { ...base, kind: "dammv2", coinIsA: false };
    expect((decodePool(p, [b]) as number) / native).toBeCloseTo(1, 6);
    const w = Buffer.alloc(300);
    q64((1 / native) * 10 ** (6 - 9)).copy(w, 65);
    expect((decodePool({ ...base, kind: "whirlpool", coinIsA: false }, [w]) as number) / native).toBeCloseTo(1, 6);
    const c = Buffer.alloc(300);
    q64(native * 10 ** (9 - 6)).copy(c, 253);
    expect((decodePool({ ...base, kind: "clmm", coinIsA: true }, [c]) as number) / native).toBeCloseTo(1, 6);
  });
  it("DBC: live pool decodes, a migrated pool is gone (follow its successor)", () => {
    const d = Buffer.alloc(424);
    q64(2.4e-7 * 10 ** (9 - 6)).copy(d, 280);
    expect((decodePool({ ...base, kind: "dbc", coinIsA: true }, [d]) as number) / 2.4e-7).toBeCloseTo(1, 6);
    d[305] = 1;
    expect(decodePool({ ...base, kind: "dbc", coinIsA: true }, [d])).toBe("gone");
  });
  it("DLMM active bin (BONK/SOL check: bin −815, step 100 → 3.0066e-8)", () => {
    const d = Buffer.alloc(904);
    d.writeInt32LE(-815, 76);
    d.writeUInt16LE(100, 80);
    expect(dlmmNative(d, true, 5)).toBeCloseTo(3.006632635114146e-8, 15);
  });
  it("DAMM v1 vault shares", () => {
    const vault = (total: number) => {
      const b = Buffer.alloc(200);
      b.writeBigUInt64LE(BigInt(total), 11);
      return b;
    };
    const tokenAcc = (amt: number) => {
      const b = Buffer.alloc(165);
      b.writeBigUInt64LE(BigInt(amt), 64);
      return b;
    };
    const mint = (supply: number) => {
      const b = Buffer.alloc(82);
      b.writeBigUInt64LE(BigInt(supply), 36);
      return b;
    };
    // pool holds half of each vault: 1e6 coin (6 dec → 1 coin) and 2e9 lamports (2 SOL) → 2 SOL per coin
    const datas = [vault(2_000_000), vault(4_000_000_000), tokenAcc(50), tokenAcc(50), mint(100), mint(100)];
    expect(decodePool({ ...base, kind: "dammv1", coinIsA: true }, datas)).toBeCloseTo(2, 9);
  });
});

describe("v13.8 websocket stream", () => {
  it("derives the ws endpoint and never keeps the URL in errors", () => {
    expect(wsUrlFor("https://mainnet.helius-rpc.com/?api-key=abc")).toBe("wss://mainnet.helius-rpc.com/?api-key=abc");
    expect(wsUrlFor("http://127.0.0.1:8899")).toBe("ws://127.0.0.1:8899/");
    expect(wsUrlFor("nope")).toBeNull();
  });
  it("subscribes held keys, decodes notifications, unsubscribes dropped keys", () => {
    const sent: Array<{ method: string; params: unknown[]; id: number }> = [];
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const fake = {
      readyState: 1,
      send: (t: string) => sent.push(JSON.parse(t)),
      close: () => {},
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        handlers[ev] = fn;
        return fake;
      }
    };
    const got: Array<[string, number]> = [];
    const stream = new ChainStream("wss://x", (key, data) => got.push([key, data.length]), { connect: () => fake as never });
    stream.setKeys(["K1", "K2"]);
    handlers.open!();
    expect(sent.map((m) => m.method)).toEqual(["accountSubscribe", "accountSubscribe"]);
    stream.onMessage(JSON.stringify({ jsonrpc: "2.0", id: sent[0]!.id, result: 11 }));
    stream.onMessage(JSON.stringify({ jsonrpc: "2.0", id: sent[1]!.id, result: 12 }));
    stream.onMessage(JSON.stringify({ jsonrpc: "2.0", method: "accountNotification", params: { subscription: 12, result: { context: {}, value: { data: [Buffer.alloc(9).toString("base64"), "base64"] } } } }));
    expect(got).toEqual([["K2", 9]]);
    stream.setKeys(["K2"]);
    expect(sent[sent.length - 1]).toMatchObject({ method: "accountUnsubscribe", params: [11] });
    expect(stream.stats()).toMatchObject({ connected: true, subscriptions: 1, updates: 1 });
    stream.stop();
  });
  it("a streamed exact-pool mark needs a feed sample and fresh SOL/USD before it is shown", () => {
    let now = 1_000_000;
    const lives: number[] = [];
    const pricer = new PositionPricer({ heldMints: () => [MINT], tick: () => {}, onStale: () => {}, live: (_m, usd) => lives.push(usd), now: () => now });
    expect(pricer.factor(MINT, "dammv2", now)).toBeNull();
    pricer.quotes.solUsd = { value: 90, at: now };
    expect(pricer.factor(MINT, "dammv2", now)).toBeNull();
    expect(lives).toEqual([]);
  });
});

describe("v13.8 exit check when depth is unknown", () => {
  it("never says 'cost unknown, more than' and still refuses", () => {
    const gate = exitImpactAllowed(50, 0, 0.5, null);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.message).not.toMatch(/unknown/);
      expect(gate.message).toMatch(/Can't measure what a full sell would cost/);
    }
    const buy = quotePaperBuy(1e-6, 50, 0, 0.5);
    expect(buy.ok).toBe(false);
    if (!buy.ok) expect(buy.message).not.toMatch(/unknown/);
  });

  async function deskWith(depth: (url: string) => Response) {
    const depthFetch = (async (input: RequestInfo | URL) => depth(String(input))) as unknown as typeof fetch;
    const desk = new Desk(testConfig({ rpcUrl: "", rugcheckUrl: "" }), { depthFetch, lookupFetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch });
    desk.updateSettings({ autoBuy: false });
    await desk.submitCandidate(makeToken({ mint: MINT, symbol: "STARBUCKS", priceUsd: 0.0001222, liquidityUsd: 0 }));
    return desk;
  }

  it("re-reads depth from DexScreener's deepest pair and buys at that pool's price", async () => {
    const desk = await deskWith((url) =>
      url.includes("/tokens/v1/solana/")
        ? Response.json([
            { baseToken: { address: MINT }, priceUsd: "0.0001222", liquidity: { usd: 0 }, pairAddress: "curvepair", dexId: "pumpfun" },
            { baseToken: { address: MINT }, priceUsd: "0.0001230", liquidity: { usd: 26_525 }, pairAddress: POOL, dexId: "pumpswap", quoteToken: { address: WSOL_MINT }, priceNative: "0.0000013" }
          ])
        : new Response("", { status: 404 })
    );
    try {
      const res = await desk.manualBuy(MINT, 10, { confirmHardKill: true, book: "paper" });
      expect(res.ok).toBe(true);
      const pos = desk.book.positions.get(MINT)!;
      expect(pos.pairAddress).toBe(POOL);
    } finally {
      desk.stop();
    }
  });

  it("nothing readable: refused for safety in plain words, saying what was tried", async () => {
    const desk = await deskWith(() => new Response("", { status: 404 }));
    try {
      const res = await desk.manualBuy(MINT, 10, { confirmHardKill: true, book: "paper" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("EXIT_IMPACT");
        expect(res.error).toMatch(/^Can't measure what selling STARBUCKS would cost: no readable pool depth yet \(.*\)\. Buy refused for safety\.$/);
        expect(res.error).not.toMatch(/unknown|more than/);
      }
      expect(desk.book.positions.has(MINT)).toBe(false);
    } finally {
      desk.stop();
    }
  });
});
