import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { loadConfig } from "../src/config.js";
import { assessPosition } from "../src/agents/risk.js";
import { resolveRules } from "../src/rules.js";
import { base58Decode, parseSecretKey } from "../src/market/wallet-key.js";
import { inspectDeskWallet, type WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "./helpers.js";

const liveBroker = vi.hoisted(() => ({ executeLiveSwap: vi.fn() }));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));

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
    while (carry > 0) {
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

function liveDesk(balances: () => Promise<WalletBalances> = rich, dbDir?: string): Desk {
  const key = Keypair.generate();
  const secret = base58Encode(key.secretKey);
  const cfg = testConfig({ mode: "live", liveRequested: true, readWalletSecret: () => secret });
  if (dbDir) {
    cfg.dbPath = path.join(dbDir, "desk.sqlite");
    cfg.jsonlPath = path.join(dbDir, "desk.jsonl");
    cfg.logPath = path.join(dbDir, "desk.log");
  }
  return new Desk(cfg, { walletBalances: balances });
}

function liveFill(sizeUsd: number, price = 1.01) {
  return { signature: "sig-test", fillPriceUsd: price, qty: sizeUsd / price, notionalUsd: sizeUsd, feeUsd: 0.01, slippage: 0.01 };
}

beforeEach(() => {
  liveBroker.executeLiveSwap.mockReset();
  liveBroker.executeLiveSwap.mockImplementation(async (req: { side: string; sizeUsd?: number; qty?: number }) =>
    req.side === "buy" ? liveFill(req.sizeUsd ?? 0) : { signature: "sig-sell", fillPriceUsd: 1, qty: req.qty ?? 0, notionalUsd: req.qty ?? 0, feeUsd: 0.01, slippage: 0.01 }
  );
});

describe("v13.5 wallet key (WALLET_PRIVATE_KEY)", () => {
  it("parses a Phantom base58 key and a JSON byte array, and refuses junk", () => {
    const key = Keypair.generate();
    const b58 = base58Encode(key.secretKey);
    expect(Array.from(base58Decode(b58)!)).toEqual(Array.from(key.secretKey));
    expect(parseSecretKey(b58)).not.toBeNull();
    expect(parseSecretKey(` "${b58}" `)).not.toBeNull();
    expect(parseSecretKey(JSON.stringify(Array.from(key.secretKey)))).not.toBeNull();
    expect(parseSecretKey("")).toBeNull();
    expect(parseSecretKey("not a key 0OIl")).toBeNull();
    expect(parseSecretKey(base58Encode(key.secretKey.slice(0, 32)))).toBeNull();
  });

  it("arms live only with LIVE_TRADING=true and a valid key; the config never holds the secret as a string", () => {
    const key = Keypair.generate();
    const b58 = base58Encode(key.secretKey);
    const paper = loadConfig({ WALLET_PRIVATE_KEY: b58 });
    expect(paper.mode).toBe("paper");
    const live = loadConfig({ LIVE_TRADING: "true", WALLET_PRIVATE_KEY: b58 });
    expect(live.mode).toBe("live");
    expect(JSON.stringify(live)).not.toContain(b58);
    expect(Object.values(live).some((v) => typeof v === "string" && v.includes(b58))).toBe(false);
    const bad = loadConfig({ LIVE_TRADING: "true", WALLET_PRIVATE_KEY: "garbage" });
    expect(bad.mode).toBe("paper");
    expect(bad.armError).toMatch(/WALLET_PRIVATE_KEY is not a valid/);
    expect(bad.armError).not.toContain("garbage");
    const empty = loadConfig({ LIVE_TRADING: "true", WALLET_PRIVATE_KEY: "" });
    expect(empty.mode).toBe("paper");
    expect(empty.armError).toMatch(/WALLET_PRIVATE_KEY is empty/);
  });

  it("shows only the public address, SOL/USDC and key loaded on the wallet card", async () => {
    const key = Keypair.generate();
    const b58 = base58Encode(key.secretKey);
    const status = inspectDeskWallet({ readEnvSecret: () => b58 });
    expect(status).toMatchObject({ keypairPresent: true, walletPublicKey: key.publicKey.toBase58(), keySource: "env", keyInvalid: false });
    expect(inspectDeskWallet({ readEnvSecret: () => "nope" })).toMatchObject({ keypairPresent: false, keyInvalid: true });
    const desk = new Desk(testConfig({ readWalletSecret: () => b58 }), { walletBalances: async () => ({ sol: 1.25, usdc: 42, at: Date.now(), error: null }) });
    try {
      await desk.refreshWallet();
      const wallet = desk.snapshot().wallet!;
      expect(wallet).toMatchObject({ keyLoaded: true, keySource: "env", publicKey: key.publicKey.toBase58(), solBalance: 1.25, usdcBalance: 42, live: false });
      expect(wallet.liveTradeUsd).toBe(5);
      expect(wallet.liveDailyCapUsd).toBeNull();
      expect(wallet.liveTrailPct).toBe(0.01);
      const all = JSON.stringify(desk.snapshot());
      expect(all).not.toContain(b58);
      expect(all).not.toContain(b58.slice(0, 20));
      // Paper desk: a key alone never changes the paper cash.
      expect(desk.snapshot().cashUsd).toBe(10_000);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.5 live settings", () => {
  it("defaults to $5 / no daily cap / 1% trail and validates edits without touching paper sizes", () => {
    const desk = new Desk(testConfig());
    try {
      expect(desk.updateSettings({ positionSizeUsd: 1040, maxEntrySlippage: 8.5 }).ok).toBe(true);
      const a = desk.updateSettings({ liveTradeUsd: 7, liveTrailPct: 1.5, liveDailyCapUsd: 50 });
      expect(a.ok).toBe(true);
      if (a.ok) {
        expect(a.settings.liveTradeUsd).toBe(7);
        expect(a.settings.liveTrailPct).toBe(0.015);
        expect(a.settings.liveDailyCapUsd).toBe(50);
        expect(a.settings.positionSizeUsd).toBe(1040);
        expect(a.settings.maxEntrySlippage).toBe(0.085);
      }
      const off = desk.updateSettings({ liveDailyCapUsd: "" });
      expect(off.ok && off.settings.liveDailyCapUsd).toBeNull();
      expect(desk.updateSettings({ liveTrailPct: 0.5 }).ok).toBe(true);
      expect(desk.updateSettings({ liveTrailPct: 25 }).ok).toBe(true);
      const capped = desk.updateSettings({ liveTrailPct: 25 });
      expect(capped.ok && capped.settings.liveTrailPct).toBe(0.2);
      expect(desk.updateSettings({ liveTradeUsd: 0 }).ok).toBe(false);
      expect(desk.updateSettings({ liveTradeUsd: 5000 }).ok).toBe(false);
      expect(desk.updateSettings({ liveTrailPct: "x" }).ok).toBe(false);
      expect(desk.config.rules.stopLossPct).toBe(0.06);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.5 live orders", () => {
  it("live auto-buys use the $5 live size, never the paper auto size", async () => {
    const desk = liveDesk();
    try {
      desk.updateSettings({ positionSizeUsd: 1040, autoBuy: true });
      const m = "AutoLive11111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "AUTO", priceUsd: 1, liquidityUsd: 180_000 }));
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      expect(liveBroker.executeLiveSwap.mock.calls[0]?.[0]).toMatchObject({ side: "buy", mint: m, sizeUsd: 5 });
      const pos = desk.book.positions.get(m)!;
      expect(pos.live).toBe(true);
      expect(pos.costUsd).toBe(5);
      expect(desk.snapshot().mode).toBe("live");
    } finally {
      desk.stop();
    }
  });

  it("cuts a one-tap paper-sized request ($1,223) to the live size and sends one order on a double tap", async () => {
    const desk = liveDesk();
    try {
      desk.updateSettings({ autoBuy: false });
      const m = "TapLive111111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "TAP", priceUsd: 1, liquidityUsd: 180_000 }));
      expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
      const [first, second] = await Promise.all([desk.manualBuy(m, 1223), desk.manualBuy(m, 1223)]);
      expect(liveBroker.executeLiveSwap).toHaveBeenCalledTimes(1);
      expect(liveBroker.executeLiveSwap.mock.calls[0]?.[0]).toMatchObject({ side: "buy", sizeUsd: 5 });
      expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
      const sold = await Promise.all([desk.closePosition(m), desk.closePosition(m)]);
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((c) => c[0].side === "sell");
      expect(sells).toHaveLength(1);
      expect(sells[0]?.[0]).toHaveProperty("readEnvSecret");
      expect(sells[0]?.[0]).toHaveProperty("maxExitSlippage");
      expect(sold.some((r) => r.ok)).toBe(true);
      expect(desk.book.positions.has(m)).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("sell all closes live positions through the live broker", async () => {
    const desk = liveDesk();
    try {
      desk.updateSettings({ autoBuy: false, maxOpenPositions: 5 });
      const mints = ["SellAllA1111111111111111111111111111111111", "SellAllB1111111111111111111111111111111111"];
      for (const m of mints) {
        await desk.submitCandidate(makeToken({ mint: m, symbol: m.slice(0, 5), priceUsd: 1, liquidityUsd: 180_000 }));
        expect((await desk.manualBuy(m)).ok).toBe(true);
      }
      const out = await desk.closeAllPositions();
      expect(out.ok).toBe(true);
      expect(liveBroker.executeLiveSwap.mock.calls.filter((c) => c[0].side === "sell")).toHaveLength(2);
      expect(desk.book.positions.size).toBe(0);
    } finally {
      desk.stop();
    }
  });

  it("has no daily cap by default, and refuses past a cap when Dirk sets one", async () => {
    const desk = liveDesk();
    try {
      desk.updateSettings({ autoBuy: false, maxOpenPositions: 10 });
      const mk = (i: number) => `Cap${i}`.padEnd(43, "1");
      for (let i = 0; i < 3; i += 1) {
        await desk.submitCandidate(makeToken({ mint: mk(i), symbol: `C${i}`, priceUsd: 1, liquidityUsd: 180_000 }));
        expect((await desk.manualBuy(mk(i))).ok).toBe(true);
      }
      expect(desk.liveSpentTodayUsd()).toBe(15);
      desk.updateSettings({ liveDailyCapUsd: 18 });
      await desk.submitCandidate(makeToken({ mint: mk(3), symbol: "C3", priceUsd: 1, liquidityUsd: 180_000 }));
      const refused = await desk.manualBuy(mk(3));
      expect(refused).toMatchObject({ ok: false, code: "LIVE_DAILY_CAP" });
    } finally {
      desk.stop();
    }
  });

  it("fails closed when the wallet balance is unknown, USDC is short, or SOL for fees is missing", async () => {
    const cases: Array<[() => Promise<{ sol: number | null; usdc: number | null; at: number; error: string | null }>, RegExp]> = [
      [async () => ({ sol: null, usdc: null, at: Date.now(), error: "RPC HTTP 429" }), /balance unknown/],
      [async () => ({ sol: 0.5, usdc: 3, at: Date.now(), error: null }), /USDC/],
      [async () => ({ sol: 0.001, usdc: 100, at: Date.now(), error: null }), /SOL for fees/]
    ];
    for (const [balances, msg] of cases) {
      const desk = liveDesk(balances);
      try {
        desk.updateSettings({ autoBuy: false });
        const m = "Fail1111111111111111111111111111111111111111".slice(0, 43);
        await desk.submitCandidate(makeToken({ mint: m, symbol: "FAIL", priceUsd: 1, liquidityUsd: 180_000 }));
        const out = await desk.manualBuy(m);
        expect(out).toMatchObject({ ok: false, code: "LIVE_WALLET" });
        if (!out.ok) expect(out.error).toMatch(msg);
      } finally {
        desk.stop();
      }
    }
    expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();
  });

  it("keeps the paper book (and its positions) apart from the live book", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "night-desk-split-"));
    const paperCfg = testConfig({ resetPaper: false });
    paperCfg.dbPath = path.join(dir, "desk.sqlite");
    paperCfg.jsonlPath = path.join(dir, "desk.jsonl");
    paperCfg.logPath = path.join(dir, "desk.log");
    const paper = new Desk(paperCfg);
    const pm = "PaperKeep111111111111111111111111111111111";
    await paper.submitCandidate(makeToken({ mint: pm, symbol: "PKEEP", priceUsd: 1, liquidityUsd: 180_000 }));
    expect(paper.book.positions.has(pm)).toBe(true);
    const paperCash = paper.book.cashUsd;
    paper.stop();

    const live = liveDesk(rich, dir);
    try {
      expect(live.book.positions.has(pm)).toBe(false);
      await live.refreshWallet();
      expect(live.snapshot().cashUsd).toBe(100);
    } finally {
      live.stop();
    }
    expect(liveBroker.executeLiveSwap).not.toHaveBeenCalled();

    const again = new Desk({ ...paperCfg });
    try {
      expect(again.book.positions.has(pm)).toBe(true);
      expect(again.book.cashUsd).toBe(paperCash);
    } finally {
      again.stop();
    }
  });
});

describe("v13.5 live trail (1%) and the −6% hard stop", () => {
  const rules = resolveRules({});
  it("arms from the entry mark, not the slipped fill, and trails the highest accepted mark", () => {
    // Fill paid 4% slippage: entry 1.04, entry mark 1.00. A 1% trail on the fill would exit at once.
    const pos = { entryPrice: 1.04, peakPrice: 1.04, trailArmed: false, live: true, entryMark: 1.0, markPeak: 1.0 };
    expect(assessPosition(pos, 1.0, rules, { liveTrailPct: 0.01 }).action).toBe("hold");
    const up = assessPosition(pos, 1.1, rules, { liveTrailPct: 0.01 });
    expect(up.action).toBe("hold");
    expect(up.markPeak).toBe(1.1);
    expect(up.trailHintPrice).toBeCloseTo(1.089, 6);
    const down = assessPosition({ ...pos, markPeak: 1.1 }, 1.088, rules, { liveTrailPct: 0.01 });
    expect(down).toMatchObject({ action: "stop", code: "TRAIL_STOP" });
    // From entry: a 1% dip from the entry mark trails out (Dirk's setting).
    expect(assessPosition(pos, 0.989, rules, { liveTrailPct: 0.01 }).code).toBe("TRAIL_STOP");
  });

  it("checks the hard stop first and never applies the live trail to paper positions", () => {
    const live = { entryPrice: 1, peakPrice: 1, trailArmed: false, live: true, entryMark: 1, markPeak: 1 };
    expect(assessPosition(live, 0.93, rules, { liveTrailPct: 0.2 }).code).toBe("STOP_LOSS");
    const paper = { entryPrice: 1, peakPrice: 1.1, trailArmed: false };
    expect(assessPosition(paper, 1.05, rules, { liveTrailPct: 0.01 }).action).toBe("hold");
  });

  it("exits a live position through the live broker when the trail is hit on accepted marks", async () => {
    const desk = liveDesk();
    try {
      desk.updateSettings({ autoBuy: false });
      const m = "Trail1111111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: m, symbol: "TRL", priceUsd: 1, liquidityUsd: 180_000 }));
      expect((await desk.manualBuy(m)).ok).toBe(true);
      await desk.markPrice(m, 1.05);
      expect(desk.book.positions.has(m)).toBe(true);
      expect(desk.book.positions.get(m)!.markPeak).toBe(1.05);
      await desk.markPrice(m, 1.035);
      expect(desk.book.positions.has(m)).toBe(false);
      const sells = liveBroker.executeLiveSwap.mock.calls.filter((c) => c[0].side === "sell");
      expect(sells).toHaveLength(1);
      const closed = desk.snapshot().closed[0];
      expect(closed?.exitCode).toBe("TRAIL_STOP");
    } finally {
      desk.stop();
    }
  });
});

describe("v13.5 HTTP and web helpers", () => {
  it("serves /api/wallet read-only, takes the live settings, and refuses key or LIVE_TRADING fields", async () => {
    const { startServer } = await import("../src/server/http.js");
    const key = Keypair.generate();
    const b58 = base58Encode(key.secretKey);
    const desk = new Desk(testConfig({ readWalletSecret: () => b58 }), { walletBalances: async () => ({ sol: 0.3, usdc: 12, at: Date.now(), error: null }) });
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const wallet = await fetch(`http://127.0.0.1:${port}/api/wallet`);
      const body = await wallet.text();
      expect(wallet.status).toBe(200);
      expect(body).not.toContain(b58.slice(0, 16));
      expect(JSON.parse(body)).toMatchObject({ keyLoaded: true, publicKey: key.publicKey.toBase58(), solBalance: 0.3, usdcBalance: 12, live: false });
      const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).text();
      expect(state).not.toContain(b58.slice(0, 16));
      const ok = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ liveTradeUsd: 5, liveDailyCapUsd: null, liveTrailPct: 1 })
      });
      expect(ok.status).toBe(200);
      for (const bad of [{ WALLET_PRIVATE_KEY: "x" }, { LIVE_TRADING: true }, { privateKey: "x" }]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad) });
        expect(res.status).toBe(400);
      }
      expect(desk.config.mode).toBe("paper");
    } finally {
      server.close();
      desk.stop();
    }
  });

  it("web one-tap uses the live size on a live desk, and the wallet card never prints a secret", async () => {
    const { effectiveTapUsd, buyToast } = await import("../web/src/onetap.js");
    expect(effectiveTapUsd("live", 1223, 5)).toBe(5);
    expect(effectiveTapUsd("live", 1223, undefined)).toBe(5);
    expect(effectiveTapUsd("paper", 1223, 5)).toBe(1223);
    expect(buyToast("TAP", { ok: true, sizeUsd: 5, mode: "live" }, 800)).toContain("· LIVE ·");
    const { walletLines, shortAddress } = await import("../web/src/walletText.js");
    expect(shortAddress("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe("9xQe…VFin");
    const none = walletLines(undefined, "paper");
    expect(none.lines[0]).toMatch(/not reported/);
    const w = {
      keyLoaded: false, keySource: null, keyInvalid: false, publicKey: null, solBalance: null, usdcBalance: null, balanceAt: null, balanceError: null,
      live: false, liveRequested: false, rpcPublic: true, liveTradeUsd: 5, liveDailyCapUsd: null, liveTrailPct: 0.01, liveSpentTodayUsd: 0, minFeeSol: 0.005
    } as const;
    const off = walletLines({ ...w }, "paper");
    expect(off.badge).toBe("LIVE OFF");
    expect(off.lines[0]).toMatch(/Fill WALLET_PRIVATE_KEY=/);
    const on = walletLines({ ...w, keyLoaded: true, keySource: "env", live: true, liveRequested: true }, "live");
    expect(on).toMatchObject({ badge: "LIVE ON", tone: "live" });
  });
});
