import { describe, expect, it, vi } from "vitest";
import {
  ageScore,
  decideScore,
  holderScore,
  liquidityScore,
  roundScore,
  SCORE_WEIGHTS,
  scoreToken,
  socialScore,
  volumeScore
} from "../src/agents/analyst.js";
import { evaluateFilter } from "../src/agents/filter.js";
import { ceilUsd, floorUsd, quotePaperBuy, quotePaperSell, slippageFor } from "../src/agents/execution-math.js";
import { makeToken } from "../src/demo/tokens.js";
import { buildRecap, formatRecap } from "../src/desk/recap.js";
import { fetchDexPrices } from "../src/market/dex-prices.js";
import { enrichSighting } from "../src/market/enrich.js";
import { parseRugcheckReport } from "../src/market/parsers.js";
import { HELD_MARK_POLL_MS, PositionPricer } from "../src/market/position-pricer.js";
import { resolveRules } from "../src/rules.js";
import type { ClosedTrade } from "../src/types.js";
import { testDesk } from "./helpers.js";

const rules = resolveRules({});
const MINT = "So11111111111111111111111111111111111111112";

describe("filter inputs can no longer loosen a hard line", () => {
  it("judges LP by the weakest market, not the best", () => {
    const report = parseRugcheckReport({ markets: [{ lp: { lpLockedPct: 100 } }, { lp: { lpLockedPct: 0 } }] });
    expect(report.lpLockPct).toBe(0);
    expect(report.lpLockedOrBurned).toBe(false);
    expect(parseRugcheckReport({ markets: [{ lpLockedPct: 100 }, { lpLockedPct: 97 }] }).lpLockedOrBurned).toBe(true);
  });

  it("will not let visible markets vouch for one that reports nothing", () => {
    const hidden = parseRugcheckReport({ markets: [{ lp: { lpLockedPct: 100 } }, {}] });
    expect(hidden.lpLockPct).toBeNull();
    expect(hidden.lpLockedOrBurned).toBeNull();
    // Evidence that a pool IS unlocked still counts, even beside a silent market.
    const unlocked = parseRugcheckReport({ markets: [{ lp: { lpLockedPct: 0 } }, {}] });
    expect(unlocked.lpLockedOrBurned).toBe(false);
    // A silent report fails closed once a pool exists.
    expect(evaluateFilter(makeToken({ lpLockedOrBurned: null }), { status: "clean" }, rules).reasons.map((r) => r.code)).toContain(
      "LP_NOT_LOCKED"
    );
  });

  it("reads LP as a percent, so 1 and 0.96 are not mistaken for full locks", () => {
    expect(parseRugcheckReport({ markets: [{ lpLockedPct: 1 }] }).lpLockedOrBurned).toBe(false);
    expect(parseRugcheckReport({ markets: [{ lpLockedPct: 0.96 }] }).lpLockedOrBurned).toBe(false);
    expect(parseRugcheckReport({ markets: [{ lpLockedPct: 95 }] }).lpLockedOrBurned).toBe(true);
  });

  it("does not infer a revoked mint authority from a report that never mentions it", () => {
    const silent = parseRugcheckReport({ risks: [{ name: "Low liquidity", level: "warn" }] });
    expect(silent.mintAuthorityRevoked).toBeNull();
    const explicit = parseRugcheckReport({ risks: [{ name: "Mint Authority still enabled", level: "danger" }] });
    expect(explicit.mintAuthorityRevoked).toBe(false);
    const result = evaluateFilter(makeToken({ mintAuthorityRevoked: silent.mintAuthorityRevoked }), { status: "clean" }, rules);
    expect(result.reasons.map((r) => r.code)).toContain("MINT_AUTHORITY_ACTIVE");
  });

  it("rejects a NaN concentration instead of passing it", () => {
    const result = evaluateFilter(makeToken({ top10HolderPct: Number.NaN }), { status: "clean" }, rules);
    expect(result.decision).toBe("reject");
    expect(result.reasons[0]?.code).toBe("HOLDER_CONCENTRATION");
  });

  describe("holder concentration from two sources", () => {
    const rpcResults: Record<string, unknown> = {
      getAccountInfo: { value: { data: { parsed: { info: { mintAuthority: null, supply: "1000000000000", decimals: 6 } } } } },
      // Ten wallets at 4% each is 40% of a 1,000,000 supply, over the 35% cap.
      getTokenLargestAccounts: {
        value: Array.from({ length: 10 }, (_, i) => ({ address: `Acc${i}`, uiAmount: 40_000 }))
      },
      getMultipleAccounts: {
        value: Array.from({ length: 10 }, (_, i) => ({ data: { parsed: { info: { owner: `Wallet${i}` } } } }))
      }
    };
    // RugCheck lists two identifiable holders summing to 18%.
    const rugReport = { topHolders: [{ address: "HolderOne", pct: 6 }, { address: "HolderTwo", pct: 12 }], risks: [] };

    function routed(rpc: boolean) {
      return (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("rugcheck")) return Response.json(rugReport);
        if (url.startsWith("http://rpc.test") && rpc) {
          const { method } = JSON.parse(String(init?.body)) as { method: string };
          return Response.json({ result: rpcResults[method] ?? null });
        }
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;
    }

    it("keeps the higher figure when RugCheck reports less than the chain shows", async () => {
      const token = await enrichSighting(
        { mint: MINT, source: "pumpfun", observedAt: 0 },
        { rpcUrl: "http://rpc.test", rugcheckUrl: "http://rugcheck.test", fetchImpl: routed(true) }
      );
      expect(token.top10HolderPct).toBeCloseTo(0.4, 8);
      expect(evaluateFilter(token, { status: "clean" }, rules).reasons.map((r) => r.code)).toContain("HOLDER_CONCENTRATION");
    });

    it("falls back to RugCheck when the chain read is missing", async () => {
      const token = await enrichSighting(
        { mint: MINT, source: "pumpfun", observedAt: 0 },
        { rpcUrl: "http://rpc.test", rugcheckUrl: "http://rugcheck.test", fetchImpl: routed(false) }
      );
      expect(token.top10HolderPct).toBeCloseTo(0.18, 8);
    });
  });
});

