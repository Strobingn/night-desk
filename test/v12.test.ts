import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maxSizeForPool, planOrder, splitPosition, quotePaperBuy, exitImpactAllowed } from "../src/agents/execution-math.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk, jupiterLookupQuote } from "../src/desk/orchestrator.js";
import { parseCoinInput, positionTag } from "../src/market/coin-input.js";
import { baseMintFromPairs, resolveCoinMint } from "../src/market/coin-lookup.js";
import { HARD_RULES, SIZING_BAND, clampExposurePct, clampPositionPct, clampResetUsd, resolveRules } from "../src/rules.js";
import { ALLOWED_SETTINGS, parseSellFraction } from "../src/server/http.js";
import { SAVED_KEYS, SETTINGS_FIELDS, changedPatch, draftFrom } from "../web/src/settingsSchema.js";
import { testConfig, testDesk } from "./helpers.js";

const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const PAIR = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SOL = "So11111111111111111111111111111111111111112";

describe("v12 add coin: link parsing", () => {
  it("accepts a bare mint and refuses SOL", () => {
    expect(parseCoinInput(MINT)).toEqual({ ok: true, platform: "Mint", address: MINT, kind: "mint" });
    expect(parseCoinInput(`  ${MINT}\n`)).toMatchObject({ ok: true, address: MINT });
    expect(parseCoinInput(SOL).ok).toBe(false);
    expect(parseCoinInput("").ok).toBe(false);
    expect(parseCoinInput("hello").ok).toBe(false);
  });

  it.each([
    [`https://dexscreener.com/solana/${PAIR}`, "DexScreener", PAIR, "either"],
    [`https://dexscreener.com/solana/${PAIR}?maker=abc`, "DexScreener", PAIR, "either"],
    [`https://pump.fun/coin/${MINT}`, "pump.fun", MINT, "mint"],
    [`https://pump.fun/${MINT}`, "pump.fun", MINT, "mint"],
    [`https://birdeye.so/token/${MINT}?chain=solana`, "Birdeye", MINT, "mint"],
    [`https://birdeye.so/solana/token/${MINT}`, "Birdeye", MINT, "mint"],
    [`https://gmgn.ai/sol/token/${MINT}`, "GMGN", MINT, "mint"],
    [`https://gmgn.ai/sol/token/abcRef_${MINT}`, "GMGN", MINT, "mint"],
    [`https://jup.ag/swap/SOL-${MINT}`, "Jupiter", MINT, "mint"],
    [`https://jup.ag/swap?sell=${SOL}&buy=${MINT}`, "Jupiter", MINT, "mint"],
    [`https://jup.ag/tokens/${MINT}`, "Jupiter", MINT, "mint"],
    [`https://raydium.io/swap/?inputMint=sol&outputMint=${MINT}`, "Raydium", MINT, "mint"],
    [`https://photon-sol.tinyastro.io/en/lp/${PAIR}?handle=x`, "Photon", PAIR, "pair"],
    [`https://neo.bullx.io/terminal?chainId=1399811149&address=${MINT}`, "BullX", MINT, "mint"],
    [`https://solscan.io/token/${MINT}`, "Solscan", MINT, "mint"],
    [`solscan.io/token/${MINT}`, "Solscan", MINT, "mint"],
    [`https://solscan.io/account/${PAIR}`, "Solscan", PAIR, "either"]
  ])("parses %s", (input, platform, address, kind) => {
    expect(parseCoinInput(input)).toEqual({ ok: true, platform, address, kind });
  });

  it("refuses other chains, unknown sites and links with no address", () => {
    expect(parseCoinInput(`https://dexscreener.com/ethereum/0xabc`)).toMatchObject({ ok: false });
    expect(parseCoinInput(`https://gmgn.ai/eth/token/0xabc`)).toMatchObject({ ok: false });
    expect(parseCoinInput(`https://birdeye.so/token/${MINT}?chain=base`)).toMatchObject({ ok: false });
    expect(parseCoinInput(`https://evil.example/token/${MINT}`)).toMatchObject({ ok: false });
    expect(parseCoinInput(`https://pump.fun/board`)).toMatchObject({ ok: false });
    expect(parseCoinInput(`javascript:alert(1)`)).toMatchObject({ ok: false });
  });

  it("tags positions manual plus the platform", () => {
    expect(positionTag("pump.fun")).toBe("manual · pump.fun");
    expect(positionTag("Mint")).toBe("manual");
  });

  it("resolves a DexScreener pair to its base mint, and the other side when the base is SOL", async () => {
    const fetchImpl = (async () =>
      Response.json({ pairs: [{ chainId: "solana", pairAddress: PAIR, baseToken: { address: MINT }, quoteToken: { address: SOL } }] })) as unknown as typeof fetch;
    const parsed = parseCoinInput(`https://dexscreener.com/solana/${PAIR}`);
    if (!parsed.ok) throw new Error("parse");
    expect(await resolveCoinMint(parsed, fetchImpl)).toEqual({ ok: true, mint: MINT, pairAddress: PAIR });
    expect(baseMintFromPairs({ pair: { chainId: "solana", pairAddress: PAIR, baseToken: { address: SOL }, quoteToken: { address: BONK } } }, PAIR)).toBe(BONK);
    const none = (async () => Response.json({ pairs: null })) as unknown as typeof fetch;
    expect(await resolveCoinMint(parsed, none)).toEqual({ ok: true, mint: PAIR });
    const photon = parseCoinInput(`https://photon-sol.tinyastro.io/en/lp/${PAIR}`);
    if (!photon.ok) throw new Error("parse");
    expect(await resolveCoinMint(photon, none)).toMatchObject({ ok: false });
  });
});

