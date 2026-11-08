import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Desk } from "../src/desk/orchestrator.js";
import { NetLimiter, bucketFor, rpcReadMethod } from "../src/market/net.js";
import { fetchWalletBalances, type WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const PUBLIC = "https://api.mainnet-beta.solana.com";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("public Solana RPC budget", () => {
  it("puts the public host on one shared read budget under the published ceiling", () => {
    const spec = bucketFor(PUBLIC);
    expect(spec?.id).toBe("solana:public");
    expect(spec!.budgetPerMin + spec!.burst).toBeLessThanOrEqual(spec!.limitPerMin);
    expect(spec?.budgetPerMin).toBeLessThanOrEqual(12);
    expect(rpcReadMethod(JSON.stringify({ method: "getBalance" }))).toBe("getBalance");
    expect(rpcReadMethod(JSON.stringify({ method: "sendTransaction" }))).toBeNull();
  });

  it("caches an identical getBalance and does not cache a send", async () => {
    let calls = 0;
    let now = 1_000_000;
    const net = new NetLimiter({
      clock: {
        now: () => now,
        setTimeout: ((fn: () => void, ms: number) => {
          now += ms;
          fn();
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(200, { jsonrpc: "2.0", result: { value: 1 } });
      }) as unknown as typeof fetch
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["owner"] });
    await net.fetch(PUBLIC, { method: "POST", body });
    await net.fetch(PUBLIC, { method: "POST", body });
    expect(calls).toBe(1);
    const send = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["raw"] });
    await net.fetch(PUBLIC, { method: "POST", body: send });
    await net.fetch(PUBLIC, { method: "POST", body: send });
    expect(calls).toBe(3);
  });

  it("turns a 429 into a pause and does not send the next priority-0 read", async () => {
    let calls = 0;
    const net = new NetLimiter({
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(429, { error: "too many" });
      }) as unknown as typeof fetch
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [] });
    const first = await net.fetchAt(0)(PUBLIC, { method: "POST", body });
    expect(first.status).toBe(429);
    expect(calls).toBe(1);
    const second = await net.fetchAt(0)(PUBLIC, { method: "POST", body });
    expect(second.status).toBe(429);
    expect(calls).toBe(1);
    expect(net.stats().find((row) => row.id === "solana:public")?.count429).toBe(1);
  });
});

describe("wallet balance fail-closed", () => {
  it("returns an error and nulls on HTTP 429 without a second guess", async () => {
    const read = await fetchWalletBalances(
      (async () => jsonResponse(429, {})) as unknown as typeof fetch,
      PUBLIC,
      "owner"
    );
    expect(read).toMatchObject({ sol: null, usdc: null, error: "RPC HTTP 429" });
  });

  it("keeps a recovered balance as stale, leaves operatorReady false, and signs nothing", async () => {
    const key = Keypair.generate();
    let next: WalletBalances = { sol: null, usdc: null, at: 1, error: "RPC HTTP 429" };
    const desk = new Desk(
      testConfig({
        mode: "live",
        liveRequested: true,
        rpcUrl: PUBLIC,
        walletRpcUrl: PUBLIC,
        readWalletSecret: () => JSON.stringify(Array.from(key.secretKey))
      }),
      { walletBalances: async () => next }
    );
    try {
      await desk.refreshWallet();
      const unknown = desk.snapshot();
      expect(unknown.wallet).toMatchObject({ solBalance: null, usdcBalance: null, balanceError: "RPC HTTP 429" });
      expect(unknown.liveBook).toMatchObject({ cashUsd: 0, cashKnown: false, balanceError: "RPC HTTP 429" });
      expect(unknown.readiness.operatorReady).toBe(false);
      expect(unknown.readiness.lines.join("\n")).not.toMatch(/Austin/);
      expect(unknown.readiness.lines.join("\n")).toMatch(/public Solana endpoint/);
      expect(unknown.readiness.lines.join("\n")).toMatch(/operatorReady is false/);
      expect(unknown.orders).toEqual([]);

      next = { sol: 0.07530984, usdc: 22.636332, at: 2, error: null };
      await desk.refreshWallet();
      const recovered = desk.snapshot();
      expect(recovered.wallet).toMatchObject({ solBalance: 0.07530984, usdcBalance: 22.636332, balanceError: null });
      expect(recovered.liveBook?.cashUsd).toBeCloseTo(22.64, 2);
      expect(recovered.liveBook?.cashKnown).toBe(true);
      expect(recovered.liveBook?.balanceError).toBeNull();
      expect(recovered.readiness.operatorReady).toBe(false);
      expect(recovered.orders).toEqual([]);

      next = { sol: null, usdc: null, at: 3, error: "RPC HTTP 429" };
      await desk.refreshWallet();
      const stale = desk.snapshot();
      expect(stale.wallet).toMatchObject({ solBalance: 0.07530984, usdcBalance: 22.636332, balanceError: "RPC HTTP 429" });
      expect(stale.liveBook).toMatchObject({ cashKnown: false, balanceError: "RPC HTTP 429" });
      expect(stale.liveBook?.cashUsd).toBeCloseTo(22.64, 2);
      expect(stale.readiness.operatorReady).toBe(false);
      expect(stale.readiness.lines.join("\n")).toMatch(/stale/);
      expect(stale.orders).toEqual([]);
    } finally {
      desk.stop();
    }
  });
});
