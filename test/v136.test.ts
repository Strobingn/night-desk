import { afterEach, describe, expect, it, vi } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import {
  ChainMarkReader,
  PUMPSWAP_PROGRAM,
  PUMP_PROGRAM,
  RAYDIUM_AMM_V4,
  RAYDIUM_CPMM,
  WSOL_MINT,
  parseCpmm,
  parseRaydiumV4,
  pumpCurveAddress,
  solSides
} from "../src/market/chain-marks.js";
import { DexSearchClient, matchLocal, mergeTickerCandidates, rankDexSearch, shortMint, tickerQuery } from "../src/market/ticker-search.js";
import { bucketFor } from "../src/market/net.js";
import { PositionPricer } from "../src/market/position-pricer.js";
import { testConfig, testDesk } from "./helpers.js";

const MINT = "9dGdEhbke3J8kBNfb3TUmm2qqfVfLZHS7scxxpCNpump";
const MINT2 = "6FpQSako8NexbSPCj2dJ7W6vVXqA8qLyZ1x8qyjppump";
const MINT3 = "2HNbRAN6m3bhgYb9mCzH6ULoT8qQuTWE3pM1CyM1pump";
const POOL = "Ai6sqoFGkuyJYv1SoPX1UdV6VobsqnFNYhVjQX5Mo4iV";
const TOKEN_VAULT = "BJMBw53wYuSMxkvLd2h3zKHMnXa2yskBGX9qie7t3Mg";
const SOL_VAULT = "AxcAjRm2bPpFxbdddW8JDkn9p5JnuAm8xbN9h4YnooHG";
const TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

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
const u64le = (buf: Uint8Array, offset: number, value: bigint) => new DataView(buf.buffer).setBigUint64(offset, value, true);
const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");
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
function curveData(vTok: bigint, vSol: bigint, complete = false, realSol = 1_000_000_000n): Uint8Array {
  const d = new Uint8Array(150);
  u64le(d, 8, vTok);
  u64le(d, 16, vSol);
  u64le(d, 32, realSol);
  d[48] = complete ? 1 : 0;
  return d;
}
/** PumpSwap pool with WSOL as the BASE side (Dirk's QTFALCN pool layout). */
function reversedPool(mint: string): Uint8Array {
  const d = new Uint8Array(301);
  d.set(decode58(WSOL_MINT), 43);
  d.set(decode58(mint), 75);
  d.set(decode58(SOL_VAULT), 139);
  d.set(decode58(TOKEN_VAULT), 171);
  return d;
}

function rpcFrom(accounts: () => Record<string, { owner: string; data: Uint8Array } | null>, calls: string[][] = []) {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params: [string[]] };
    const keys = body.params[0];
    calls.push(keys);
    const map = accounts();
    const value = keys.map((k) => (map[k] ? { owner: map[k]!.owner, data: [b64(map[k]!.data), "base64"] } : null));
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value } });
  }) as unknown as typeof fetch;
}

afterEach(() => vi.useRealTimers());