describe("paper fill model is constant-product", () => {
  // Reserve on one side is half the reported liquidity: a $10k pool has R = $5,000.
  it("charges x/R on a buy, hand-derived", () => {
    expect(slippageFor(800, 10_000, "buy")).toBeCloseTo(0.0015 + 800 / 5_000, 10); // 0.1615
    expect(slippageFor(800, 100_000, "buy")).toBeCloseTo(0.0015 + 800 / 50_000, 10); // 0.0175
  });

  it("charges y/(R+y) on a sell, which is less than the same buy", () => {
    // share 0.16 -> 0.16 / 1.16 = 0.137931...
    expect(slippageFor(800, 10_000, "sell")).toBeCloseTo(0.0015 + 0.16 / 1.16, 10);
    expect(slippageFor(800, 10_000, "sell")).toBeLessThan(slippageFor(800, 10_000, "buy"));
  });

  it("reports true buy impact and refuses a fill past the entry cap, including unknown liquidity", () => {
    expect(slippageFor(800, 10_000, "buy")).toBeGreaterThan(0.03);
    expect(slippageFor(5_000, 1_000, "buy")).toBeGreaterThan(0.5);
    expect(slippageFor(800, 0, "buy")).toBe(Number.POSITIVE_INFINITY);
    expect(slippageFor(800, Number.NaN, "buy")).toBe(Number.POSITIVE_INFINITY);
    const refused = quotePaperBuy(0.00000292, 7.84, 0);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("Buy refused.");
  });

  it("fills a $800 buy in a $100k pool at 1.0175x with a $0.80 fee", () => {
    const quote = quotePaperBuy(1, 800, 100_000);
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    expect(quote.fillPrice).toBeCloseTo(1.0175, 10);
    expect(quote.feeUsd).toBe(0.8);
    // (800 - 0.80) / 1.0175
    expect(quote.qty).toBeCloseTo(785.4545, 3);
  });

  it("rounds fees up and proceeds down", () => {
    expect(ceilUsd(0.7711)).toBe(0.78);
    expect(ceilUsd(0.8)).toBe(0.8);
    expect(floorUsd(79.999)).toBe(79.99);
    const sell = quotePaperSell(1, 785.4545, 100_000);
    expect(sell.feeUsd).toBe(ceilUsd(sell.notionalUsd * 0.001));
    expect(sell.proceedsUsd!).toBeLessThanOrEqual(sell.notionalUsd - sell.feeUsd + 1e-9);
  });

  it("refuses the old 16% paper buy instead of filling it", () => {
    const buy = quotePaperBuy(1, 800, 10_000);
    expect(buy.ok).toBe(false);
    if (!buy.ok) expect(buy.slippage).toBeCloseTo(0.1615, 4);
  });

  it("makes a flat round trip in a deep pool lose the spread", () => {
    const buy = quotePaperBuy(1, 800, 100_000);
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    const sell = quotePaperSell(1, buy.qty, 100_000);
    expect(sell.proceedsUsd).toBeLessThan(800);
    expect(sell.slippage).toBeLessThan(0.03);
  });

  it("refuses a thin-pool buy instead of filling through the stop", async () => {
    const desk = testDesk();
    try {
      const mint = "ThinPool1111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ symbol: "THIN", mint, liquidityUsd: 20_000, priceUsd: 0.001 }));
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "EXIT_IMPACT" && event.message.includes("Buy refused"))).toBe(true);
      expect(desk.snapshot().closed).toHaveLength(0);
    } finally {
      desk.stop();
    }
  });
});