/** Routes the DexScreener token read and RugCheck for one mint. */
function coinFetch(opts: { priceUsd?: string | null; liquidityUsd?: number; mintAuthority?: string | null; rugged?: boolean }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/latest/dex/tokens/")) {
      if (opts.priceUsd === null) return Response.json({ pairs: [] });
      return Response.json({
        pairs: [
          {
            chainId: "solana",
            dexId: "raydium",
            pairAddress: PAIR,
            priceUsd: opts.priceUsd ?? "0.002",
            liquidity: { usd: opts.liquidityUsd ?? 400_000 },
            volume: { h1: 90_000, h24: 900_000 },
            marketCap: 2_000_000,
            pairCreatedAt: Date.now() - 6 * 3_600_000,
            baseToken: { address: MINT, symbol: "ADDME", name: "Add Me" },
            quoteToken: { address: SOL }
          }
        ]
      });
    }
    if (url.includes("/tokens/v1/solana/")) {
      return Response.json([{ baseToken: { address: MINT }, priceUsd: "0.003", liquidity: { usd: 400_000 }, pairAddress: PAIR, dexId: "raydium" }]);
    }
    if (url.startsWith("http://rpc.test")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "getAccountInfo") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { value: { data: { parsed: { info: { mintAuthority: opts.mintAuthority ?? null, supply: "1000000000000000", decimals: 6 } } } } }
        });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: { value: [] } });
    }
    if (url.includes("rugcheck") || url.includes("/report")) {
      return Response.json({
        mint: MINT,
        mintAuthority: opts.mintAuthority === undefined ? null : opts.mintAuthority,
        freezeAuthority: null,
        topHolders: [{ address: "h1", pct: 2, owner: "o1" }],
        markets: [{ lp: { lpLockedPct: 100 } }],
        rugged: opts.rugged === true,
        creator: "CreatorWallet1111111111111111111111111111"
      });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

function lookupDesk(fetchImpl: typeof fetch, overrides = {}) {
  return new Desk(testConfig({ rpcUrl: "http://rpc.test", rugcheckUrl: "http://rugcheck.test/v1", ...overrides }), { lookupFetch: fetchImpl });
}

describe("v12 add coin: lookup and manual buy guards", () => {
  it("returns an error and allows no buy when there is no reliable price", async () => {
    const desk = lookupDesk(coinFetch({ priceUsd: null }));
    try {
      const found = await desk.lookupCoin(MINT);
      expect(found.ok).toBe(false);
      if (!found.ok) {
        expect(found.code).toBe("PRICE_UNAVAILABLE");
        expect(found.error).toMatch(/No reliable price/);
      }
      const buy = await desk.manualBuy(MINT, 10);
      expect(buy.ok).toBe(false);
      if (!buy.ok) expect(buy.code).toBe("PRICE_UNAVAILABLE");
      expect(desk.book.positions.size).toBe(0);
    } finally {
      desk.stop();
    }
  });

  it("refuses an unsupported link before any network call", async () => {
    let calls = 0;
    const desk = lookupDesk((async () => {
      calls += 1;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch);
    try {
      const found = await desk.lookupCoin("https://example.com/nothing");
      expect(found).toMatchObject({ ok: false, code: "LOOKUP_FAILED" });
      expect(calls).toBe(0);
    } finally {
      desk.stop();
    }
  });

  it("reports price, pool and the Filter/Analyst gates, then buys tagged with the platform", async () => {
    const desk = lookupDesk(coinFetch({ mintAuthority: null }));
    try {
      const found = await desk.lookupCoin(`https://pump.fun/coin/${MINT}`);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found).toMatchObject({ mint: MINT, symbol: "ADDME", platform: "pump.fun", priceUsd: 0.002, liquidityUsd: 400_000, volume1hUsd: 90_000 });
      expect(found.dexscreenerUrl).toContain(PAIR);
      expect(found.checks.find((c) => c.code === "MINT_AUTHORITY_ACTIVE")?.pass).toBe(true);
      expect(found.hardKills).toEqual([]);
      expect(found.analyst.line).toBe(desk.config.rules.analystMinScore);
      expect(found.canBuy).toBe(true);
      const buy = await desk.manualBuy(MINT, 50);
      expect(buy).toMatchObject({ ok: true, sizeUsd: 50 });
      const view = desk.snapshot().positions.find((p) => p.mint === MINT);
      expect(view?.tag).toBe("manual · pump.fun");
      expect(view?.entry).toBe("manual");
      // −6% stop still applies to a manual add.
      expect(view!.stopPrice).toBeCloseTo(view!.entryPrice * (1 - HARD_RULES.stopLossPct), 12);
    } finally {
      desk.stop();
    }
  });

  it("holds a hard kill (mint authority active) until Buy anyway is confirmed", async () => {
    const desk = lookupDesk(coinFetch({ mintAuthority: "SomeAuthority1111111111111111111111111111" }));
    try {
      const found = await desk.lookupCoin(MINT);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.hardKills.map((k) => k.code)).toContain("MINT_AUTHORITY_ACTIVE");
      const held = await desk.manualBuy(MINT, 20);
      expect(held).toMatchObject({ ok: false, code: "HARD_KILL" });
      expect(desk.book.positions.size).toBe(0);
      const anyway = await desk.manualBuy(MINT, 20, { confirmHardKill: true });
      expect(anyway).toMatchObject({ ok: true, sizeUsd: 20 });
    } finally {
      desk.stop();
    }
  });

  it("keeps the slippage, pool-depth and cash guards on a manual add", async () => {
    const thin = lookupDesk(coinFetch({ mintAuthority: null, liquidityUsd: 2_000 }));
    try {
      const found = await thin.lookupCoin(MINT);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.poolMaxUsd).toBeLessThan(40);
      const big = await thin.manualBuy(MINT, 500, { confirmSize: true });
      expect(big.ok).toBe(false);
      if (!big.ok) expect(["ENTRY_SLIPPAGE", "EXIT_IMPACT"]).toContain(big.code);
      // The pool max itself passes both guards.
      expect(quotePaperBuy(0.002, found.poolMaxUsd, 2_000, HARD_RULES.maxEntrySlippage).ok).toBe(true);
      expect(exitImpactAllowed(found.poolMaxUsd, 2_000, HARD_RULES.maxEntrySlippage).ok).toBe(true);
    } finally {
      thin.stop();
    }
    const desk = lookupDesk(coinFetch({ mintAuthority: null }), { startingBalanceUsd: 100 });
    try {
      await desk.lookupCoin(MINT);
      // Unconfirmed: cut to the 8% cap. Confirmed: may use the whole book, never more than cash.
      const capped = await desk.manualBuy(MINT, 90);
      expect(capped).toMatchObject({ ok: true, sizeUsd: 8, clampedFrom: 90 });
    } finally {
      desk.stop();
    }
    const whole = lookupDesk(coinFetch({ mintAuthority: null }), { startingBalanceUsd: 100 });
    try {
      await whole.lookupCoin(MINT);
      const all = await whole.manualBuy(MINT, 250, { confirmSize: true });
      expect(all).toMatchObject({ ok: true, sizeUsd: 100, clampedFrom: 250 });
      expect(whole.book.cashUsd).toBeGreaterThanOrEqual(0);
    } finally {
      whole.stop();
    }
  });

  it("refuses to loosen the −6% hard stop and accepts a tighter one", () => {
    const desk = testDesk();
    try {
      expect(desk.updateSettings({ stopLossPct: 0.1 }).ok).toBe(false);
      expect(desk.updateSettings({ stopLossPct: 10 }).ok).toBe(false);
      expect(desk.updateSettings({ stopLossPct: 1 })).toMatchObject({ ok: true, settings: { stopLossPct: 0.01 } });
      expect(desk.updateSettings({ stopLossPct: 0.05 })).toMatchObject({ ok: true, settings: { stopLossPct: 0.05 } });
    } finally {
      desk.stop();
    }
  });
});

