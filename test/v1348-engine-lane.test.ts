import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Desk } from "../src/desk/orchestrator.js";
import { BUCKETS, HELIUS_FRONT_RESERVE, NetLimiter } from "../src/market/net.js";
import { testConfig } from "./helpers.js";

const HELIUS = "https://mainnet.helius-rpc.com/?api-key=test";
const ceiling = BUCKETS.find((row) => row.id === "helius")!.budgetPerMin;

describe("v13.48 engine reads keep a slot on a busy Helius lane", () => {
  it("sends safety and both bundle reads at once after marks and chips have used the minute", async () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const sent: Array<{ id: number; method: string; at: number }> = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: ((fn: () => void, ms: number) => {
          timers.push({ at: now + ms, fn });
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body)) as { id: number; method: string };
        sent.push({ id: parsed.id, method: parsed.method, at: now });
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }) as typeof fetch
    });
    const post = (id: number, method: string, ndPriority: -1 | 0 | 2, ndReadLane = false) =>
      void net.fetch(HELIUS, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [`m${id}`] }),
        ndPriority,
        ndReadLane
      }).catch(() => null);
    for (let i = 1; i <= 30; i += 1) post(i, i % 2 === 0 ? "getMultipleAccounts" : "getAccountInfo", i % 2 === 0 ? 0 : 2);
    const step = () => {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next || next.at > 50_000) return false;
      now = Math.max(now, next.at);
      next.fn();
      return true;
    };
    while (step());
    const lane = () => net.stats().find((row) => row.id === "helius");
    expect(lane()?.reqLastMin).toBe(ceiling - HELIUS_FRONT_RESERVE);
    expect(lane()?.queued).toBeGreaterThan(0);
    const busyAt = now;
    post(101, "getAccountInfo", -1, true);
    post(102, "getSignaturesForAddress", -1, true);
    post(103, "getBlock", -1, true);
    expect(now).toBe(busyAt);
    expect(lane()?.reqLastMin).toBe(ceiling);
    expect(net.stats().find((row) => row.id === "helius:exec")?.reqLastMin ?? 0).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.filter((row) => row.id >= 101).map((row) => row.method)).toEqual([
      "getAccountInfo",
      "getSignaturesForAddress",
      "getBlock"
    ]);
    expect(sent.filter((row) => row.id >= 101).every((row) => row.at === busyAt)).toBe(true);
    const before = lane()?.reqLastMin;
    post(201, "getMultipleAccounts", 0);
    expect(lane()?.reqLastMin).toBe(before);
    expect(now - busyAt).toBeLessThan(8_000);
  });
});

describe("v13.48 light launch-bundle read", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const buyer = Keypair.generate().publicKey.toBase58();
  const ata = Keypair.generate().publicKey.toBase58();

  function deskWith(fetchImpl: typeof fetch): Desk {
    const desk = new Desk(testConfig({ walletRpcUrl: HELIUS }));
    desk.net.fetch = fetchImpl;
    return desk;
  }

  function rpc(desk: Desk) {
    return (desk as unknown as {
      rpcBundle: (mint: string, supply: bigint, priority?: -1 | 0 | 1 | 2, signal?: AbortSignal) => Promise<unknown>;
    }).rpcBundle.bind(desk);
  }

  function block(amount: string) {
    return {
      result: {
        transactions: [
          {
            meta: {
              preTokenBalances: [],
              postTokenBalances: [{ accountIndex: 1, mint, owner: buyer, uiTokenAmount: { amount } }]
            },
            transaction: {
              signatures: ["sig"],
              accountKeys: [
                { pubkey: buyer, signer: true, writable: true },
                { pubkey: ata, signer: false, writable: true }
              ]
            }
          }
        ]
      }
    };
  }

  it("asks getBlock for accounts only and still flags a 20% launch share", async () => {
    const calls: Array<{ body: { method: string; params: unknown[] }; priority?: number; readLane?: boolean; timeoutMs?: number }> = [];
    const desk = deskWith((async (_url: unknown, init?: RequestInit & { ndPriority?: number; ndReadLane?: boolean; timeoutMs?: number }) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push({ body, priority: init?.ndPriority, readLane: init?.ndReadLane, timeoutMs: init?.timeoutMs });
      if (body.method === "getSignaturesForAddress") {
        return new Response(JSON.stringify({ result: [{ slot: 9 }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(block("250000")), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    try {
      const result = (await rpc(desk)(mint, 1_000_000n, -1)) as { flagged: boolean; pct: number };
      expect(result.flagged).toBe(true);
      expect(result.pct).toBe(25);
      const blockCall = calls.find((call) => call.body.method === "getBlock");
      const config = blockCall?.body.params[1] as {
        transactionDetails?: string;
        rewards?: boolean;
        maxSupportedTransactionVersion?: number;
        encoding?: string;
      };
      expect(config.transactionDetails).toBe("accounts");
      expect(config.rewards).toBe(false);
      expect(config.maxSupportedTransactionVersion).toBe(0);
      expect(JSON.stringify(config)).not.toContain("full");
      expect(calls.every((call) => call.priority === -1 && call.readLane === true && call.timeoutMs === 15_000)).toBe(true);
      const under = deskWith((async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "getSignaturesForAddress") {
          return new Response(JSON.stringify({ result: [{ slot: 9 }] }), { status: 200 });
        }
        return new Response(JSON.stringify(block("100000")), { status: 200 });
      }) as typeof fetch);
      const clean = (await rpc(under)(mint, 1_000_000n, -1)) as { flagged: boolean };
      expect(clean.flagged).toBe(false);
      under.stop();
    } finally {
      desk.stop();
    }
  });

  it("reports a timeout and an RPC error as different reasons", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const hanging = deskWith((async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    const down = deskWith((async () => new Response("nope", { status: 503 })) as typeof fetch);
    const rpcError = deskWith((async () =>
      new Response(JSON.stringify({ error: { code: -32000, message: "block skipped" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch);
    try {
      expect(await rpc(hanging)(mint, 1n, -1, aborted.signal)).toEqual({ reason: "timeout" });
      expect(await rpc(down)(mint, 1n, -1)).toEqual({ reason: "rpc" });
      expect(await rpc(rpcError)(mint, 1n, -1)).toEqual({ reason: "rpc" });
    } finally {
      hanging.stop();
      down.stop();
      rpcError.stop();
    }
  });
});
