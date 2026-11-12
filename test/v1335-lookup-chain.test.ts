import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assessPosition } from "../src/agents/risk.js";
import { quotePaperBuy } from "../src/agents/execution-math.js";
import { evaluateFilter } from "../src/agents/filter.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { enrichSighting } from "../src/market/enrich.js";
import { parseRugcheckReport } from "../src/market/parsers.js";
import { resolveRules } from "../src/rules.js";
import { startServer } from "../src/server/http.js";
import type { AddressInfo } from "node:net";
import { testConfig } from "./helpers.js";

const MINT = "5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump";
const PAIR = "PumpSwapPool111111111111111111111111111111";
const rules = resolveRules({});

function dexBody() {
  return {
    pairs: [
      {
        chainId: "solana",
        dexId: "pumpswap",
        pairAddress: PAIR,
        priceUsd: "0.007",
        marketCap: 700_000,
        pairCreatedAt: Date.now() - 3_600_000,
        baseToken: { address: MINT, symbol: "MAX", name: "Max" },
        liquidity: { usd: 80_000 },
        volume: { h1: 90_000 }
      }
    ]
  };
}

describe("v13.35 lookup chain", () => {
  it("keeps a fast mint revocation when RugCheck hangs", async () => {
    const started = performance.now();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("dexscreener")) return Response.json(dexBody());
      if (url.includes("/report")) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 3_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return Response.json({ markets: [{ lp: { lpLockedPct: 0 } }] });
      }
      const method = (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method;
      if (method === "getAccountInfo") {
        return Response.json({
          result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, supply: "1000000000", decimals: 6 } } } } }
        });
      }
      return Response.json({ result: { value: [] } });
    };
    const token = await enrichSighting(
      { mint: MINT, source: "pumpfun", observedAt: 1 },
      { rpcUrl: "http://rpc.test", rugcheckUrl: "http://rug.test", fetchImpl, budgetMs: 250, holderPagesMax: 0 }
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(token.mintAuthorityRevoked).toBe(true);
    expect(token.freezeAuthorityRevoked).toBe(true);
  });

  it("reuses a fresh sighting when the chain read times out", async () => {
    const previous = process.env.NIGHT_DESK_LOOKUP_CHAIN_MS;
    process.env.NIGHT_DESK_LOOKUP_CHAIN_MS = "80";
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("dexscreener")) return Response.json(dexBody());
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      return Response.json({ result: { value: [] } });
    }) as typeof fetch;
    const desk = new Desk(testConfig({ rpcUrl: "http://rpc.test", rugcheckUrl: "http://rug.test" }), { lookupFetch: fetchImpl });
    try {
      desk.updateSettings({ minHolderCount: 15, maxDevHoldingPct: 10, autoBuy: false });
      await desk.submitCandidate(
        makeToken({
          mint: MINT,
          symbol: "MAX",
          name: "Max",
          priceUsd: 0.007,
          liquidityUsd: 80_000,
          volume1hUsd: 90_000,
          mintAuthorityRevoked: true,
          freezeAuthorityRevoked: true,
          lpLockedOrBurned: true,
          lpLockPct: 100,
          top10HolderPct: 0.169,
          holderCount: 28_000,
          devHoldingPct: 0.006,
          devHoldingUpperBound: true
        })
      );
      const found = await desk.lookupCoin(MINT);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.checks.find((check) => check.code === "MINT_AUTHORITY_ACTIVE")?.pass).toBe(true);
      expect(found.checks.find((check) => check.code === "LP_NOT_LOCKED")?.pass).toBe(true);
      expect(found.checks.find((check) => check.code === "HOLDER_CONCENTRATION")?.pass).toBe(true);
      expect(found.checks.find((check) => check.code === "HOLDER_COUNT")?.pass).toBe(true);
      expect(found.checks.find((check) => check.code === "DEV_HOLDING")?.pass).toBe(true);
      expect(found.providerNote).toMatch(/Reused a scout or lookup/);
      const log = readFileSync(desk.config.logPath, "utf8");
      expect(log).toMatch(/chainTimedOut=true/);
      expect(log).toMatch(/providers=.*sighting/);
      expect(log).toMatch(/MINT_AUTHORITY_ACTIVE:pass/);
      const buy = await desk.manualBuy(MINT, 5);
      expect(buy.ok).toBe(true);
      const events = desk.snapshot().events.filter((event) => event.code === "MANUAL_BUY");
      expect(events.length).toBeGreaterThan(1);
      expect(events.every((event) => event.message.includes("chainTimedOut="))).toBe(true);
    } finally {
      if (previous == null) delete process.env.NIGHT_DESK_LOOKUP_CHAIN_MS;
      else process.env.NIGHT_DESK_LOOKUP_CHAIN_MS = previous;
      desk.stop();
    }
  });

  it("does not fail LP on a locked primary pool because a DLMM pool has no LP token", () => {
    const report = parseRugcheckReport({
      markets: [
        {
          marketType: "pump_amm",
          pubkey: "PrimaryPumpSwap111111111111111111111111111",
          liquidityUsd: 80_000,
          lp: { lpLockedPct: 100 }
        },
        {
          marketType: "meteora_dlmm",
          pubkey: "SmallDlmm11111111111111111111111111111111",
          liquidityUsd: 1_200,
          lp: { lpLockedPct: 0 }
        },
        { marketType: "whirlpool", pubkey: "OrcaWhirl11111111111111111111111111111111", liquidityUsd: 400 }
      ]
    });
    expect(report.lpLockedOrBurned).toBe(true);
    expect(report.lpLockPct).toBe(100);
    expect(report.lpPool).toMatch(/pump_amm/);
    expect(report.lpPool).toMatch(/Prim/);
    const filtered = evaluateFilter(
      makeToken({ lpLockedOrBurned: report.lpLockedOrBurned, lpLockPct: report.lpLockPct, lpLockPool: report.lpPool }),
      { status: "clean" },
      rules
    );
    const lp = filtered.checks.find((check) => check.code === "LP_NOT_LOCKED");
    expect(lp?.pass).toBe(true);
    expect(lp?.message).toMatch(/pump_amm/);
  });

  it("does not stop a paper buy just because the fill paid entry slippage", async () => {
    const mark = 0.007;
    const liquidityUsd = 8_000;
    const quote = quotePaperBuy(mark, 100, liquidityUsd, 0.03);
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    const gap = (mark - quote.fillPrice) / quote.fillPrice;
    expect(gap).toBeLessThan(-0.02);
    const basis = assessPosition(
      { entryPrice: quote.fillPrice, entryMark: mark, peakPrice: quote.fillPrice, trailArmed: false },
      mark,
      { ...rules, stopLossPct: 0.02 }
    );
    expect(basis.action).toBe("hold");

    const desk = new Desk(testConfig());
    try {
      desk.updateSettings({ stopLossPct: 2 });
      await desk.submitCandidate(
        makeToken({
          mint: MINT,
          symbol: "MAX",
          priceUsd: mark,
          liquidityUsd,
          volume1hUsd: 90_000,
          priceFeed: "dexscreener",
          pairAddress: PAIR,
          source: "raydium",
          dex: "pumpswap"
        })
      );
      const bought = await desk.manualBuy(MINT, 100);
      expect(bought.ok).toBe(true);
      const pos = desk.book.positions.get(MINT);
      expect(pos?.entryMark).toBeCloseTo(mark, 8);
      expect(pos && pos.entryPrice > pos.entryMark!).toBe(true);
      desk.bus.emit("market.tick", {
        mint: MINT,
        priceUsd: mark,
        liquidityUsd,
        at: Date.now(),
        feed: "dexscreener",
        pairAddress: PAIR,
        dex: "pumpswap"
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(desk.book.positions.has(MINT)).toBe(true);
      desk.bus.emit("market.tick", {
        mint: MINT,
        priceUsd: mark * (1 - 0.025),
        liquidityUsd: 1_000_000,
        at: Date.now(),
        feed: "dexscreener",
        pairAddress: PAIR,
        dex: "pumpswap"
      });
      await vi.waitFor(() => expect(desk.book.positions.has(MINT)).toBe(false));
      expect(desk.snapshot().closed.some((trade) => trade.mint === MINT && trade.exitCode === "STOP_LOSS")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("counts could-not-be-verified kills on the snapshot and on /api/health", async () => {
    const desk = new Desk(testConfig({ rugcheckUrl: "http://127.0.0.1:1" }));
    const server = startServer(desk, "127.0.0.1", 0);
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    try {
      await desk.submitCandidate(
        makeToken({
          mint: "UnverifiedMint11111111111111111111111111",
          symbol: "MAX",
          mintAuthorityRevoked: null,
          lpLockedOrBurned: null,
          top10HolderPct: null
        })
      );
      expect(desk.snapshot().pipeline.unverifiedKills?.MINT_AUTHORITY_ACTIVE).toBe(1);
      expect(desk.snapshot().pipeline.unverifiedKills?.LP_NOT_LOCKED).toBe(1);
      expect(desk.snapshot().pipeline.unverifiedKills?.HOLDER_CONCENTRATION).toBe(1);
      expect(desk.unverifiedKillCounts().MINT_AUTHORITY_ACTIVE).toBe(1);
      const port = (server.address() as AddressInfo).port;
      const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
        unverifiedKills?: Record<string, number>;
      };
      expect(health.unverifiedKills?.MINT_AUTHORITY_ACTIVE).toBe(1);
    } finally {
      server.close();
      desk.stop();
    }
  });
});