describe("v12 partial sells", () => {
  it("splits qty and cost by the same fraction and keeps the entry price", () => {
    const half = splitPosition(1_000, 10, 0.5);
    expect(half).toEqual({ ok: true, fraction: 0.5, sellQty: 500, soldCostUsd: 5, remainQty: 500, remainCostUsd: 5 });
    const quarter = splitPosition(3, 10.01, 0.25);
    expect(quarter.ok).toBe(true);
    if (quarter.ok) {
      expect(quarter.soldCostUsd + quarter.remainCostUsd).toBeCloseTo(10.01, 10);
      expect(quarter.sellQty + quarter.remainQty).toBeCloseTo(3, 12);
      expect(quarter.remainCostUsd / quarter.remainQty).toBeCloseTo(10.01 / 3, 2);
    }
    expect(splitPosition(1, 1, 1)).toMatchObject({ ok: true, remainQty: 0, remainCostUsd: 0 });
    expect(splitPosition(1, 1, 0).ok).toBe(false);
    expect(splitPosition(1, 1, 1.5).ok).toBe(false);
    expect(splitPosition(Number.NaN, 1, 0.5).ok).toBe(false);
  });

  it("parses 25/50/100 percent and fractions, and refuses junk", () => {
    expect(parseSellFraction({ percent: 25 })).toBe(0.25);
    expect(parseSellFraction({ percent: 50 })).toBe(0.5);
    expect(parseSellFraction({ percent: 100 })).toBe(1);
    expect(parseSellFraction({ fraction: 0.5 })).toBe(0.5);
    expect(parseSellFraction({})).toBe(1);
    expect(parseSellFraction({ percent: 150 })).toBe("bad");
    expect(parseSellFraction({ percent: -5 })).toBe("bad");
    expect(parseSellFraction({ fraction: "x" })).toBe("bad");
  });

  it("sells 25% then 50% then the rest of a paper position", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ mint: "PartialMint1111111111111111111111111111111", symbol: "PART" }));
      const pos = [...desk.book.positions.values()][0]!;
      const qty0 = pos.qty;
      const cost0 = pos.costUsd;
      const cash0 = desk.book.cashUsd;
      const q = await desk.closePosition(pos.mint, 0.25);
      expect(q).toMatchObject({ ok: true, soldFraction: 0.25 });
      const after = desk.book.positions.get(pos.mint)!;
      expect(after.qty).toBeCloseTo(qty0 * 0.75, 6);
      expect(after.costUsd).toBeCloseTo(cost0 - Math.round(cost0 * 25) / 100, 2);
      expect(desk.book.cashUsd).toBeGreaterThan(cash0);
      await desk.closePosition(pos.mint, 0.5);
      expect(desk.book.positions.get(pos.mint)!.qty).toBeCloseTo(qty0 * 0.375, 6);
      const rest = await desk.closePosition(pos.mint, 1);
      expect(rest.ok).toBe(true);
      expect(desk.book.positions.has(pos.mint)).toBe(false);
      expect(await desk.closePosition(pos.mint, 0.5)).toMatchObject({ ok: false });
    } finally {
      desk.stop();
    }
  });
});

