import { describe, expect, it, vi } from "vitest";
import { Scout, enrichBefore } from "../src/agents/scout.js";
import { EventBus } from "../src/bus.js";
import { Desk } from "../src/desk/orchestrator.js";
import { draftFromRaw, type RawTapeRow } from "../src/desk/raw-tape.js";
import { enrichSighting, needsFilterRugcheck } from "../src/market/enrich.js";
import { BUCKETS, ENRICH_CIRCUIT_MS, ENRICH_RPS_CAP, NetLimiter, bucketFor, rpcLane } from "../src/market/net.js";
import type { DeskEvents, RawSighting } from "../src/types.js";
import { makeToken } from "../src/demo/tokens.js";
import { testConfig } from "./helpers.js";

const MINT = "Mint111111111111111111111111111111111111111";
const ALCHEMY = "https://solana-mainnet.g.alchemy.com/v2/supersecretkey";
const HELIUS = "https://mainnet.helius-rpc.com/?api-key=heliussecret";

function rpcBody(method: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });
}

describe("v13.28 enrich lane stays off Helius", () => {
  it("keeps the Helius caps and gives the enrich host its own budget", () => {
    const read = BUCKETS.find((row) => row.id === "helius")!;
    const exec = BUCKETS.find((row) => row.id === "helius:exec")!;
    const enrich = BUCKETS.find((row) => row.id === "enrich")!;
    expect(read.budgetPerMin).toBe(10);
    expect(exec.budgetPerMin).toBe(8);
    expect(read.budgetPerMin + exec.budgetPerMin).toBe(18);
    expect(enrich.budgetPerMin).toBe(45);
    expect(enrich.budgetPerMin + enrich.burst).toBeLessThanOrEqual(enrich.limitPerMin);
    expect(bucketFor(HELIUS)?.id).toBe("helius");
    expect(bucketFor(ALCHEMY)).toBeNull();
    expect(rpcLane(bucketFor(HELIUS), -1, rpcBody("getBalance"))?.id).toBe("helius");
    expect(rpcLane(bucketFor(HELIUS), 1, rpcBody("simulateTransaction"))?.id).toBe("helius:exec");
  });

  it("counts enrich reads on the enrich lane and leaves the wallet lane alone", async () => {
    const hosts: string[] = [];
    const net = new NetLimiter({
      fetchImpl: (async (input: RequestInfo | URL) => {
        hosts.push(new URL(String(input)).hostname);
        return Response.json({ jsonrpc: "2.0", result: { value: null } });
      }) as typeof fetch
    });
    net.useEnrichRpc(ALCHEMY, 45);
    await net.fetchEnrich()(ALCHEMY, { method: "POST", body: rpcBody("getMultipleAccounts") });
    await net.fetchAt(-1)(HELIUS, { method: "POST", body: rpcBody("getBalance") });
    const stats = net.stats();
    expect(stats.find((row) => row.id === "enrich")?.reqLastMin).toBe(1);
    expect(stats.find((row) => row.id === "helius")?.reqLastMin).toBe(1);
    expect(stats.find((row) => row.id === "helius:exec")?.reqLastMin).toBe(0);
    expect(hosts).toEqual(["solana-mainnet.g.alchemy.com", "mainnet.helius-rpc.com"]);
  });

  it("never sends more than 20 enrich reads in one second", async () => {
    let now = 0;
    const sent: number[] = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: ((fn: () => void, ms: number) => {
          now += ms;
          fn();
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async () => {
        sent.push(now);
        return Response.json({ jsonrpc: "2.0", result: { value: null } });
      }) as typeof fetch
    });
    net.useEnrichRpc("https://rpc.example.test/secret", 1_200);
    const url = "https://rpc.example.test/secret";
    for (let i = 0; i < 30; i += 1) {
      await net.fetchEnrich()(url, { method: "POST", body: rpcBody("getAccountInfo") });
    }
    for (const start of sent) {
      const inSecond = sent.filter((t) => t >= start && t < start + 1_000).length;
      expect(inSecond).toBeLessThanOrEqual(ENRICH_RPS_CAP);
    }
    expect(net.stats().find((row) => row.id === "helius")?.reqLastMin).toBe(0);
  });

  it("pauses the enrich host on 429 and does not open a Helius lane", async () => {
    const hosts: string[] = [];
    const net = new NetLimiter({
      clock: { random: () => 0.5 },
      fetchImpl: (async (input: RequestInfo | URL) => {
        hosts.push(new URL(String(input)).hostname);
        return new Response("", { status: 429 });
      }) as typeof fetch
    });
    net.useEnrichRpc(ALCHEMY, 45);
    await net.fetchEnrich()(ALCHEMY, { method: "POST", body: rpcBody("getAccountInfo") });
    await net.fetchEnrich()(ALCHEMY, { method: "POST", body: rpcBody("getTokenLargestAccounts") });
    await net.fetchEnrich()(ALCHEMY, { method: "POST", body: rpcBody("getMultipleAccounts") });
    const enrich = net.stats().find((row) => row.id === "enrich")!;
    expect(enrich.count429).toBeGreaterThanOrEqual(1);
    expect(enrich.circuitOpen || enrich.pausedUntil != null).toBe(true);
    expect(hosts.every((host) => host === "solana-mainnet.g.alchemy.com")).toBe(true);
    expect(net.stats().find((row) => row.id === "helius")?.reqLastMin).toBe(0);
    const wallet = await net.fetchAt(-1)(HELIUS, { method: "POST", body: rpcBody("getBalance") });
    expect(wallet.status).toBe(429);
    expect(hosts.at(-1)).toBe("mainnet.helius-rpc.com");
  });

  it("backs off the enrich lane on HTTP 500 and still serves a Helius wallet read", async () => {
    let enrichCalls = 0;
    const net = new NetLimiter({
      clock: { random: () => 0.5 },
      fetchImpl: (async (input: RequestInfo | URL) => {
        const host = new URL(String(input)).hostname;
        if (host.includes("alchemy")) {
          enrichCalls += 1;
          return new Response("", { status: 500 });
        }
        return Response.json({ jsonrpc: "2.0", result: { value: 1 } });
      }) as typeof fetch
    });
    net.useEnrichRpc(ALCHEMY, 45);
    await net.fetchEnrich()(ALCHEMY, { method: "POST", body: rpcBody("getAccountInfo") });
    const again = await net.fetchEnrich()(ALCHEMY, { method: "POST", body: rpcBody("getAccountInfo") });
    expect(again.status).toBe(429);
    expect(again.headers.get("x-nd-local")).toBe("1");
    expect(enrichCalls).toBe(1);
    const wallet = await net.fetchAt(0)(HELIUS, { method: "POST", body: rpcBody("getMultipleAccounts") });
    expect(wallet.status).toBe(200);
    expect(net.stats().find((row) => row.id === "enrich")?.count5xx).toBe(1);
    expect(net.stats().find((row) => row.id === "helius")?.count429).toBe(0);
  });

  it("keeps wallet, mark, and swap calls off a paused enrich host they share", async () => {
    let calls = 0;
    const net = new NetLimiter({
      clock: { random: () => 0.5 },
      fetchImpl: (async () => {
        calls += 1;
        if (calls <= 3) return new Response("", { status: 429 });
        return Response.json({ jsonrpc: "2.0", result: { value: 1 } });
      }) as typeof fetch
    });
    net.useEnrichRpc(ALCHEMY, 45);
    await Promise.all([
      net.fetchEnrich()(ALCHEMY, { method: "POST", body: rpcBody("getAccountInfo") }),
      net.fetchEnrich()(ALCHEMY, { method: "POST", body: rpcBody("getTokenLargestAccounts") }),
      net.fetchEnrich()(ALCHEMY, { method: "POST", body: rpcBody("getMultipleAccounts") })
    ]);
    expect(net.stats().find((row) => row.id === "enrich")?.circuitOpen).toBe(true);
    const balance = await net.fetchAt(-1)(ALCHEMY, { method: "POST", body: rpcBody("getBalance") });
    const marks = await net.fetchAt(0)(ALCHEMY, { method: "POST", body: rpcBody("getMultipleAccounts") });
    const sim = await net.fetchAt(1)(ALCHEMY, { method: "POST", body: rpcBody("simulateTransaction") });
    expect(balance.status).toBe(200);
    expect(marks.status).toBe(200);
    expect(sim.status).toBe(200);
    expect(balance.headers.get("x-nd-local")).toBeNull();
    expect(net.stats().find((row) => row.id === "enrich")?.reqLastMin).toBe(3);
  });
});

