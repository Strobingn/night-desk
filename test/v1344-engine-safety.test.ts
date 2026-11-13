import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { NetLimiter } from "../src/market/net.js";
import { safeMintAccount } from "../src/market/mint-safety.js";
import { STRATEGY } from "../src/strategy/config.js";
import type { FiredSignal } from "../src/strategy/engine.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));

const HELIUS = "https://mainnet.helius-rpc.com/?api-key=test";
const MINT = "EngineLive111111111111111111111111111111111";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

const rich = async (): Promise<WalletBalances> => ({ sol: 0.5, usdc: 100, at: Date.now(), error: null });

function liveDesk(deps: ConstructorParameters<typeof Desk>[1] = {}): Desk {
  const secret = base58Encode(Keypair.generate().secretKey);
  const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret, walletRpcUrl: HELIUS }), {
    walletBalances: rich,
    ...deps
  });
  desk.setOperatorReady(true);
  return desk;
}

const young = (over: Parameters<typeof makeToken>[0] = {}) =>
  makeToken({ mint: MINT, symbol: "ELV", priceUsd: 1, ageSeconds: 600, volume5mUsd: 40_000, liquidityUsd: 180_000, discoveredAt: Date.now(), ...over });
const quote = (at: number, priceUsd: number) => ({ at, priceUsd, vol5mUsd: 40_000, vol1hUsd: 180_000, change1hPct: 15, liquidityUsd: 180_000 });

async function signal(desk: Desk, token = young()): Promise<void> {
  await desk.submitCandidate(token);
  const t = Date.now();
  await desk.submitStrategyQuote(token.mint, quote(t + 10_000, token.priceUsd * 1.01), t + 10_000);
  await desk.submitStrategyQuote(token.mint, quote(t + 22_000, token.priceUsd * 1.025), t + 22_000);
}

const codes = (desk: Desk) => desk.snapshot().events.map((e) => e.code).filter(Boolean);

function watchSafety(desk: Desk): Array<{ priority?: number; readLane?: boolean }> {
  const seen: Array<{ priority?: number; readLane?: boolean }> = [];
  desk.net.fetch = (async (_input: unknown, init?: RequestInit & { ndPriority?: number; ndReadLane?: boolean }) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes('"getAccountInfo"')) seen.push({ priority: init?.ndPriority, readLane: init?.ndReadLane });
    return new Response(JSON.stringify({ result: { value: null } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof desk.net.fetch;
  (desk as unknown as { mintAccounts?: unknown }).mintAccounts = undefined;
  return seen;
}

function meta() {
  return { variant: "launch-3", signal: "launch" as const, stopPct: 0.03, targetNetUsd: 3, timeLimitMs: STRATEGY.launch.timeLimitMs };
}

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; markPriceUsd?: number }) => ({
    signature: "sig-buy",
    fillPriceUsd: (req.markPriceUsd ?? 1) * 1.005,
    qty: (req.sizeUsd ?? 0) / ((req.markPriceUsd ?? 1) * 1.005),
    notionalUsd: req.sizeUsd ?? 0,
    feeUsd: 0.01,
    slippage: 0.005
  }));
});