describe("v13.6 ticker / name lookup", () => {
  it("treats tickers and names as ticker queries; mints and links keep the old path", () => {
    expect(tickerQuery("QTFALCN")).toBe("QTFALCN");
    expect(tickerQuery("  $taz ")).toBe("taz");
    expect(tickerQuery("Qatar Falcon")).toBe("Qatar Falcon");
    expect(tickerQuery(MINT)).toBeNull();
    expect(tickerQuery(`https://dexscreener.com/solana/${POOL}`)).toBeNull();
    expect(tickerQuery("dexscreener.com/solana/x")).toBeNull();
    expect(tickerQuery("")).toBeNull();
    expect(tickerQuery("$")).toBeNull();
    expect(shortMint(MINT)).toBe("9dGd…pump");
  });

  it("matches held/traded coins case-insensitively by ticker or name, one row per mint", () => {
    const rows = matchLocal("qtfalcn", [
      { mint: MINT2, symbol: "QTFALCN", name: "Qatar Falcon", held: true, origin: "position" },
      { mint: MINT2, symbol: "QTFALCN", origin: "trade" },
      { mint: MINT, symbol: "OTHER", origin: "trade" }
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mint: MINT2, held: true, origin: "position", exact: true });
    expect(matchLocal("$Qatar Falcon", [{ mint: MINT2, symbol: "QTFALCN", name: "Qatar Falcon", origin: "tape" }])).toHaveLength(1);
  });

  it("ranks DexScreener search: Solana only, exact ticker first, by liquidity then 1h volume, pools summed", () => {
    const body = {
      pairs: [
        { chainId: "solana", baseToken: { address: MINT3, symbol: "TAZ", name: "Taz" }, quoteToken: { address: WSOL_MINT, symbol: "SOL" }, liquidity: { usd: 5_000 }, volume: { h1: 11_000 } },
        { chainId: "solana", baseToken: { address: MINT3, symbol: "TAZ", name: "Taz" }, quoteToken: { address: WSOL_MINT }, volume: { h1: 8_000 } },
        { chainId: "solana", baseToken: { address: MINT, symbol: "TAZ", name: "Taz copy" }, quoteToken: { address: WSOL_MINT }, liquidity: { usd: 90_000 }, volume: { h1: 10 } },
        { chainId: "tron", baseToken: { address: "TAzpJHxx", symbol: "TAZ" }, liquidity: { usd: 1e6 } },
        { chainId: "solana", baseToken: { address: MINT2, symbol: "TAO", name: "TAO" }, quoteToken: { address: WSOL_MINT }, liquidity: { usd: 4e8 } }
      ]
    };
    const ranked = rankDexSearch("taz", body, new Set([MINT3]));
    expect(ranked.map((r) => r.mint)).toEqual([MINT, MINT3]);
    expect(ranked[1]).toMatchObject({ liquidityUsd: 5_000, volume1hUsd: 19_000, held: true });
    // No exact hit: partial matches come back for the pick list, flagged inexact.
    const partial = rankDexSearch("QTF", { pairs: [{ chainId: "solana", baseToken: { address: MINT2, symbol: "QTFALCN", name: "Qatar Falcon" }, quoteToken: { address: WSOL_MINT }, liquidity: { usd: 125_000 } }] });
    expect(partial).toHaveLength(1);
    expect(partial[0]!.exact).toBe(false);
  });

  it("DexScreener search is cached 60s, spaced 1.5s and backs off on 429 (own small net bucket)", async () => {
    let now = 1_000_000;
    let status = 200;
    let calls = 0;
    const client = new DexSearchClient(
      (async () => {
        calls += 1;
        return status === 200 ? Response.json({ pairs: [] }) : new Response("", { status });
      }) as unknown as typeof fetch,
      { now: () => now }
    );
    expect((await client.search("TAZ")).ok).toBe(true);
    expect(await client.search("taz")).toMatchObject({ ok: true, cached: true });
    expect(calls).toBe(1);
    expect((await client.search("OTHER")).ok).toBe(false);
    now += 2_000;
    status = 429;
    const limited = await client.search("OTHER");
    expect(limited.ok).toBe(false);
    expect(calls).toBe(2);
    now += 5_000;
    expect((await client.search("OTHER")).ok).toBe(false);
    expect(calls).toBe(2);
    now += 6_000;
    status = 200;
    expect((await client.search("OTHER")).ok).toBe(true);
    expect(calls).toBe(3);
    expect(bucketFor("https://api.dexscreener.com/latest/dex/search?q=TAZ")?.id).toBe("dexscreener:search");
    expect(bucketFor("https://api.dexscreener.com/latest/dex/tokens/x")?.id).toBe("dexscreener:pairs");
  });

  it("a held coin's ticker resolves to it without DexScreener search; several local hits give a pick list", async () => {
    const urls: string[] = [];
    const lookupFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/latest/dex/tokens/")) {
        return Response.json({
          pairs: [{ chainId: "solana", dexId: "pumpswap", pairAddress: POOL, priceUsd: "0.037", liquidity: { usd: 125_000 }, volume: { h1: 34_000 }, pairCreatedAt: Date.now() - 3_600_000, baseToken: { address: MINT2, symbol: "QTFALCN", name: "Qatar Falcon" }, quoteToken: { address: WSOL_MINT } }]
        });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const desk = new Desk(testConfig({ rpcUrl: "", rugcheckUrl: "" }), { lookupFetch });
    try {
      await desk.submitCandidate(makeToken({ mint: MINT2, symbol: "QTFALCN", name: "Qatar Falcon", priceUsd: 0.037 }));
      expect(desk.book.positions.has(MINT2)).toBe(true);
      const found = await desk.lookupCoin("qtfalcn");
      expect(found.ok).toBe(true);
      if (found.ok) {
        expect(found.mint).toBe(MINT2);
        expect(found.held).toBe(true);
        expect(found.matchedBy).toBe("QTFALCN · held");
      }
      expect(urls.some((u) => u.includes("/latest/dex/search"))).toBe(false);
      // A second coin with the same ticker on the Tape is a different tier: held wins.
      await desk.submitCandidate(makeToken({ mint: MINT3, symbol: "TWIN", priceUsd: 0.01 }));
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "TWIN", priceUsd: 0.02 }));
      const twin = await desk.lookupCoin("$twin");
      expect(twin.ok).toBe(false);
      if (!twin.ok) {
        expect(twin.code).toBe("AMBIGUOUS");
        expect(twin.candidates?.map((c) => c.mint).sort()).toEqual([MINT, MINT3].sort());
      }
      // Mint path unchanged.
      const byMint = await desk.lookupCoin(MINT2);
      expect(byMint.ok).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("unknown ticker falls through to DexScreener search; nothing found says what was searched", async () => {
    const lookupFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/latest/dex/search")) return Response.json({ pairs: [] });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const desk = new Desk(testConfig({ rpcUrl: "", rugcheckUrl: "" }), { lookupFetch });
    try {
      const res = await desk.lookupCoin("NOPE");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/positions, trades, the Tape or DexScreener search/);
    } finally {
      desk.stop();
    }
  });

  it("a name that is not on Home or the Tape still resolves from DexScreener, and a failure stays visible", async () => {
    const SEEK = "2HNbRAN6m3bhgYb9mCzH6ULoT8qQuTWE3pM1CyM1pump";
    let status = 200;
    const urls: string[] = [];
    const pair = {
      chainId: "solana",
      dexId: "raydium",
      pairAddress: POOL,
      priceUsd: "1.25",
      liquidity: { usd: 180_000 },
      volume: { h1: 40_000 },
      pairCreatedAt: Date.now() - 3_600_000,
      baseToken: { address: SEEK, symbol: "SEEK", name: "Seek Coin" },
      quoteToken: { address: WSOL_MINT }
    };
    const lookupFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/latest/dex/search")) {
        if (status !== 200) return new Response("{}", { status });
        return Response.json({ pairs: [pair] });
      }
      if (url.includes(`/latest/dex/tokens/${SEEK}`)) return Response.json({ pairs: [pair] });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const desk = new Desk(testConfig({ rpcUrl: "", rugcheckUrl: "" }), { lookupFetch });
    try {
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "GATE", name: "Gate Coin", priceUsd: 1 }));
      const found = await desk.lookupCoin("seek");
      expect(found.ok).toBe(true);
      if (found.ok) {
        expect(found.mint).toBe(SEEK);
        expect(found.matchedBy).toMatch(/DexScreener search/);
        expect(found.providerNote).toBeUndefined();
      }
      expect(urls.some((u) => u.includes("/latest/dex/search"))).toBe(true);
      expect(desk.book.positions.has(SEEK)).toBe(false);
      const merged = mergeTickerCandidates(
        [{ mint: MINT, symbol: "SEEK", name: "Local", mintShort: "gate", liquidityUsd: 1, volume1hUsd: 1, held: false, origin: "tape", exact: true }],
        [{ mint: SEEK, symbol: "SEEK", name: "Seek Coin", mintShort: "seek", liquidityUsd: 2, volume1hUsd: 2, held: false, origin: "dexscreener", exact: true }]
      );
      expect(merged.map((row) => row.mint)).toEqual([MINT, SEEK]);
      const again = await desk.lookupCoin("SEEK");
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.providerNote).toMatch(/up to 60s old/);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      status = 429;
      const limited = await desk.lookupCoin("NOPE2");
      expect(limited.ok).toBe(false);
      if (!limited.ok) {
        expect(limited.providerNote ?? limited.error).toMatch(/rate limited/);
        expect(limited.error).toMatch(/rate limited/);
      }
    } finally {
      desk.stop();
    }
  });
});