describe("v12 watchlist", () => {
  it("adds, refreshes, persists across a restart and removes", async () => {
    const config = testConfig({ rpcUrl: "http://rpc.test", rugcheckUrl: "http://rugcheck.test/v1" });
    const first = new Desk(config, { lookupFetch: coinFetch({ mintAuthority: null }) });
    try {
      const added = await first.addToWatchlist(`https://birdeye.so/token/${MINT}?chain=solana`);
      expect(added.ok).toBe(true);
      await first.refreshWatchlist();
      const row = first.snapshot().watchlist[0]!;
      expect(row).toMatchObject({ mint: MINT, platform: "Birdeye", addedPriceUsd: 0.002, lastPriceUsd: 0.003 });
      expect(row.changePct).toBeCloseTo(0.5, 10);
    } finally {
      first.stop();
    }
    const second = new Desk({ ...config, resetPaper: false }, { lookupFetch: coinFetch({ mintAuthority: null }) });
    try {
      expect(second.listWatchlist().map((w) => w.mint)).toEqual([MINT]);
      expect(second.removeFromWatchlist(MINT)).toMatchObject({ ok: true, watchlist: [] });
      expect(second.removeFromWatchlist(MINT).ok).toBe(false);
    } finally {
      second.stop();
    }
  });

  it("will not watch a coin with no reliable price", async () => {
    const desk = lookupDesk(coinFetch({ priceUsd: null }));
    try {
      expect(await desk.addToWatchlist(MINT)).toMatchObject({ ok: false, code: "PRICE_UNAVAILABLE" });
      expect(desk.listWatchlist()).toEqual([]);
    } finally {
      desk.stop();
    }
  });
});

