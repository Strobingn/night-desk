import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { EventBus } from "../../src/bus.js";
import { Scout } from "../../src/agents/scout.js";
import { FeedHealth } from "../../src/agents/feed-health.js";
import { classifyHttpFailure, isPumpDiscoveryUrl, PUMP_API_CHALLENGE } from "../../src/market/http-class.js";
import { PUMP_API_NEW_URL } from "../../src/market/listings.js";
import { NetLimiter } from "../../src/market/net.js";
import { curveMarkReason, decodePool, parseCurve, type PoolInfo } from "../../src/market/chain-marks.js";
import {
  CANONICAL_SOL_CURVE,
  curveState,
  graduationMarketCapLamports,
  solRemaining,
  type CurveReserves
} from "../../src/pump/curve.js";
import { TAPE_PROVIDER_LIMIT, decodePumpPortalFrame, decodeTradeEventLog, isSolQuoteMint } from "../../src/pump/events.js";
import { PumpCore } from "../../src/pump/index.js";
import { PUMP_SDK } from "../../src/pump/sdk.js";
import type { DeskEvents } from "../../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function headers(init: Record<string, string>): { get(name: string): string | null } {
  const lower = Object.fromEntries(Object.entries(init).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

function reservesFrom(curve: {
  virtualTokenReserves: { toString(radix: number): string };
  virtualQuoteReserves: { toString(radix: number): string };
  realTokenReserves: { toString(radix: number): string };
  realQuoteReserves: { toString(radix: number): string };
  tokenTotalSupply: { toString(radix: number): string };
  complete: boolean;
  creator: { toBase58(): string };
  isMayhemMode: boolean;
  quoteMint: { equals(other: PublicKey): boolean; toBase58(): string };
}): CurveReserves {
  return {
    virtualTokenReserves: BigInt(curve.virtualTokenReserves.toString(10)),
    virtualQuoteReserves: BigInt(curve.virtualQuoteReserves.toString(10)),
    realTokenReserves: BigInt(curve.realTokenReserves.toString(10)),
    realQuoteReserves: BigInt(curve.realQuoteReserves.toString(10)),
    tokenTotalSupply: BigInt(curve.tokenTotalSupply.toString(10)),
    complete: curve.complete,
    creator: curve.creator.toBase58(),
    isMayhemMode: curve.isMayhemMode,
    quoteMint: curve.quoteMint.equals(PublicKey.default) ? null : curve.quoteMint.toBase58()
  };
}

describe("pump HTTP discovery health", () => {
  it("classifies a Cloudflare challenge apart from a rejected key", () => {
    const challenge = classifyHttpFailure(
      403,
      headers({ "cf-mitigated": "challenge", server: "cloudflare", "content-type": "text/html" }),
      "<html>Just a moment</html>"
    );
    expect(challenge).toMatchObject({ kind: "challenge" });
    expect(challenge?.detail).toMatch(/not a key or plan rejection/);
    expect(classifyHttpFailure(402, headers({}), "")).toMatchObject({ kind: "auth", detail: "key or plan rejected (HTTP 402)" });
    expect(classifyHttpFailure(403, headers({ "content-type": "application/json" }), '{"error":"no"}')).toMatchObject({
      kind: "forbidden",
      detail: "HTTP 403 forbidden (not a key or plan rejection)"
    });
    expect(isPumpDiscoveryUrl(PUMP_API_NEW_URL)).toBe(true);
  });

  it("does not request frontend-api-v3 and reports the coin list as blocked", async () => {
    const urls: string[] = [];
    const net = new NetLimiter({
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch
    });
    const scout = new Scout({
      bus: new EventBus<DeskEvents>(),
      feedMode: "live",
      demo: false,
      pumpWsUrl: "ws://x",
      net,
      onStatus: () => undefined
    });
    scout.setSources({ pumpapi: true });
    const poll = scout as unknown as { pollPumpApi: () => Promise<void> };
    await poll.pollPumpApi();
    await poll.pollPumpApi();
    expect(urls.some((url) => url.includes("frontend-api-v3.pump.fun"))).toBe(false);
    const src = scout.report().sources!.find((row) => row.id === "pumpapi");
    expect(src).toMatchObject({ state: "blocked", enabled: true, detail: PUMP_API_CHALLENGE });
    expect(scout.report().lastError).toBeUndefined();
    const pump = scout.report().sources!.find((row) => row.id === "pump");
    expect(pump?.state).not.toBe("blocked");
    scout.stop();
  });

  it("keeps a challenged host off the banner and off the key-rejected wording", () => {
    const health = new FeedHealth();
    health.blocked("gecko", "Cloudflare challenge (not a key or plan rejection)");
    const status = health.status("gecko", { enabled: true, buckets: [] });
    expect(status.state).toBe("blocked");
    expect(status.detail).toMatch(/not a key or plan rejection/);
    expect(health.banner([status])).toBeUndefined();
  });
});

describe("mayhem SOL curve from a confirmed public account", () => {
  const meta = JSON.parse(readFileSync(path.join(root, "test/fixtures/pump/mmrich.json"), "utf8")) as {
    mint: string;
    signature: string;
    slot: number;
  };
  const account = Buffer.from(readFileSync(path.join(root, "test/fixtures/pump/mmrich-curve.b64"), "utf8"), "base64");

  it("prices from virtual reserves and does not treat real quote 1 as SOL in the curve", () => {
    const decoded = PUMP_SDK.decodeBondingCurve({
      data: account,
      executable: false,
      lamports: 0,
      owner: PublicKey.default
    });
    const reserves = reservesFrom(decoded);
    const state = curveState(meta.mint, reserves);
    expect(state.isMayhemMode).toBe(true);
    expect(state.quoteIsSol).toBe(true);
    expect(state.realQuoteReserves).toBe("1");
    expect(state.solInCurveLamports).toBeNull();
    expect(state.virtualQuoteReserves).not.toBe("30000000000");
    const parsed = parseCurve(account, 6);
    expect(parsed?.traded).toBe(true);
    expect(parsed?.realSol).toBeLessThan(0.01);
    const whole = Number(reserves.virtualTokenReserves) / 1e6;
    expect(parsed?.native).toBeCloseTo(Number(reserves.virtualQuoteReserves) / 1e9 / whole, 8);
    expect(curveMarkReason(account, 6)).toBeNull();
    const dustRatio = Number((1n * 10_000n) / (1n + solRemaining(reserves))) / 100;
    if (state.progressPct == null) {
      expect(dustRatio).toBeGreaterThanOrEqual(0);
    } else {
      expect(Math.abs(state.progressPct - dustRatio)).toBeGreaterThan(0.5);
      expect(state.progressPct).toBeGreaterThan(0);
    }
    const canonicalGrad = graduationMarketCapLamports(CANONICAL_SOL_CURVE);
    expect(state.graduationMarketCapLamports).not.toBe(canonicalGrad.toString());
    expect(state.graduationMarketCapLamports).not.toBeNull();
  });

  it("fails closed on a non-SOL quote, a bad discriminator, and an unmoved dust curve", () => {
    const other = Buffer.from(account);
    other.set(USDC.toBytes(), 83);
    expect(parseCurve(other, 6)).toBeNull();
    expect(curveMarkReason(other, 6)).toMatch(/not SOL/);
    const bad = Buffer.from(account);
    bad[0] = bad[0]! ^ 0xff;
    expect(parseCurve(bad, 6)).toBeNull();
    expect(curveMarkReason(bad, 6)).toMatch(/did not match the pump IDL/);
    const idle = Buffer.from(account);
    idle.set(account.subarray(16, 24), 142);
    idle[32] = 1;
    for (let i = 33; i < 40; i += 1) idle[i] = 0;
    expect(parseCurve(idle, 6)?.traded).toBe(false);
    expect(curveMarkReason(idle, 6)).toMatch(/no SOL has traded/);
    const info: PoolInfo = { kind: "curve", pair: "curve", mint: meta.mint, decimals: 6, keys: ["curve"] };
    expect(decodePool(info, [idle])).toBeNaN();
    expect(decodePool(info, [other])).toBeNaN();
    expect(typeof decodePool(info, [account])).toBe("number");
  });

  it("decodes the confirmed sell and refuses a non-SOL quote mint", () => {
    const logs = JSON.parse(readFileSync(path.join(root, "test/fixtures/pump/mmrich-trade-logs.json"), "utf8")) as string[];
    const line = logs[0] ?? "";
    const event = decodeTradeEventLog(Buffer.from(line.slice("Program data: ".length), "base64"), {
      signature: meta.signature,
      slot: meta.slot
    });
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      mint: meta.mint,
      isBuy: false,
      ixName: "sell",
      realQuoteReserves: "1",
      quoteMint: null,
      slot: meta.slot,
      signature: meta.signature
    });
    expect(event!.solAmountLamports).not.toBe("1");
    expect(BigInt(event!.solAmountLamports) > 1_000_000n).toBe(true);
    expect(isSolQuoteMint(USDC.toBase58())).toBe(false);
    expect(isSolQuoteMint(null)).toBe(true);
    const decoded = PUMP_SDK.decodeTradeEventBc(Buffer.from(line.slice("Program data: ".length), "base64").subarray(8));
    const encoded = (
      PUMP_SDK as unknown as {
        offlinePumpProgram: { coder: { types: { encode(name: string, value: unknown): Buffer } } };
      }
    ).offlinePumpProgram.coder.types.encode("tradeEvent", { ...decoded, quoteMint: USDC });
    const wrapped = Buffer.concat([Buffer.from(line.slice("Program data: ".length), "base64").subarray(0, 8), encoded]);
    expect(decodeTradeEventLog(wrapped, { signature: meta.signature })).toBeNull();
  });
});