describe("v13.6 one-tap cap names the limit", () => {
  it("$5.97-style cap on a ~$100 book is the max-exposure room, and the snapshot says so", async () => {
    const desk = testDesk({ startingBalanceUsd: 100 });
    try {
      desk.updateSettings({ maxExposurePct: 0.35 });
      await desk.submitCandidate(makeToken({ mint: MINT2, symbol: "QTFALCN", priceUsd: 0.03 }));
      await desk.submitCandidate(makeToken({ mint: MINT3, symbol: "TAZ", priceUsd: 0.02 }));
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "HALVE", priceUsd: 0.02 }));
      await desk.submitCandidate(makeToken({ mint: POOL, symbol: "FOUR", priceUsd: 0.02 }));
      const snap = desk.snapshot();
      const why = snap.capWhy!;
      expect(why.capUsd).toBe(snap.positionCapUsd);
      expect(why.binding).toBe("exposure");
      expect(why.capUsd).toBeLessThan(why.pctCapUsd);
      expect(why.capUsd).toBeCloseTo(why.equityUsd * 0.35 - why.exposureUsd, 1);
      expect(why.line).toMatch(/^exposure cap: max exposure 35% × \$\d+\.\d\d equity = .* minus \$.* already in open positions/);
      // Not the live $5 size: paper caps only.
      expect(snap.prefs.liveTradeUsd).toBe(5);
      expect(why.capUsd).not.toBe(5);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.6 on-chain pools: reversed PumpSwap, Raydium v4 / CPMM, and pump.fun curves", () => {
  it("reads a PumpSwap pool whose base is WSOL (QTFALCN's layout), which v13.2 refused", async () => {
    const pool = { tokens: 1_678_707, sol: 666.7 };
    const reader = new ChainMarkReader(
      "http://rpc",
      rpcFrom(() => ({
        [POOL]: { owner: PUMPSWAP_PROGRAM, data: reversedPool(MINT2) },
        [MINT2]: { owner: TOKENKEG, data: mintData(6) },
        [TOKEN_VAULT]: { owner: TOKENKEG, data: tokenAccount(BigInt(Math.round(pool.tokens * 1e6))) },
        [SOL_VAULT]: { owner: TOKENKEG, data: tokenAccount(BigInt(Math.round(pool.sol * 1e9))) }
      }))
    );
    const reads = await reader.read([{ mint: MINT2, pair: POOL }], 1);
    expect(reads.get(MINT2)?.kind).toBe("pumpswap");
    expect(reads.get(MINT2)!.native).toBeCloseTo(pool.sol / pool.tokens, 10);
  });

  it("decodes Raydium AMM v4 and CPMM vaults, with WSOL on either side", () => {
    const v4 = new Uint8Array(752);
    v4.set(decode58(TOKEN_VAULT), 336);
    v4.set(decode58(SOL_VAULT), 368);
    v4.set(decode58(MINT), 400);
    v4.set(decode58(WSOL_MINT), 432);
    expect(solSides(parseRaydiumV4(v4), MINT)).toEqual({ tokenVault: TOKEN_VAULT, solVault: SOL_VAULT });
    const cp = new Uint8Array(637);
    cp.set(decode58(SOL_VAULT), 72);
    cp.set(decode58(TOKEN_VAULT), 104);
    cp.set(decode58(WSOL_MINT), 168);
    cp.set(decode58(MINT), 200);
    expect(solSides(parseCpmm(cp), MINT)).toEqual({ tokenVault: TOKEN_VAULT, solVault: SOL_VAULT });
    expect(solSides(parseCpmm(cp), MINT2)).toBeNull();
    expect(RAYDIUM_AMM_V4).toMatch(/^675k/);
    expect(RAYDIUM_CPMM).toMatch(/^CPMM/);
  });

  it("reads a live pump.fun curve on demand and refuses a complete or missing one", async () => {
    const curve = pumpCurveAddress(MINT)!;
    let complete = false;
    let untraded = false;
    const reader = new ChainMarkReader(
      "http://rpc",
      rpcFrom(() => ({
        [curve]: { owner: PUMP_PROGRAM, data: curveData(1_000_000_000_000_000n, 30_000_000_000n, complete, untraded ? 15n : 1_000_000_000n) },
        [MINT]: { owner: TOKENKEG, data: mintData(6) }
      }))
    );
    const ok = await reader.readCurves([MINT, MINT2]);
    expect(ok.quotes.get(MINT)).toMatchObject({ curve, virtualSol: 30, native: 30 / 1e9 });
    expect(ok.missing.get(MINT2)).toMatch(/no pump.fun bonding curve/);
    untraded = true;
    const empty = await reader.readCurves([MINT]);
    expect(empty.quotes.size).toBe(0);
    expect(empty.missing.get(MINT)).toMatch(/no SOL has traded/);
    untraded = false;
    complete = true;
    const done = await reader.readCurves([MINT]);
    expect(done.quotes.size).toBe(0);
    expect(done.missing.get(MINT)).toMatch(/complete/);
  });
});