describe("v12 size caps", () => {
  it("lets saved settings raise the position cap to 50% but never env or a hand-widened rule", () => {
    expect(clampPositionPct(60, 0.08, SIZING_BAND.autoMaxPct)).toBe(0.5);
    expect(clampPositionPct(0.5, 0.08, SIZING_BAND.autoMaxPct)).toBe(0.5);
    expect(clampPositionPct(1, 0.08, SIZING_BAND.autoMaxPct)).toBe(0.01);
    expect(clampPositionPct(20)).toBe(0.08);
    expect(resolveRules({ MAX_POSITION_PCT: "0.5" }).maxPositionPct).toBe(0.08);
    const rules = { ...resolveRules({}), maxPositionPct: 0.5 };
    const base = { equityUsd: 1_000, cashUsd: 1_000, rules, token: { priceUsd: 1, liquidityUsd: 1e9 }, hasPosition: false, cooldownUntil: null, now: 0 };
    expect(planOrder(base)).toMatchObject({ ok: true, sizeUsd: 80 });
    expect(planOrder({ ...base, ceilingPct: 0.5 })).toMatchObject({ ok: true, sizeUsd: 500 });
    expect(planOrder({ ...base, ceilingPct: 1 })).toMatchObject({ ok: true, sizeUsd: 1_000 });
    expect(planOrder({ ...base, ceilingPct: 5 })).toMatchObject({ ok: true, sizeUsd: 1_000 });
    expect(planOrder({ ...base, ceilingPct: 1, cashUsd: 300 })).toMatchObject({ ok: true, sizeUsd: 300 });
    expect(planOrder({ ...base, ceilingPct: 0.5, exposureRoomUsd: 120 })).toMatchObject({ ok: true, sizeUsd: 120 });
    expect(planOrder({ ...base, ceilingPct: 0.5, exposureRoomUsd: 0 })).toMatchObject({ ok: false, reason: { code: "EXPOSURE_CAP" } });
    expect(planOrder({ ...base, ceilingPct: 0.5, exposureRoomUsd: Number.NaN })).toMatchObject({ ok: false });
  });

  it("saves the bet-more settings with defaults equal to v11 behavior", async () => {
    const desk = testDesk();
    try {
      const prefs = desk.snapshot().prefs;
      expect(prefs).toMatchObject({ positionSizeUsd: null, maxExposurePct: 1, paperResetUsd: 100 });
      expect(desk.config.rules.maxPositionPct).toBe(0.08);
      const saved = desk.updateSettings({ maxPositionPct: 40, maxExposurePct: 60, positionSizeUsd: 25, paperResetUsd: 2_500 });
      expect(saved).toMatchObject({ ok: true, settings: { maxPositionPct: 0.4, maxExposurePct: 0.6, positionSizeUsd: 25, paperResetUsd: 2_500 } });
      expect(desk.updateSettings({ maxExposurePct: "lots" }).ok).toBe(false);
      expect(desk.updateSettings({ paperResetUsd: 50_000 })).toMatchObject({ ok: true, settings: { paperResetUsd: 10_000 } });
      expect(clampResetUsd(10)).toBe(100);
      expect(clampExposurePct(5)).toBe(0.1);
      const reset = desk.resetPaperBook(true);
      expect(reset).toMatchObject({ ok: true, cashUsd: 10_000, startingBalanceUsd: 10_000 });
    } finally {
      desk.stop();
    }
  });

  it("sizes auto buys from the saved % and $ and the exposure cap", async () => {
    const desk = testDesk({ startingBalanceUsd: 1_000 });
    try {
      desk.updateSettings({ maxPositionPct: 30, positionSizeUsd: 200, maxExposurePct: 50 });
      await desk.submitCandidate(makeToken({ mint: "AutoA111111111111111111111111111111111111", symbol: "AUTA" }));
      const a = desk.book.positions.get("AutoA111111111111111111111111111111111111");
      expect(a?.costUsd).toBe(200);
      await desk.submitCandidate(makeToken({ mint: "AutoB111111111111111111111111111111111111", symbol: "AUTB" }));
      await desk.submitCandidate(makeToken({ mint: "AutoC111111111111111111111111111111111111", symbol: "AUTC" }));
      const exposure = desk.snapshot().exposureUsd;
      expect(exposure).toBeLessThanOrEqual(desk.book.equity() * 0.5 + 1);
    } finally {
      desk.stop();
    }
  });

  it("maxSizeForPool is zero for an unknown pool and grows with depth", () => {
    expect(maxSizeForPool(0)).toBe(0);
    expect(maxSizeForPool(Number.NaN)).toBe(0);
    expect(maxSizeForPool(100_000)).toBeGreaterThan(maxSizeForPool(10_000));
  });
});