describe("v13.45 engine safety priority", () => {
  it("issues the paper engine safety read at priority -1", async () => {
    const desk = new Desk(testConfig({ walletRpcUrl: HELIUS }));
    const seen = watchSafety(desk);
    try {
      desk.updateStrategy({ enabled: true });
      await signal(desk);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((call) => call.priority === -1 && call.readLane === true)).toBe(true);
      expect(codes(desk)).toContain("TOKEN_SAFETY");
      expect(codes(desk)).not.toContain("ENGINE_LIVE_SKIP");
      expect(codes(desk)).not.toContain("ENGINE_LIVE_PAUSED");
    } finally {
      desk.stop();
    }
  });

  it("issues the live engine safety read at priority -1 and labels the skip", async () => {
    const desk = liveDesk();
    const seen = watchSafety(desk);
    try {
      desk.updateSettings({ dailyMaxLossUsd: 10 });
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      const now = Date.now();
      desk.store.openTrade({ id: "paper-loss", mint: "paperLossMint", symbol: "LOSS", openedAt: now - 60_000, costUsd: 50, score: 0.7, mode: "paper" });
      desk.store.closeTrade({
        id: "paper-loss",
        mint: "paperLossMint",
        symbol: "LOSS",
        openedAt: now - 60_000,
        closedAt: now - 30_000,
        costUsd: 50,
        proceedsUsd: 39,
        pnlUsd: -11,
        pnlPct: -11 / 50,
        exitCode: "STOP_LOSS",
        score: 0.7,
        mode: "paper"
      });
      await signal(desk);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((call) => call.priority === -1 && call.readLane === true)).toBe(true);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(codes(desk)).toContain("ENGINE_LIVE_SKIP");
      expect(codes(desk)).toContain("DAILY_LOSS");
      expect(codes(desk)).not.toContain("ENGINE_LIVE_PAUSED");
      const skip = desk.snapshot().events.find((e) => e.code === "ENGINE_LIVE_SKIP");
      expect(skip?.message).toMatch(/Unknown/);
    } finally {
      desk.stop();
    }
  });

  it("keeps ENGINE_LIVE_PAUSED for an actual pause", async () => {
    const secret = base58Encode(Keypair.generate().secretKey);
    const desk = new Desk(testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret }), { walletBalances: rich });
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      await signal(desk);
      expect(codes(desk)).toContain("ENGINE_LIVE_PAUSED");
      expect(codes(desk)).not.toContain("ENGINE_LIVE_SKIP");
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
    } finally {
      desk.stop();
    }
  });

  it("skips the engine live buy when the launch bundle check exceeds 15s", async () => {
    const desk = liveDesk({ launchBundle: () => new Promise(() => {}) });
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      const started = Date.now();
      const fired: FiredSignal = { signal: { signal: "launch", priceUsd: 1, risePct: 0.02, reason: "test" }, token: young({ source: "pumpfun" }), score: 0.8, meta: meta(), liveMeta: meta() };
      await (desk as unknown as { strategyLiveBuy: (fired: FiredSignal) => Promise<void> }).strategyLiveBuy(fired);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(14_000);
      expect(elapsed).toBeLessThan(18_000);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(codes(desk)).toContain("LAUNCH_BUNDLE_UNVERIFIED");
      expect(desk.snapshot().events.find((e) => e.code === "LAUNCH_BUNDLE_UNVERIFIED")?.message).toMatch(/timed out/);
      expect(codes(desk)).not.toContain("ENGINE_LIVE_PAUSED");
      expect(codes(desk)).not.toContain("ENGINE_LIVE_SKIP");
    } finally {
      desk.stop();
    }
  }, 20_000);

  it("skips the engine live buy when the launch bundle check errors", async () => {
    const desk = liveDesk({ launchBundle: () => Promise.reject(new Error("rpc down")) });
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      const fired: FiredSignal = { signal: { signal: "launch", priceUsd: 1, risePct: 0.02, reason: "test" }, token: young({ source: "pumpfun" }), score: 0.8, meta: meta(), liveMeta: meta() };
      await (desk as unknown as { strategyLiveBuy: (fired: FiredSignal) => Promise<void> }).strategyLiveBuy(fired);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(codes(desk)).toContain("LAUNCH_BUNDLE_UNVERIFIED");
      expect(desk.snapshot().events.find((e) => e.code === "LAUNCH_BUNDLE_UNVERIFIED")?.message).toMatch(/RPC error/);
      expect(codes(desk)).not.toContain("ENGINE_LIVE_PAUSED");
    } finally {
      desk.stop();
    }
  });

  it("drops an aborted safety read instead of leaving it queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const net = new NetLimiter({
      fetchImpl: (async () => {
        await gate;
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });
    const url = HELIUS;
    const body = (n: number) =>
      JSON.stringify({ jsonrpc: "2.0", id: n, method: "getAccountInfo", params: [`Mint${n}11111111111111111111111111111111111`, { encoding: "base64" }] });
    const hang = (n: number) => net.fetch(url, { method: "POST", body: body(n), ndPriority: -1 });
    const first = hang(1);
    const second = hang(2);
    const ac = new AbortController();
    const queued = net.fetch(url, { method: "POST", body: body(3), ndPriority: -1, signal: ac.signal });
    expect(net.stats().find((row) => row.id === "helius:exec")?.queued).toBe(1);
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(net.stats().find((row) => row.id === "helius:exec")?.queued).toBe(0);
    release();
    await Promise.all([first, second]);
  });
  it("lets a buy re-read a coin a background check left Unknown", async () => {
    const desk = new Desk(testConfig({ walletRpcUrl: HELIUS }));
    const seen = watchSafety(desk);
    const safety = (priority: -1 | 2) =>
      (desk as unknown as { tokenSafety: (mint: string, priority: number) => Promise<{ status: string }> }).tokenSafety(MINT, priority);
    try {
      expect((await safety(2)).status).toBe("unknown");
      await safety(2);
      expect(seen).toEqual([{ priority: 2, readLane: false }]);
      await safety(-1);
      expect(seen).toEqual([{ priority: 2, readLane: false }, { priority: -1, readLane: false }]);
    } finally {
      desk.stop();
    }
  });

  it("does not make a buy wait on a background safety read already queued", async () => {
    const desk = new Desk(testConfig({ walletRpcUrl: HELIUS }));
    const seen: Array<number | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reply = () => new Response(JSON.stringify({ result: { value: null } }), { status: 200, headers: { "content-type": "application/json" } });
    desk.net.fetch = (async (_input: unknown, init?: RequestInit & { ndPriority?: number }) => {
      seen.push(init?.ndPriority);
      if (init?.ndPriority !== -1) await gate;
      return reply();
    }) as typeof desk.net.fetch;
    (desk as unknown as { mintAccounts?: unknown }).mintAccounts = undefined;
    const safety = (priority: -1 | 2) =>
      (desk as unknown as { tokenSafety: (mint: string, priority: number) => Promise<{ status: string }> }).tokenSafety(MINT, priority);
    try {
      const slow = safety(2);
      await safety(-1);
      expect(seen).toEqual([2, -1]);
      release();
      await slow;
    } finally {
      desk.stop();
    }
  });

  it("sends the engine safety and bundle reads on the read lane, not the exec burst", async () => {
    const sent: string[] = [];
    const net = new NetLimiter({
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent.push(String(init?.body ?? ""));
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });
    const call = (method: string) =>
      net.fetch(HELIUS, { method: "POST", body: JSON.stringify({ method }), ndPriority: -1, ndReadLane: true });
    await Promise.all([call("getAccountInfo"), call("getSignaturesForAddress"), call("getBlock")]);
    expect(sent).toHaveLength(3);
    expect(net.stats().find((row) => row.id === "helius")?.sent).toBe(3);
    expect(net.stats().find((row) => row.id === "helius:exec")?.sent ?? 0).toBe(0);
  });

  it("does not cancel a shared request when only one caller aborts", async () => {
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => (release = resolve));
    const net = new NetLimiter({ fetchImpl: (() => gate) as typeof fetch });
    const url = "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112";
    const ac = new AbortController();
    const first = net.fetch(url, { signal: ac.signal });
    const second = net.fetch(url, { signal: AbortSignal.timeout(30_000) });
    await new Promise((resolve) => setImmediate(resolve));
    ac.abort();
    release(new Response("ok", { status: 200 }));
    await expect(second).resolves.toMatchObject({ status: 200 });
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it("does not treat a failed bundle cache as a verified live buy", async () => {
    let calls = 0;
    const desk = liveDesk({
      launchBundle: async () => {
        calls += 1;
        return { flagged: true, pct: 0.4, label: "Bundled: 40%", acquired: 1n };
      }
    });
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      const token = young({ source: "pumpfun" });
      (desk as unknown as { bundleCache: Map<string, { at: number; forever: boolean; result: { flagged: boolean; pct: number; label: string | null; acquired: bigint } }> }).bundleCache.set(token.mint, {
        at: Date.now(),
        forever: false,
        result: { flagged: false, pct: 0, label: null, acquired: 0n }
      });
      const fired: FiredSignal = { signal: { signal: "launch", priceUsd: 1, risePct: 0.02, reason: "test" }, token, score: 0.8, meta: meta(), liveMeta: meta() };
      await (desk as unknown as { strategyLiveBuy: (fired: FiredSignal) => Promise<void> }).strategyLiveBuy(fired);
      expect(calls).toBe(1);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(codes(desk)).toContain("ENGINE_LIVE_SKIP");
      expect(codes(desk)).not.toContain("LAUNCH_BUNDLE_UNVERIFIED");
    } finally {
      desk.stop();
    }
  });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("v13.46 engine check timeouts", () => {
  it("accepts an engine safety read that answers in about 6s", async () => {
    const desk = new Desk(testConfig({ walletRpcUrl: HELIUS }), {
      mintAccounts: () => new Promise((resolve) => setTimeout(() => resolve(safeMintAccount()), 6_000))
    });
    try {
      desk.updateStrategy({ enabled: true });
      const started = Date.now();
      await signal(desk);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(5_500);
      expect(elapsed).toBeLessThan(8_000);
      expect(codes(desk)).not.toContain("TOKEN_SAFETY");
      expect(desk.book.positions.get(MINT)?.strategy).toBeDefined();
    } finally {
      desk.stop();
    }
  }, 12_000);

  it("accepts a live engine safety read that answers in about 6s", async () => {
    const desk = liveDesk({
      mintAccounts: () => new Promise((resolve) => setTimeout(() => resolve(safeMintAccount()), 6_000))
    });
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      const started = Date.now();
      const fired: FiredSignal = { signal: { signal: "launch", priceUsd: 1, risePct: 0.02, reason: "test" }, token: young(), score: 0.8, meta: meta(), liveMeta: meta() };
      await (desk as unknown as { strategyLiveBuy: (fired: FiredSignal) => Promise<void> }).strategyLiveBuy(fired);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(5_500);
      expect(elapsed).toBeLessThan(8_000);
      expect(liveBroker.executeLiveSwap).toHaveBeenCalled();
      expect(codes(desk)).not.toContain("ENGINE_LIVE_SKIP");
      expect(codes(desk)).not.toContain("TOKEN_SAFETY");
    } finally {
      desk.stop();
    }
  }, 12_000);

  it("skips an engine safety read that exceeds 8s as Unknown", async () => {
    const desk = liveDesk({ mintAccounts: () => new Promise(() => {}) });
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3" });
      const started = Date.now();
      const fired: FiredSignal = { signal: { signal: "launch", priceUsd: 1, risePct: 0.02, reason: "test" }, token: young(), score: 0.8, meta: meta(), liveMeta: meta() };
      await (desk as unknown as { strategyLiveBuy: (fired: FiredSignal) => Promise<void> }).strategyLiveBuy(fired);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(7_500);
      expect(elapsed).toBeLessThan(11_000);
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      expect(codes(desk)).toContain("ENGINE_LIVE_SKIP");
      expect(codes(desk)).not.toContain("LAUNCH_BUNDLE_UNVERIFIED");
      const skip = desk.snapshot().events.find((e) => e.code === "ENGINE_LIVE_SKIP");
      expect(skip?.message).toMatch(/Unknown/);
    } finally {
      desk.stop();
    }
  }, 12_000);

  it("keeps a manual safety read at 2.5s while an engine read waits 8s", async () => {
    const desk = new Desk(testConfig({ walletRpcUrl: HELIUS }), { mintAccounts: () => new Promise(() => {}) });
    const safety = (readLane: boolean) =>
      (desk as unknown as { tokenSafety: (mint: string, priority: number, readLane?: boolean) => Promise<{ status: string }> }).tokenSafety(MINT, -1, readLane);
    try {
      const started = Date.now();
      const engine = safety(true);
      await delay(30);
      const manualStarted = Date.now();
      const manual = safety(false);
      await expect(manual).resolves.toMatchObject({ status: "unknown" });
      const manualElapsed = Date.now() - manualStarted;
      expect(manualElapsed).toBeGreaterThanOrEqual(2_300);
      expect(manualElapsed).toBeLessThan(4_000);
      await expect(engine).resolves.toMatchObject({ status: "unknown" });
      const engineElapsed = Date.now() - started;
      expect(engineElapsed).toBeGreaterThanOrEqual(7_500);
      expect(engineElapsed).toBeLessThan(11_000);
    } finally {
      desk.stop();
    }
  }, 12_000);

  it("uses a shorter in-flight safety read when it answers Safe", async () => {
    let reads = 0;
    const desk = new Desk(testConfig({ walletRpcUrl: HELIUS }), {
      mintAccounts: () => {
        reads += 1;
        return new Promise((resolve) => setTimeout(() => resolve(safeMintAccount()), 400));
      }
    });
    const safety = (readLane: boolean) =>
      (desk as unknown as { tokenSafety: (mint: string, priority: number, readLane?: boolean) => Promise<{ status: string }> }).tokenSafety(MINT, -1, readLane);
    try {
      const manual = safety(false);
      const engine = safety(true);
      await expect(engine).resolves.toMatchObject({ status: "safe", chip: "Safe" });
      await expect(manual).resolves.toMatchObject({ status: "safe" });
      expect(reads).toBe(1);
    } finally {
      desk.stop();
    }
  });

  it("does not hold the one-live-buy lock across another coin's safety read", async () => {
    let reads = 0;
    const desk = liveDesk({
      mintAccounts: async () => {
        reads += 1;
        await delay(150);
        return safeMintAccount();
      }
    });
    liveBroker.executeLiveSwap.mockImplementation(() => new Promise(() => {}));
    try {
      desk.updateStrategy({ enabled: true, liveVariant: "launch-3", maxOpen: 2 });
      const buy = (mint: string, symbol: string) => {
        const fired: FiredSignal = {
          signal: { signal: "launch", priceUsd: 1, risePct: 0.02, reason: "test" },
          token: young({ mint, symbol }),
          score: 0.8,
          meta: meta(),
          liveMeta: meta()
        };
        return (desk as unknown as { strategyLiveBuy: (fired: FiredSignal) => Promise<void> }).strategyLiveBuy(fired);
      };
      const first = buy(MINT, "ELV");
      const second = buy("EngineLive222222222222222222222222222222222", "EL2");
      await delay(400);
      expect(reads).toBe(2);
      void first;
      void second;
    } finally {
      desk.stop();
    }
  });
});