describe("free pump tape", () => {
  it("records a create-frame buy and says the rest of the tape is not subscribed", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const frame = JSON.stringify({
      mint,
      txType: "create",
      signature: "createsig",
      traderPublicKey: Keypair.generate().publicKey.toBase58(),
      solAmount: 0.02,
      tokenAmount: 1.5
    });
    const decoded = decodePumpPortalFrame(frame, 1_700_000_000_000);
    expect(decoded?.kind).toBe("coin");
    if (decoded?.kind === "coin") {
      expect(decoded.trade?.solAmountLamports).toBe(String(20_000_000));
      expect(decoded.trade?.isBuy).toBe(true);
    }
    const bare = decodePumpPortalFrame(JSON.stringify({ mint, txType: "create" }), 1);
    expect(bare?.kind === "coin" && bare.trade).toBeFalsy();
    const db = new DatabaseSync(":memory:");
    const core = new PumpCore({ db, rpcUrl: "http://127.0.0.1", now: () => 1 });
    const body = (await core.handle("GET", new URL("http://desk/api/pump/trades?mint=" + mint), null)).body as {
      trades: unknown[];
      tape: { status: string; reason: string };
    };
    expect(body.trades).toEqual([]);
    expect(body.tape.status).toBe("provider_limited");
    expect(body.tape.reason).toBe(TAPE_PROVIDER_LIMIT);
    expect(body.tape.reason).toMatch(/not invented/);
    expect(body.tape.reason).toMatch(/subscribeTokenTrade/);
  });
});