describe("v13.6 manual buy on a brand-new pump.fun coin", () => {
  function deskFor(curveState: { vSol: bigint; complete?: boolean; present?: boolean }) {
    const curve = pumpCurveAddress(MINT)!;
    const chainFetch = rpcFrom(() => ({
      ...(curveState.present === false ? {} : { [curve]: { owner: PUMP_PROGRAM, data: curveData(1_000_000_000_000_000n, curveState.vSol, curveState.complete) } }),
      [MINT]: { owner: TOKENKEG, data: mintData(6) }
    }));
    const jup = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("jup.ag")) return Response.json({ [WSOL_MINT]: { usdPrice: 150 } });
      if (url.includes("dexscreener")) return Response.json([]);
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const desk = new Desk(testConfig({ rpcUrl: "", rugcheckUrl: "" }), { lookupFetch: jup, priceFetch: jup, chainFetch });
    return { desk, curve };
  }
  function seeUnpriced(desk: Desk) {
    (desk as unknown as { sightings: Map<string, unknown> }).sightings.set(MINT, makeToken({ mint: MINT, symbol: "JEETERS", priceUsd: 0, liquidityUsd: 0, source: "pumpfun" }));
  }

  it("prices from the bonding curve and anchors stops to that curve", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_000_000;
    vi.setSystemTime(t0);
    const state = { vSol: 30_000_000_000n };
    const { desk, curve } = deskFor(state);
    try {
      seeUnpriced(desk);
      const res = await desk.manualBuy(MINT, 10, { confirmHardKill: true });
      expect(res.ok).toBe(true);
      const pos = desk.book.positions.get(MINT)!;
      expect(pos.priceFeed).toBe("chain");
      expect(pos.pairAddress).toBe(curve);
      expect(pos.entryPrice).toBeGreaterThan(30 / 1e9 * 150 * 0.99);
      // The curve drops 12%: the curve is the entry source, so it drives the stop.
      state.vSol = 26_400_000_000n;
      vi.setSystemTime(t0 + 30_000);
      await desk.repricePositions();
      expect(desk.book.positions.has(MINT)).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("fails closed with a plain message naming what was tried", async () => {
    const { desk } = deskFor({ vSol: 30_000_000_000n, complete: true });
    try {
      seeUnpriced(desk);
      const res = await desk.manualBuy(MINT, 10, { confirmHardKill: true });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("PRICE_UNAVAILABLE");
        expect(res.error).toMatch(/No price for JEETERS yet/);
        expect(res.error).toMatch(/DexScreener/);
        expect(res.error).toMatch(/Jupiter/);
        expect(res.error).toMatch(/bonding curve is complete/);
      }
      expect(desk.book.positions.has(MINT)).toBe(false);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.6 web helpers", () => {
  it("names the cap behind the one-tap size and only says cut when it is cut", async () => {
    const { capHint, candidateLine } = await import("../web/src/tickerText.js");
    const why = { binding: "exposure", capUsd: 5.97, line: "exposure cap: max exposure 35% × $91.43 equity = $32.00, minus $26.03 already in open positions = $5.97 room" };
    expect(capHint(why, 5.97, 20)).toMatch(/^cut to \$5\.97 by the exposure cap: max exposure 35%/);
    expect(capHint(why, 5.97, 5)).toMatch(/^within the \$5\.97 cap, set by the exposure cap/);
    expect(capHint(null, 5.97, 20)).toBe("cut to the $5.97 cap and cash");
    expect(
      candidateLine({ mint: MINT2, symbol: "QTFALCN", name: "Qatar Falcon", mintShort: "6Fpq…pump", liquidityUsd: 125_291, volume1hUsd: 34_333, held: true, origin: "position", exact: true })
    ).toBe("6Fpq…pump · liq $125.3K · 1h vol $34.3K · held");
  });
});

describe("v13.6 held pump.fun coin with no DexScreener pair yet", () => {
  it("reads its bonding curve each cycle and pushes a calibrated mark", async () => {
    const curve = pumpCurveAddress(MINT)!;
    const calls: string[][] = [];
    const chain = new ChainMarkReader(
      "http://rpc",
      rpcFrom(() => ({
        [curve]: { owner: PUMP_PROGRAM, data: curveData(1_000_000_000_000_000n, 30_000_000_000n) },
        [MINT]: { owner: TOKENKEG, data: mintData(6) }
      }), calls)
    );
    const usd = (30 / 1e9) * 150;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("jup.ag")) return Response.json({ [MINT]: { usdPrice: usd } });
      return Response.json({ pairs: [] });
    }) as unknown as typeof fetch;
    let now = 0;
    const lives: number[] = [];
    const pricer = new PositionPricer({
      heldMints: () => [MINT],
      pairFor: () => undefined,
      fallbackPair: (m) => pumpCurveAddress(m) ?? undefined,
      tick: () => {},
      live: (_m, p) => lives.push(p),
      onStale: () => {},
      fetchImpl,
      now: () => now,
      chain
    });
    for (now = 0; now <= 12_000; now += 1_000) await pricer.poll();
    expect(calls.some((keys) => keys.includes(curve))).toBe(true);
    expect(lives.length).toBeGreaterThan(0);
    expect(lives.at(-1)!).toBeCloseTo(usd, 9);
  });
});

