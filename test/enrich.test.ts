import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { enrichSighting } from "../src/market/enrich.js";

const MINT = "Mint111111111111111111111111111111111111111";

describe("enrich overlap", () => {
  it("runs dex, rugcheck, and the mint read together, and does not hold holders for rugcheck", async () => {
    const delay: Record<string, number> = {
      dex: 80,
      rug: 80,
      getAccountInfo: 80,
      getTokenLargestAccounts: 40,
      getMultipleAccounts: 40
    };
    const starts: Record<string, number> = {};
    const ends: Record<string, number> = {};
    const counts: Record<string, number> = {};

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let kind = "other";
      if (url.includes("dexscreener")) kind = "dex";
      else if (url.includes("/report")) kind = "rug";
      else if (init?.body) kind = (JSON.parse(String(init.body)) as { method: string }).method;
      counts[kind] = (counts[kind] ?? 0) + 1;
      starts[kind] = performance.now();
      await new Promise((resolve) => setTimeout(resolve, delay[kind] ?? 10));
      ends[kind] = performance.now();
      const body = payload(kind);
      return Response.json(kind === "dex" || kind === "rug" ? body : { result: body });
    };

    const token = await enrichSighting(
      { mint: MINT, symbol: "THIN", source: "pumpfun", observedAt: Date.now() },
      { rpcUrl: "http://rpc.test/solana", rugcheckUrl: "http://rug.test", fetchImpl }
    );

    expect(Math.abs(starts.dex - starts.rug)).toBeLessThan(40);
    expect(Math.abs(starts.dex - starts.getAccountInfo)).toBeLessThan(40);
    expect(Math.abs(starts.getAccountInfo - starts.getTokenLargestAccounts)).toBeLessThan(40);
    // Holders do not wait for RugCheck. Multiple starts as soon as the largest-accounts read returns.
    expect(starts.getMultipleAccounts).toBeGreaterThanOrEqual(ends.getTokenLargestAccounts - 5);
    expect(starts.getMultipleAccounts).toBeLessThan(ends.rug);
    expect(counts).toEqual({
      dex: 1,
      rug: 1,
      getAccountInfo: 1,
      getTokenLargestAccounts: 1,
      getMultipleAccounts: 1
    });
    expect(token.volume1hUsd).toBe(100);
    expect(token.mintAuthorityRevoked).toBe(true);
    expect(token.top10HolderPct).toBeCloseTo(0.1, 5);
    expect(token.onBondingCurve).toBe(true);
  });

  it("does not repeat getTokenLargestAccounts after a 429", async () => {
    const counts: Record<string, number> = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let kind = "other";
      if (url.includes("dexscreener")) kind = "dex";
      else if (url.includes("/report")) kind = "rug";
      else if (init?.body) kind = (JSON.parse(String(init.body)) as { method: string }).method;
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (kind === "getTokenLargestAccounts") return new Response("busy", { status: 429 });
      if (kind === "getAccountInfo") {
        return Response.json({
          result: { value: { data: { parsed: { info: { mintAuthority: null, supply: "1000000", decimals: 6 } } } } }
        });
      }
      if (kind === "dex") return Response.json({ pairs: [] });
      return Response.json({ risks: [], topHolders: [] });
    };
    const token = await enrichSighting(
      { mint: MINT, symbol: "THIN", source: "pumpfun", observedAt: Date.now() },
      { rpcUrl: "http://rpc.test/solana", rugcheckUrl: "http://rug.test", fetchImpl, holderPagesMax: 0 }
    );
    expect(counts.getTokenLargestAccounts).toBe(1);
    expect(counts.getMultipleAccounts).toBeUndefined();
    expect(token.mintAuthorityRevoked).toBe(true);
    expect(token.top10HolderPct ?? null).toBeNull();
  });

  it("clamps enrich concurrency and queue from the environment", () => {
    expect(loadConfig({}).enrichConcurrency).toBe(8);
    expect(loadConfig({}).enrichQueueCap).toBe(160);
    expect(loadConfig({}).holderPagesMax).toBe(0);
    expect(loadConfig({}).enrichCallsPerMin).toBe(45);
    expect(loadConfig({ ENRICH_RPC_CALLS_PER_MIN: "10" }).enrichCallsPerMin).toBe(10);
    expect(loadConfig({ ENRICH_RPC_CALLS_PER_MIN: "99999" }).enrichCallsPerMin).toBe(1200);
    expect(loadConfig({ HOLDER_PAGES_MAX: "3" }).holderPagesMax).toBe(3);
    expect(loadConfig({ SCOUT_ENRICH_CONCURRENCY: "8" }).enrichConcurrency).toBe(8);
    expect(loadConfig({ SCOUT_ENRICH_CONCURRENCY: "0" }).enrichConcurrency).toBe(1);
    expect(loadConfig({ SCOUT_ENRICH_CONCURRENCY: "99" }).enrichConcurrency).toBe(16);
    expect(loadConfig({ SCOUT_ENRICH_CONCURRENCY: "nope" }).enrichConcurrency).toBe(8);
    expect(loadConfig({ SCOUT_ENRICH_QUEUE: "3" }).enrichQueueCap).toBe(8);
    expect(loadConfig({ SCOUT_ENRICH_QUEUE: "5000" }).enrichQueueCap).toBe(2000);
  });
});

function payload(kind: string): unknown {
  if (kind === "dex") {
    return {
      pairs: [
        {
          chainId: "solana",
          dexId: "pumpfun",
          priceUsd: "0.0001",
          marketCap: 1000,
          pairCreatedAt: Date.now() - 60_000,
          baseToken: { address: MINT, symbol: "THIN", name: "Thin" },
          liquidity: { usd: 100 },
          volume: { h1: 100 }
        }
      ]
    };
  }
  if (kind === "getAccountInfo") {
    return {
      value: {
        data: { parsed: { info: { mintAuthority: null, supply: "1000000000", decimals: 6 } } }
      }
    };
  }
  if (kind === "getTokenLargestAccounts") {
    return {
      value: [{ address: "RetailTokenAccount1111111111111111111111111", uiAmount: 100, amount: "100000000", decimals: 6 }]
    };
  }
  if (kind === "getMultipleAccounts") {
    return { value: [{ data: { parsed: { info: { owner: "RetailOwner111111111111111111111111111111" } } } }] };
  }
  return { risks: [], topHolders: [] };
}
