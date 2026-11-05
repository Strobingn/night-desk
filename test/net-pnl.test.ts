import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { NET_MARK_STALE_MS, realizablePnl } from "../src/agents/execution-math.js";
import { MARK_SERIES_CAP, PaperBook } from "../src/desk/book.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { loadConfig } from "../src/config.js";
import { loadDeskKeypair } from "../src/market/wallet-key.js";
import { deskPort } from "../scripts/ensure-tunnel";
import { testConfig } from "./helpers.js";

const now = 1_700_000_000_000;

describe("after-slippage net", () => {
  it("is the paper-sell proceeds minus cost, and never above the raw mark P&L", () => {
    const net = realizablePnl({ markPrice: 1.2, qty: 10, costUsd: 10, liquidityUsd: 50_000, markAt: now, now });
    expect(net).not.toBeNull();
    expect(net!.netPnlUsd).toBeLessThan(1.2 * 10 - 10);
    expect(net!.netPnlUsd).toBeGreaterThan(0);
    expect(net!.exitSlippage).toBeGreaterThan(0);
    expect(net!.exitSlippage).toBeLessThan(1);
  });

  it("stays blank when the mark is stale, missing, or in the future", () => {
    expect(realizablePnl({ markPrice: 2, qty: 1, costUsd: 1, liquidityUsd: 10_000, markAt: now - NET_MARK_STALE_MS, now })).toBeNull();
    expect(realizablePnl({ markPrice: 0, qty: 1, costUsd: 1, liquidityUsd: 10_000, markAt: now, now })).toBeNull();
    expect(realizablePnl({ markPrice: 2, qty: 1, costUsd: 1, liquidityUsd: Number.NaN, markAt: now, now })).toBeNull();
    expect(realizablePnl({ markPrice: 2, qty: 1, costUsd: 1, liquidityUsd: 10_000, markAt: now + 60_000, now })).toBeNull();
  });

  it("books a missing pool as a loss, not a profit", () => {
    const net = realizablePnl({ markPrice: 5, qty: 2, costUsd: 4, liquidityUsd: 0, markAt: now, now });
    expect(net).not.toBeNull();
    expect(net!.netPnlUsd).toBeLessThan(0);
    expect(net!.proceedsUsd).toBe(0);
  });
});

describe("held-coin sparkline", () => {
  it("keeps 64 points, ignores a mint that is not held, and refreshes an identical print", () => {
    const book = new PaperBook(100);
    book.noteMark("gone", 1, now);
    expect(book.points("gone")).toEqual([]);
    book.positions.set("held", {
      mint: "held",
      symbol: "H",
      name: "Held",
      qty: 1,
      entryPrice: 1,
      costUsd: 1,
      openedAt: now,
      peakPrice: 1,
      trailArmed: false,
      score: 1,
      source: "pumpfun",
      liquidityUsd: 1_000,
      tradeId: "t"
    });
    book.noteMark("held", 1, now);
    book.noteMark("held", 1, now + 500);
    expect(book.points("held")).toEqual([{ t: now + 500, priceUsd: 1 }]);
    for (let i = 0; i < 80; i += 1) book.noteMark("held", 1 + i, now + 10_000 + i * 3_000);
    expect(book.points("held")).toHaveLength(MARK_SERIES_CAP);
    book.dropSeries("held");
    expect(book.points("held")).toEqual([]);
  });
});

describe("desk card fields", () => {
  it("puts net and a sparkline point on an open paper position", async () => {
    const desk = new Desk(testConfig());
    const mint = "NetMint111111111111111111111111111111111";
    await desk.submitCandidate(makeToken({ mint, symbol: "NET", priceUsd: 1, liquidityUsd: 80_000, volume1hUsd: 100 }));
    const bought = await desk.manualBuy(mint, 20);
    expect(bought.ok).toBe(true);
    const card = desk.snapshot().positions.find((p) => p.mint === mint);
    expect(card?.netPnlUsd).toEqual(expect.any(Number));
    expect(card!.netPnlUsd!).toBeLessThanOrEqual(card!.pnlUsd + 0.02);
    expect(card?.marks?.length).toBeGreaterThanOrEqual(1);
    expect(desk.snapshot().readiness.liveScope).toBeNull();
  });
});

describe("wallet key either env", () => {
  it("arms from WALLET_PRIVATE_KEY or WALLET_KEYPAIR_PATH, and the env key wins", () => {
    const envKey = Keypair.generate();
    const fileKey = Keypair.generate();
    const dir = mkdtempSync(path.join(tmpdir(), "nd-key-"));
    const file = path.join(dir, "id.json");
    writeFileSync(file, JSON.stringify(Array.from(fileKey.secretKey)));
    const fromFile = loadDeskKeypair({ keypairPath: file });
    expect(fromFile?.source).toBe("file");
    expect(fromFile?.keypair.publicKey.toBase58()).toBe(fileKey.publicKey.toBase58());
    const envWins = loadDeskKeypair({
      keypairPath: file,
      readEnvSecret: () => JSON.stringify(Array.from(envKey.secretKey))
    });
    expect(envWins?.source).toBe("env");
    expect(envWins?.keypair.publicKey.toBase58()).toBe(envKey.publicKey.toBase58());
    const badEnv = loadDeskKeypair({ keypairPath: file, readEnvSecret: () => "not-a-key" });
    expect(badEnv?.source).toBe("file");
    const secret = JSON.stringify(Array.from(envKey.secretKey));
    const armed = loadConfig({ LIVE_TRADING: "true", WALLET_PRIVATE_KEY: secret, SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" });
    expect(armed.mode).toBe("live");
    const fromPath = loadConfig({ LIVE_TRADING: "true", WALLET_KEYPAIR_PATH: file, SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" });
    expect(fromPath.mode).toBe("live");
    expect(fromPath.walletKeypairPath).toBe(file);
  });

  it("reads the desk port from PORT in .env before falling back to 4721", () => {
    expect(deskPort({}, "PORT=4788\n")).toBe(4788);
    expect(deskPort({ DESK_PORT: "4700" }, "PORT=4788\n")).toBe(4700);
    expect(deskPort({ PORT: "4790" }, "")).toBe(4790);
    expect(deskPort({}, "no port here\n")).toBe(4721);
  });
});