describe("v13.28 enrich calls", () => {
  it("skips getAccountInfo when dex already has mint, freeze, and supply", async () => {
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("dexscreener")) {
        return Response.json({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              priceUsd: "0.002",
              marketCap: 2_000,
              pairCreatedAt: Date.now() - 3_600_000,
              baseToken: { address: MINT, symbol: "SKIP", name: "Skip", mintAuthority: null, freezeAuthority: null },
              liquidity: { usd: 20_000 },
              volume: { h1: 12_000 }
            }
          ]
        });
      }
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      methods.push(method);
      if (method === "getTokenLargestAccounts") {
        return Response.json({ result: { value: [{ address: "Acct", uiAmount: 100, amount: "100", decimals: 6 }] } });
      }
      return Response.json({ result: { value: [{ data: { parsed: { info: { owner: "Owner" } } } }] } });
    };
    const token = await enrichSighting(
      { mint: MINT, source: "raydium", observedAt: 1 },
      { rpcUrl: ALCHEMY, fetchImpl }
    );
    expect(methods).not.toContain("getAccountInfo");
    expect(methods).toContain("getTokenLargestAccounts");
    expect(token.mintAuthorityRevoked).toBe(true);
    expect(token.top10HolderPct).not.toBeNull();
  });

  it("skips DAS pages unless the enrich RPC is Helius", async () => {
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("dexscreener")) return Response.json({ pairs: [] });
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      methods.push(method);
      if (method === "getAccountInfo") {
        return Response.json({
          result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, supply: "1000000", decimals: 6 } } } } }
        });
      }
      if (method === "getTokenAccounts") {
        return Response.json({ result: { token_accounts: [] } });
      }
      if (method === "getTokenLargestAccounts") return Response.json({ result: { value: [] } });
      return Response.json({ result: { value: [] } });
    };
    await enrichSighting({ mint: MINT, source: "pumpfun", observedAt: 1 }, { rpcUrl: ALCHEMY, holderPagesMax: 3, fetchImpl });
    expect(methods.filter((method) => method === "getTokenAccounts")).toHaveLength(0);
    methods.length = 0;
    await enrichSighting({ mint: MINT, source: "pumpfun", observedAt: 1 }, { rpcUrl: HELIUS, holderPagesMax: 3, fetchImpl });
    expect(methods.filter((method) => method === "getTokenAccounts").length).toBeGreaterThan(0);
  });

  it("leaves the sighting pending when the enrich host returns 429", async () => {
    const urls: string[] = [];
    const tape: RawTapeRow[] = [];
    const bus = new EventBus<DeskEvents>();
    const published: string[] = [];
    bus.on("scout.candidate", (token) => {
      published.push(token.mint);
    });
    const scout = new Scout({
      bus,
      feedMode: "live",
      demo: false,
      rpcUrl: ALCHEMY,
      rugcheckUrl: "https://api.rugcheck.xyz/v1",
      pumpWsUrl: "ws://unused",
      enrichConcurrency: 1,
      queueCap: 8,
      fetchImpl: async (input, init) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("helius")) throw new Error("enrich used Helius");
        if (init?.method === "POST") return new Response("", { status: 429 });
        return Response.json({ pairs: [] });
      },
      onTape: (row) => {
        tape.push(row);
      },
      onStatus: () => {}
    });
    scout.ingest({ mint: MINT, symbol: "PEND", source: "pumpfun", observedAt: 50, volume1hUsd: 10 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(published).toEqual([]);
    expect(scout.status.enriched).toBe(0);
    expect(tape.some((row) => row.mint === MINT && row.enrich === "pending")).toBe(true);
    expect(tape.some((row) => row.enrich === "enriched")).toBe(false);
    expect(urls.some((url) => url.includes("rugcheck"))).toBe(false);
    expect(urls.some((url) => url.includes("helius"))).toBe(false);
    expect(urls.some((url) => url.includes("solana-mainnet.g.alchemy.com"))).toBe(true);
    scout.stop();
  });

  it("waits out the longer pause when a second 429 extends the enrich hold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const pending: Array<(res: Response) => void> = [];
    let rpcPosts = 0;
    const second = "Mint222222222222222222222222222222222222222";
    const scout = new Scout({
      bus: new EventBus<DeskEvents>(),
      feedMode: "live",
      demo: false,
      rpcUrl: ALCHEMY,
      rugcheckUrl: "https://api.rugcheck.xyz/v1",
      pumpWsUrl: "ws://unused",
      enrichConcurrency: 2,
      queueCap: 8,
      fetchImpl: async (_input, init) => {
        if (init?.method !== "POST") return Response.json({ pairs: [] });
        rpcPosts += 1;
        if (rpcPosts > 2) return Response.json({ result: { value: null } });
        return await new Promise<Response>((resolve) => pending.push(resolve));
      },
      onTape: () => {},
      onStatus: () => {}
    });
    try {
      scout.ingest({ mint: MINT, source: "pumpfun", observedAt: 1 });
      scout.ingest({ mint: second, source: "pumpfun", observedAt: 2 });
      await vi.advanceTimersByTimeAsync(1);
      expect(pending).toHaveLength(2);
      pending[0]!(new Response("", { status: 429 }));
      pending[1]!(new Response("", { status: 429, headers: { "x-nd-local": "1", "x-nd-circuit": "1" } }));
      await vi.advanceTimersByTimeAsync(1);
      const pausedAt = rpcPosts;
      await vi.advanceTimersByTimeAsync(2_500);
      expect(rpcPosts).toBe(pausedAt);
      await vi.advanceTimersByTimeAsync(ENRICH_CIRCUIT_MS);
      expect(rpcPosts).toBeGreaterThan(pausedAt);
    } finally {
      scout.stop();
      vi.useRealTimers();
    }
  });

  it("does not ask RugCheck for a tape row that is still under the volume floor", () => {
    expect(needsFilterRugcheck(makeToken({ volume1hUsd: 100, lpLockedOrBurned: null }), 10_000)).toBe(false);
    expect(needsFilterRugcheck(makeToken({ volume1hUsd: 20_000, lpLockedOrBurned: null, mintAuthorityRevoked: true, top10HolderPct: 0.1 }), 10_000)).toBe(true);
    expect(needsFilterRugcheck(makeToken({ volume1hUsd: 20_000 }), 10_000)).toBe(false);
  });

  it("enriches the newest high-volume sighting first", () => {
    const older = sighting("old", 1, 9_000_000);
    const newerThin = sighting("new", 5, 1);
    const sameAgeFat = sighting("fat", 5, 50_000);
    expect(enrichBefore(older, newerThin)).toBeGreaterThan(0);
    expect(enrichBefore(newerThin, sameAgeFat)).toBeGreaterThan(0);
    expect(draftFromRaw(older, "pending").enrich).toBe("pending");
  });

  it("shows only the enrich hostname and the call rate", async () => {
    const desk = new Desk(
      testConfig({
        rpcUrl: ALCHEMY,
        walletRpcUrl: HELIUS
      })
    );
    try {
      const snap = desk.snapshot();
      const body = JSON.stringify(snap);
      expect(snap.enrich).toEqual({ host: "solana-mainnet.g.alchemy.com", callsPerMin: 0 });
      expect(body).not.toContain("supersecretkey");
      expect(body).not.toContain("heliussecret");
      expect(body).not.toContain("/v2/");
    } finally {
      desk.stop();
    }
  });
});

function sighting(mint: string, observedAt: number, volume1hUsd: number): RawSighting {
  return { mint, source: "pumpfun", observedAt, volume1hUsd };
}