describe("analyst and recap details", () => {
  it("gives no breadth bonus to a token already outside the concentration gate", () => {
    expect(holderScore(0.5, 1_200).raw).toBe(0);
    expect(holderScore(0.19, 1_200).raw).toBeCloseTo(0.5, 10); // 0.42 + 0.08
  });

  it("still scores and decides a normal survivor", () => {
    expect(scoreToken(makeToken(), rules).decision).toBe("trade");
  });

  it("decides on the exact score, so a rounded-up score does not trade at the line", () => {
    const exactOf = (t: ReturnType<typeof makeToken>) =>
      SCORE_WEIGHTS.liquidity * liquidityScore(t.liquidityUsd).raw +
      SCORE_WEIGHTS.holders * holderScore(t.top10HolderPct, t.holderCount).raw +
      SCORE_WEIGHTS.volume * volumeScore(t.volume1hUsd, t.liquidityUsd).raw +
      SCORE_WEIGHTS.age * ageScore(t.ageSeconds).raw +
      SCORE_WEIGHTS.social * socialScore(t.social).raw;
    // Find a token whose 4-decimal rounding lands ABOVE its exact sum.
    let found: { token: ReturnType<typeof makeToken>; exact: number } | null = null;
    for (let m = 0; m <= 80 && !found; m += 1) {
      const token = makeToken({ social: { mentions1h: m, hasWebsite: true, hasTelegram: false, hasTwitter: false } });
      const exact = exactOf(token);
      if (roundScore(exact) - exact > 1e-7) found = { token, exact };
    }
    expect(found).not.toBeNull();
    const line = { ...rules, analystMinScore: roundScore(found!.exact) };
    // Rounded >= line would have traded; the exact sum is below it.
    expect(roundScore(found!.exact) >= line.analystMinScore).toBe(true);
    const report = scoreToken(found!.token, line);
    expect(report.decision).toBe("reject");
    expect(report.reason?.message).toMatch(/0\.\d{4} is below/);
  });

  it("tolerates float error at the line without trading a real shortfall", () => {
    expect(decideScore(0.5999999999, 0.6)).toBe("trade");
    expect(decideScore(0.5999, 0.6)).toBe("reject");
  });

  it("counts breakeven apart from losses and reports a win rate", () => {
    const t = (id: string, pnlUsd: number): ClosedTrade => ({
      id, mint: id, symbol: id, openedAt: 0, closedAt: 1, costUsd: 100, proceedsUsd: 100 + pnlUsd,
      pnlUsd, pnlPct: pnlUsd / 100, exitCode: "STOP_LOSS", score: 0.7, mode: "paper"
    });
    const recap = buildRecap({
      since: 0, until: 1, events: [], equity: [], open: [], startingBalanceUsd: 10_000,
      closed: [t("W", 5), t("Z", 0), t("L", -5), t("L2", -3)]
    });
    expect(recap.wins).toHaveLength(1);
    expect(recap.breakeven).toHaveLength(1);
    expect(recap.losses).toHaveLength(2);
    expect(recap.winRate).toBe(0.25);
    expect(formatRecap(recap)).toContain("Win rate: 25%");
    expect(buildRecap({ since: 0, until: 1, events: [], equity: [], open: [], closed: [], startingBalanceUsd: 1 }).winRate).toBeNull();
  });
});