describe("v13.19 search lookup budget", () => {
  it("returns the Dex price while Jupiter and the public RPC never answer", async () => {
    const lookupFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/latest/dex/tokens/")) {
        return Response.json({
          pairs: [{
            chainId: "solana",
            dexId: "pumpswap",
            pairAddress: POOL,
            priceUsd: "0.037",
            liquidity: { usd: 125_000 },
            volume: { h1: 34_000 },
            pairCreatedAt: Date.now() - 3_600_000,
            baseToken: { address: MINT, symbol: "SLOW", name: "Slow Coin" },
            quoteToken: { address: WSOL_MINT }
          }]
        });
      }
      return new Promise(() => {
        /* Jupiter, Rugcheck, and the public RPC stay queued */
      });
    }) as unknown as typeof fetch;
    const desk = new Desk(
      testConfig({ rpcUrl: "https://api.mainnet-beta.solana.com", rugcheckUrl: "https://api.rugcheck.xyz/v1" }),
      { lookupFetch }
    );
    try {
      const started = Date.now();
      const found = await desk.lookupCoin(MINT);
      expect(Date.now() - started).toBeLessThan(7_000);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.symbol).toBe("SLOW");
      expect(found.priceSource).toBe("dexscreener");
      expect(found.priceUsd).toBeCloseTo(0.037);
      expect(found.providerNote ?? "").toMatch(/did not answer|hard kill/i);
      expect(found.hardKills.some((kill) => kill.code === "MINT_AUTHORITY_ACTIVE")).toBe(true);
      expect(JSON.stringify(found)).not.toMatch(/timeout/i);
    } finally {
      desk.stop();
    }
  });
});
