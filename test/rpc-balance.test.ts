import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { NetLimiter, bucketFor, rpcReadMethod, solanaExecSpec, BACKOFF_CAP_MS } from "../src/market/net.js";
import { fetchWalletBalances, type WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const swaps = vi.hoisted(() => ({ executeLiveSwap: vi.fn(), executePumpLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: swaps.executeLiveSwap }));
vi.mock("../src/market/pump-live.js", async () => {
  const actual = await vi.importActual<typeof import("../src/market/pump-live.js")>("../src/market/pump-live.js");
  return { ...actual, executePumpLiveSwap: swaps.executePumpLiveSwap };
});

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
    await net.fetchAt(0)(PUBLIC, { method: "POST", body });
    await net.fetchAt(0)(PUBLIC, { method: "POST", body });
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

  it("honors Retry-After on the exec lane and caps the pause at 2 minutes", async () => {
    const waits: number[] = [];
    let now = 5_000_000;
    let calls = 0;
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: ((fn: () => void, ms: number) => {
          waits.push(ms);
          now += ms;
          fn();
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? new Response("{}", { status: 429, headers: { "retry-after": "30" } })
          : jsonResponse(200, { result: "ok" });
      }) as unknown as typeof fetch
    });
    const sim = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [] });
    const first = await net.fetchAt(1)(PUBLIC, { method: "POST", body: sim });
    expect(first.status).toBe(429);
    const second = await net.fetchAt(1)(PUBLIC, { method: "POST", body: sim });
    expect(second.status).toBe(200);
    expect(waits).toContain(30_000);
    expect(net.note429(solanaExecSpec(), 500_000)).toBe(BACKOFF_CAP_MS);
    let step = 0;
    for (let i = 0; i < 12; i += 1) step = net.note429(bucketFor(PUBLIC)!, null);
    expect(step).toBeLessThanOrEqual(BACKOFF_CAP_MS);
  });

  it("keeps swap prep, simulate, and send off the 9/min poll queue, and refreshes held accounts past the cache", async () => {
    const methods: string[] = [];
    let now = 1_000_000;
    const queued: Array<{ at: number; fn: () => void }> = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        setTimeout: ((fn: () => void, ms: number) => {
          queued.push({ at: now + ms, fn });
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        methods.push(JSON.parse(String(init?.body)).method);
        return jsonResponse(200, { result: { value: [] } });
      }) as unknown as typeof fetch
    });
    const poll = (method: string, n: number) =>
      JSON.stringify({ jsonrpc: "2.0", id: n, method, params: [n] });
    await net.fetchAt(0)(PUBLIC, { method: "POST", body: poll("getBalance", 1) });
    await net.fetchAt(0)(PUBLIC, { method: "POST", body: poll("getTokenAccountsByOwner", 2) });
    const blocked = net.fetchAt(0)(PUBLIC, { method: "POST", body: poll("getMultipleAccounts", 3) });
    await Promise.resolve();
    const before = methods.length;
    for (const method of ["getAccountInfo", "getLatestBlockhash", "simulateTransaction", "sendTransaction"]) {
      const res = await net.fetchAt(1)(PUBLIC, { method: "POST", body: poll(method, methods.length) });
      expect(res.status).toBe(200);
    }
    expect(methods.slice(before)).toEqual(["getAccountInfo", "getLatestBlockhash", "simulateTransaction", "sendTransaction"]);
    let released = false;
    void blocked.then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(released).toBe(false);
    expect(methods).not.toContain("getMultipleAccounts");
    now = queued[0]!.at;
    queued[0]!.fn();
    await blocked;

    const marks = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [["mint"]] });
    const fresh = new NetLimiter({
      clock: {
        now: () => now,
        setTimeout: ((fn: () => void, ms: number) => {
          now += ms;
          fn();
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        methods.push(JSON.parse(String(init?.body)).method);
        return jsonResponse(200, { result: { value: [] } });
      }) as unknown as typeof fetch
    });
    const sent = methods.length;
    await fresh.fetchAt(0)(PUBLIC, { method: "POST", body: marks });
    await fresh.fetchAt(0)(PUBLIC, { method: "POST", body: marks });
    expect(methods.length).toBe(sent + 1);
    now += 10_000;
    await fresh.fetchAt(0)(PUBLIC, { method: "POST", body: marks });
    expect(methods.length).toBe(sent + 2);
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

  it("leaves a live limit and a live stop unsent while the balance is stale", async () => {
    swaps.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number }) => ({
      signature: "sig-test",
      fillPriceUsd: 1,
      qty: req.side === "buy" ? (req.sizeUsd ?? 5) : (req.qty ?? 0),
      notionalUsd: req.side === "buy" ? (req.sizeUsd ?? 5) : (req.qty ?? 0),
      feeUsd: 0.01,
      slippage: 0.01
    }));
    const key = Keypair.generate();
    let next: WalletBalances = { sol: 0.07530984, usdc: 22.636332, at: 1, error: null };
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
      const held = "StaleHold1111111111111111111111111111111111";
      const watched = "StaleLim11111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: held, symbol: "SH", priceUsd: 1, liquidityUsd: 500_000 }));
      await desk.submitCandidate(makeToken({ mint: watched, symbol: "SL", priceUsd: 1, liquidityUsd: 500_000 }));
      await desk.markPrice(held, 1);
      desk.setOperatorReady(true);
      expect((await desk.manualBuy(held, 5, { book: "live" })).ok).toBe(true);
      // A sell in the first 30s after a fill uses the booked amount when the wallet read fails.
      // This stop is an older position, so a stale balance still blocks it.
      const heldPos = desk.liveBook!.positions.get(held)!;
      heldPos.openedAt = Date.now() - 120_000;
      desk.setOperatorReady(false);
      const sent = swaps.executeLiveSwap.mock.calls.length;
      next = { sol: null, usdc: null, at: 2, error: "RPC HTTP 429" };
      expect(desk.placeOrder({ side: "take_profit", mint: held, value: 1.3, book: "live" }).ok).toBe(true);
      expect(desk.placeOrder({ side: "limit_buy", mint: watched, basis: "price", value: 0.5, book: "live" }).ok).toBe(true);
      await desk.markPrice(held, 1.31);
      await desk.markPrice(watched, 0.4);
      await desk.ordersSettled();
      expect(swaps.executeLiveSwap.mock.calls.length).toBe(sent);
      expect(swaps.executePumpLiveSwap).not.toHaveBeenCalled();
      const notes = (desk.snapshot().orders ?? []).map((order) => order.note ?? "").join("\n");
      expect(notes).toMatch(/Nothing was sent/);
      expect(desk.readiness().operatorReady).toBe(false);
      expect(desk.snapshot().liveBook?.cashUsd).toBeCloseTo(22.64, 2);
    } finally {
      desk.stop();
    }
  });
});