describe("open positions get priced on the live feed", () => {
  const pair = (mint: string, priceUsd: string, liq = 100_000) => ({ baseToken: { address: mint }, priceUsd, liquidity: { usd: liq } });

  it("takes the deepest pool's price and leaves unlisted mints out", async () => {
    const fetchImpl = (async () =>
      Response.json([pair("A", "1.5", 1_000), pair("A", "2", 90_000), pair("B", "0")])) as unknown as typeof fetch;
    const prices = await fetchDexPrices(["A", "B", "C"], fetchImpl);
    expect(prices.get("A")).toBe(2);
    expect(prices.has("B")).toBe(false);
    expect(prices.has("C")).toBe(false);
  });

  it("emits a tick for every priced held mint", async () => {
    const ticks: Array<[string, number]> = [];
    const fetchImpl = (async () => Response.json([pair("A", "0.5")])) as unknown as typeof fetch;
    const pricer = new PositionPricer({
      heldMints: () => ["A"], tick: (m, p) => ticks.push([m, p]), onStale: () => {}, fetchImpl
    });
    await pricer.poll();
    expect(ticks).toEqual([["A", 0.5]]);
  });

  it("reports a silent mint once, never invents a price, and says when it returns", async () => {
    let now = 0;
    let listed = false;
    const events: string[] = [];
    const ticks: number[] = [];
    const fetchImpl = (async () => Response.json(listed ? [pair("A", "3")] : [])) as unknown as typeof fetch;
    const pricer = new PositionPricer({
      heldMints: () => ["A"], now: () => now, staleMs: 5 * 60_000, fetchImpl,
      tick: (_m, p) => ticks.push(p),
      onStale: (m, ms) => events.push(`stale ${m} ${Math.round(ms / 60_000)}m`),
      onRecovered: (m) => events.push(`recovered ${m}`)
    });
    await pricer.poll(); // first sight starts the clock
    now = 4 * 60_000;
    await pricer.poll();
    expect(events).toEqual([]);
    now = 6 * 60_000;
    await pricer.poll();
    await pricer.poll();
    expect(events).toEqual(["stale A 6m"]);
    expect(ticks).toEqual([]);
    listed = true;
    await pricer.poll();
    expect(events).toEqual(["stale A 6m", "recovered A"]);
    expect(ticks).toEqual([3]);
  });

  it("does not call a mint stale while another source is still ticking it", async () => {
    let now = 0;
    const events: string[] = [];
    const pricer = new PositionPricer({
      heldMints: () => ["A"], now: () => now, staleMs: 5 * 60_000,
      fetchImpl: (async () => Response.json([])) as unknown as typeof fetch,
      tick: () => {}, onStale: (m) => events.push(m)
    });
    await pricer.poll();
    for (now = 60_000; now <= 10 * 60_000; now += 60_000) {
      pricer.noteTick("A", now);
      await pricer.poll();
    }
    expect(events).toEqual([]);
  });

  it("survives a failed request without ticking", async () => {
    const errors: string[] = [];
    const ticks: number[] = [];
    const pricer = new PositionPricer({
      heldMints: () => ["A"], tick: (_m, p) => ticks.push(p), onStale: () => {}, onError: (m) => errors.push(m),
      fetchImpl: (async () => new Response("", { status: 429 })) as unknown as typeof fetch
    });
    await pricer.poll();
    expect(errors[0]).toContain("dexscreener HTTP 429");
    expect(errors[0]).toContain("jupiter HTTP 429");
    expect(ticks).toEqual([]);
  });

  it("never sends replay-tape fixtures to DexScreener", async () => {
    let calls = 0;
    const desk = testDesk({}, { priceFetch: (async () => { calls += 1; return Response.json([]); }) as unknown as typeof fetch });
    try {
      await desk.submitCandidate(makeToken({ symbol: "FIXTURE", mint: "Fixture11111111111111111111111111111111111", source: "replay" }));
      expect(desk.book.positions.size).toBe(1);
      await desk.repricePositions();
      expect(calls).toBe(0);
    } finally {
      desk.stop();
    }
  });

  it("clears its own error banner once polling works again, and only its own", async () => {
    let ok = false;
    const desk = testDesk({}, {
      priceFetch: (async () => (ok ? Response.json([]) : new Response("", { status: 503 }))) as unknown as typeof fetch
    });
    try {
      await desk.submitCandidate(makeToken({ symbol: "ERR", mint: "ErrBanner1111111111111111111111111111111111", source: "raydium" }));
      await desk.repricePositions();
      // v12.1: one failed poll is not a banner; two minutes of failures is.
      expect(desk.snapshot().feed.lastError).toBeUndefined();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 121_000);
      await desk.repricePositions();
      expect(desk.snapshot().feed.lastError).toContain("dexscreener HTTP 503");
      ok = true;
      await desk.repricePositions();
      expect(desk.snapshot().feed.lastError).toBeUndefined();
    } finally {
      vi.useRealTimers();
      desk.stop();
    }
  });

  it("lets a stop fire from polled prices, which is what the live feed was missing", async () => {
    const mint = "PolledStop111111111111111111111111111111111";
    const desk = testDesk(
      {},
      { priceFetch: (async () => Response.json([pair(mint, "0.0009", 180_000)])) as unknown as typeof fetch }
    );
    try {
      await desk.submitCandidate(makeToken({ symbol: "POLLED", mint, priceUsd: 0.001, source: "raydium" }));
      // fill = 0.001 * (1 + 0.0015 + 800/90000) = 0.0010104; stop = 0.0010104 * 0.94 = 0.00094978
      expect(desk.book.positions.has(mint)).toBe(true);
      await desk.repricePositions();
      expect(desk.snapshot().closed.at(-1)).toMatchObject({ symbol: "POLLED", exitCode: "STOP_LOSS" });
      expect(desk.book.positions.has(mint)).toBe(false);
    } finally {
      desk.stop();
    }
  });
});