describe("v12 web settings cover every server key", () => {
  it("has a web field for every key POST /api/settings accepts, and nothing it does not", () => {
    for (const key of ALLOWED_SETTINGS) expect(SAVED_KEYS, key).toContain(key);
    for (const key of SAVED_KEYS) expect([...ALLOWED_SETTINGS], key).toContain(key);
  });

  it("covers every setting the Android Settings screen saves", () => {
    const kt = readFileSync(path.resolve("android/app/src/main/java/com/dirk/nightdesk/ui/SettingsScreen.kt"), "utf8");
    const payload = kt.slice(kt.indexOf("private fun payload"));
    const androidKeys = [...payload.matchAll(/"([a-zA-Z0-9]+)" to /g)].map((m) => m[1]!);
    expect(androidKeys.length).toBeGreaterThanOrEqual(30);
    for (const key of androidKeys) expect(SAVED_KEYS, key).toContain(key);
    for (const key of ALLOWED_SETTINGS) expect(androidKeys, `android ${key}`).toContain(key);
  });

  it("round-trips state to sliders and only sends what changed", () => {
    const desk = testDesk();
    try {
      const snap = desk.snapshot() as unknown as { rules: Record<string, unknown>; prefs: Record<string, unknown> };
      const before = draftFrom(snap);
      expect(before.maxPositionPct).toBe(8);
      expect(before.maxEntrySlippage).toBe(3);
      expect(before.stopLossPct).toBe(6);
      expect(before.cooldownHours).toBe(6);
      expect(before.scoutPump).toBe(true);
      expect(changedPatch(before, { ...before })).toEqual({});
      const patch = changedPatch(before, { ...before, maxPositionPct: 25, autoBuy: false, maxEntrySlippage: 1.5 });
      expect(patch).toEqual({ maxPositionPct: 0.25, autoBuy: false, maxEntrySlippage: 0.015 });
      const saved = desk.updateSettings(patch);
      expect(saved).toMatchObject({ ok: true, settings: { maxPositionPct: 0.25, autoBuy: false, maxEntrySlippage: 0.015 } });
      expect(SETTINGS_FIELDS.every((f) => f.group)).toBe(true);
    } finally {
      desk.stop();
    }
  });
});

describe("v12 lookup price fallback for pump curve coins", () => {
  const jup = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const MINT = "BrHs7qDBy3XaoY78VZy9q1EHWZWiayCA91UBpThCXnNt";

  it("uses Jupiter price and liquidity when it agrees with DexScreener's curve price", async () => {
    const out = await jupiterLookupQuote(MINT, 0.000003061, jup({ [MINT]: { usdPrice: 0.00000319, liquidity: 3281.6 } }));
    expect(out).toEqual({ ok: true, priceUsd: 0.00000319, liquidityUsd: 3281.6 });
  });

  it("refuses (fail closed) when the two feeds disagree by more than 25%", async () => {
    const out = await jupiterLookupQuote(MINT, 0.000003, jup({ [MINT]: { usdPrice: 0.000006, liquidity: 5000 } }));
    expect(out.ok).toBe(false);
    expect((out as { error?: string }).error).toMatch(/Prices disagree/);
  });

  it("gives nothing when Jupiter has no price, no depth, or errors", async () => {
    expect(await jupiterLookupQuote(MINT, 0, jup({}))).toEqual({ ok: false });
    expect(await jupiterLookupQuote(MINT, 0, jup({ [MINT]: { usdPrice: 0.1, liquidity: 0 } }))).toEqual({ ok: false });
    expect(await jupiterLookupQuote(MINT, 0, jup({ error: "x" }, 500))).toEqual({ ok: false });
  });
});
