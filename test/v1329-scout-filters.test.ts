import { describe, expect, it } from "vitest";
import { evaluateFilter } from "../src/agents/filter.js";
import { Desk } from "../src/desk/orchestrator.js";
import { makeToken } from "../src/demo/tokens.js";
import { testConfig } from "./helpers.js";
import { POOL_AUTHORITY_OWNERS, RESERVE_OWNER_SET, holderExclusions } from "../src/market/exclusions.js";
import { enrichSighting, needsFilterRugcheck } from "../src/market/enrich.js";
import { ENRICH_CALLS_PER_MIN_DEFAULT, ENRICH_RPS_CAP, NetLimiter } from "../src/market/net.js";
import { LARGEST_HOLDER_CAP, devShareFromLargest, dexPairAddresses, parseTop10Pct } from "../src/market/parsers.js";
import { RECHECK_DELAY_MAX_MS, RECHECK_DELAY_MIN_MS, RECHECK_QUEUE_MAX, RecheckQueue, recheckDelayMs, recheckEligible, recheckToken } from "../src/market/recheck.js";
import { minHolderControl } from "../web/src/settingsSchema.js";
import { resolveRules } from "../src/rules.js";

const rules = resolveRules({});
const MINT = "8oHq9bpx3a7DQPk7NHYMDwbzU3F9nVAnipYGYjRCKpyD";
const POOL = "H2W2VWqDYCXkYhLe1CBE29jpYrF9Gn6NEBBJ8eowH5Zd";
const ALCHEMY = "https://solana-mainnet.g.alchemy.com/v2/supersecretkey";
const HELIUS = "https://mainnet.helius-rpc.com/?api-key=heliussecret";

function rows(count: number, amount = 10) {
  return Array.from({ length: count }, (_, i) => ({
    address: `Acct${i}111111111111111111111111111111111`,
    owner: `Owner${i}11111111111111111111111111111111`,
    uiAmount: amount
  }));
}

describe("v13.29 top-20 holder count", () => {
  it("counts a full page of real holders as 20 or more and an exact count below that", () => {
    const full = parseTop10Pct({ value: rows(LARGEST_HOLDER_CAP, 10) }, 10_000);
    expect(full.holderCount).toBe(20);
    expect(full.holderCountAtLeast).toBe(true);
    expect(full.top10HolderPct).toBeCloseTo(0.01, 8);

    const exact = parseTop10Pct({ value: rows(19, 10) }, 10_000);
    expect(exact.holderCount).toBe(19);
    expect(exact.holderCountAtLeast).toBe(false);

    const mixed = rows(20, 10);
    mixed[0] = { ...mixed[0]!, owner: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" };
    const partial = parseTop10Pct({ value: mixed }, 10_000, { owners: RESERVE_OWNER_SET });
    expect(partial.holderCount).toBe(19);
    expect(partial.holderCountAtLeast).toBe(false);
  });

  it("passes a holder minimum up to 20 when the top 20 are all real holders", () => {
    const pass = evaluateFilter(makeToken({ holderCount: 20, holderCountAtLeast: true }), { status: "clean" }, rules, { minHolderCount: 20 });
    expect(pass.reasons.map((reason) => reason.code)).not.toContain("HOLDER_COUNT");
    expect(pass.checks.find((check) => check.code === "HOLDER_COUNT")?.message).toMatch(/20\+/);
    const miss = evaluateFilter(makeToken({ holderCount: 19, holderCountAtLeast: false }), { status: "clean" }, rules, { minHolderCount: 20 });
    expect(miss.reasons.map((reason) => reason.code)).toContain("HOLDER_COUNT");
  });

  it("caps the settings slider at 20 off Helius and leaves it alone on Helius", () => {
    const alchemy = minHolderControl("solana-mainnet.g.alchemy.com");
    expect(alchemy.max).toBe(20);
    expect(alchemy.label).toMatch(/of top 20/);
    const helius = minHolderControl("mainnet.helius-rpc.com");
    expect(helius.max).toBe(2_000);
    expect(helius.label).toBe("Min holders");
  });
});

describe("v13.29 dev share from the top 20", () => {
  it("uses the dev's balance when the wallet owns a top account, else the 20th as a ceiling", () => {
    const list = rows(20, 0).map((row, i) => ({ ...row, uiAmount: 1_000 - i }));
    const absent = devShareFromLargest({ value: list }, 100_000, "DevWallet111111111111111111111111111111");
    expect(absent.upperBound).toBe(true);
    expect(absent.pct).toBeCloseTo(981 / 100_000, 8);

    const owned = list.map((row, i) => (i === 3 ? { ...row, owner: "DevWallet111111111111111111111111111111" } : row));
    const exact = devShareFromLargest({ value: owned }, 100_000, "DevWallet111111111111111111111111111111");
    expect(exact.upperBound).toBe(false);
    expect(exact.pct).toBeCloseTo(997 / 100_000, 8);

    const short = devShareFromLargest({ value: list.slice(0, 5) }, 100_000, "DevWallet111111111111111111111111111111");
    expect(short).toEqual({ pct: 0, upperBound: false });
    expect(devShareFromLargest({ value: list }, null, "DevWallet111111111111111111111111111111").pct).toBeNull();
    expect(devShareFromLargest({ value: [{ owner: "Dev", uiAmount: 200 }] }, 100, "Dev").pct).toBeNull();
  });

  it("asks RugCheck for a missing dev share only when the dev limit is on", () => {
    const ready = makeToken({ volume1hUsd: 20_000, devHoldingPct: null });
    expect(needsFilterRugcheck(ready, 10_000, 0)).toBe(false);
    expect(needsFilterRugcheck(ready, 10_000, 0.1)).toBe(true);
    expect(needsFilterRugcheck({ ...ready, devHoldingPct: 0.02 }, 10_000, 0.1)).toBe(false);
    expect(needsFilterRugcheck({ ...ready, volume1hUsd: 10 }, 10_000, 0.1)).toBe(false);
  });

  it("passes when the upper bound is inside the limit and fails closed when no bound exists", () => {
    const bound = evaluateFilter(makeToken({ devHoldingPct: 0.04, devHoldingUpperBound: true }), { status: "clean" }, rules, {
      maxDevHoldingPct: 0.05
    });
    expect(bound.decision).toBe("pass");
    expect(bound.checks.find((check) => check.code === "DEV_HOLDING")?.message).toMatch(/at most/);
    const unknown = evaluateFilter(makeToken({ devHoldingPct: null }), { status: "clean" }, rules, { maxDevHoldingPct: 0.05 });
    expect(unknown.reasons.map((reason) => reason.code)).toContain("DEV_HOLDING");
    expect(unknown.reasons.find((reason) => reason.code === "DEV_HOLDING")?.message).toMatch(/Fail closed/);
  });
});

describe("v13.29 pool vaults and impossible shares", () => {
  it("drops the example PumpSwap pool and accounts owned by pool authorities", () => {
    const exclude = holderExclusions(MINT, dexPairAddresses({
      pairs: [
        { chainId: "solana", dexId: "pumpswap", pairAddress: POOL, baseToken: { address: MINT } },
        { chainId: "solana", dexId: "raydium", pairAddress: "OtherPool1111111111111111111111111111111", baseToken: { address: "else" } }
      ]
    }, MINT));
    expect(exclude.addresses.has(POOL)).toBe(true);
    expect(exclude.owners.has(POOL)).toBe(true);
    const damm = POOL_AUTHORITY_OWNERS.find((owner) => owner !== "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG" && RESERVE_OWNER_SET.has(owner));
    expect(damm).toBeTruthy();
    const parsed = parseTop10Pct(
      {
        value: [
          { address: POOL, owner: "ignored", uiAmount: 850_000 },
          { address: "VaultAta111111111111111111111111111111111", owner: POOL, uiAmount: 100_000 },
          { address: "DammVault11111111111111111111111111111111", owner: damm, uiAmount: 40_000 },
          { address: "Retail11111111111111111111111111111111111", owner: "Wallet11111111111111111111111111111111111", uiAmount: 10_000 }
        ]
      },
      1_000_000,
      exclude
    );
    expect(parsed.excludedReserves).toBe(3);
    expect(parsed.top10HolderPct).toBeCloseTo(0.01, 8);
    expect(parsed.holderCount).toBe(1);
  });

  it("fails closed when a computed share is above 100%", () => {
    const parsed = parseTop10Pct({ value: [{ address: "A", owner: "W", uiAmount: 588 }] }, 100);
    expect(parsed.top10HolderPct).toBeNull();
    expect(parsed.holderCount).toBe(1);
    const result = evaluateFilter(makeToken({ top10HolderPct: parsed.top10HolderPct }), { status: "clean" }, rules);
    expect(result.reasons.map((reason) => reason.code)).toContain("HOLDER_CONCENTRATION");
    expect(result.reasons.find((reason) => reason.code === "HOLDER_CONCENTRATION")?.message).toMatch(/Fail closed/);
  });

  it("uses the on-chain mint supply and does not turn market cap over price into a passing share", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("dexscreener")) {
        return Response.json({
          pairs: [
            {
              chainId: "solana",
              dexId: "pumpswap",
              pairAddress: POOL,
              priceUsd: "1",
              marketCap: 588,
              baseToken: { address: MINT },
              liquidity: { usd: 1_000 },
              volume: { h1: 10 }
            }
          ]
        });
      }
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      if (method === "getAccountInfo") {
        return Response.json({
          result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, supply: "100000000", decimals: 6 } } } } }
        });
      }
      if (method === "getTokenLargestAccounts") {
        return Response.json({
          result: {
            value: [
              { address: POOL, uiAmount: 80, decimals: 6 },
              { address: "Retail", uiAmount: 588, decimals: 6 }
            ]
          }
        });
      }
      return Response.json({
        result: { value: [{ data: { parsed: { info: { owner: "pool-owner" } } } }, { data: { parsed: { info: { owner: "retail" } } } }] }
      });
    };
    const token = await enrichSighting({ mint: MINT, source: "pumpfun", observedAt: 1 }, { rpcUrl: ALCHEMY, fetchImpl });
    expect(token.top10HolderPct).toBeNull();
    expect(token.holderCount).toBe(1);
  });
});

describe("v13.29 soft-gate recheck", () => {
  const soft = makeToken({ volume1hUsd: 0, liquidityUsd: 0 });

  it("schedules one recheck 3 to 5 minutes out for soft misses and drops the oldest past 300", () => {
    const queue = new RecheckQueue();
    const now = 1_000_000;
    expect(recheckEligible(soft, [{ code: "VOLUME_TOO_LOW" }, { code: "HOLDER_COUNT" }])).toBe(true);
    expect(recheckEligible(soft, [{ code: "VOLUME_TOO_LOW" }, { code: "MINT_AUTHORITY_ACTIVE" }])).toBe(false);
    expect(recheckEligible(soft, [{ code: "LP_NOT_LOCKED" }])).toBe(false);
    expect(recheckEligible(soft, [{ code: "DEV_RUG_HISTORY" }])).toBe(false);
    expect(recheckEligible({ freezeAuthorityRevoked: false }, [{ code: "VOLUME_TOO_LOW" }])).toBe(false);
    expect(queue.offer(soft, [{ code: "VOLUME_TOO_LOW" }, { code: "LIQUIDITY_TOO_THIN" }], now)).toBe(true);
    expect(queue.offer(soft, [{ code: "VOLUME_TOO_LOW" }], now)).toBe(false);
    const delay = recheckDelayMs(soft.mint);
    expect(delay).toBeGreaterThanOrEqual(RECHECK_DELAY_MIN_MS);
    expect(delay).toBeLessThanOrEqual(RECHECK_DELAY_MAX_MS);
    expect(queue.due(now + delay - 1)).toEqual([]);
    expect(queue.due(now + delay).map((token) => token.mint)).toEqual([soft.mint]);

    const crowded = new RecheckQueue();
    for (let i = 0; i < RECHECK_QUEUE_MAX + 5; i += 1) {
      crowded.offer(makeToken({ mint: `Mint${i}` }), [{ code: "HOLDER_CONCENTRATION" }], now + i);
    }
    expect(crowded.counts()).toMatchObject({ pending: RECHECK_QUEUE_MAX, dropped: 5 });
    const drained = crowded.due(now + RECHECK_QUEUE_MAX + RECHECK_DELAY_MAX_MS + 1_000);
    expect(drained).toHaveLength(RECHECK_QUEUE_MAX);
    expect(drained.some((token) => token.mint === "Mint0")).toBe(false);
    expect(drained.some((token) => token.mint === `Mint${RECHECK_QUEUE_MAX + 4}`)).toBe(true);
  });

  it("stays inside the enrich budget and never calls Helius", async () => {
    let now = 0;
    const hosts: string[] = [];
    const sent: number[] = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: ((fn: () => void, ms: number) => {
          now += ms;
          fn();
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const host = new URL(String(input)).hostname;
        hosts.push(host);
        if (host.includes("helius")) return new Response("", { status: 500 });
        if (init?.method === "POST") {
          sent.push(now);
          const method = (JSON.parse(String(init.body)) as { method: string }).method;
          if (method === "getAccountInfo") {
            return Response.json({ result: { value: { data: { parsed: { info: { mintAuthority: null, supply: "1000", decimals: 0 } } } } } });
          }
          if (method === "getTokenLargestAccounts") return Response.json({ result: { value: [] } });
          return Response.json({ result: { value: [] } });
        }
        return Response.json({ pairs: [] });
      }) as typeof fetch
    });
    net.useEnrichRpc(ALCHEMY, ENRICH_CALLS_PER_MIN_DEFAULT);
    const tokens = Array.from({ length: 24 }, (_, i) => makeToken({ mint: `RecheckMint${i}` }));
    for (const token of tokens) {
      await recheckToken(token, { rpcUrl: ALCHEMY, fetchImpl: net.fetchAt(1) });
    }
    await recheckToken(makeToken({ mint: "helius-try" }), { rpcUrl: HELIUS, fetchImpl: net.fetchAt(1) });
    expect(hosts.some((host) => host.includes("helius"))).toBe(false);
    expect(net.stats().find((row) => row.id === "helius")?.reqLastMin ?? 0).toBe(0);
    expect(sent.length).toBeGreaterThan(ENRICH_CALLS_PER_MIN_DEFAULT);
    for (const start of sent) {
      const inSecond = sent.filter((t) => t >= start && t < start + 1_000).length;
      expect(inSecond).toBeLessThanOrEqual(ENRICH_RPS_CAP);
      const inMinute = sent.filter((t) => t > start - 60_000 && t <= start).length;
      expect(inMinute).toBeLessThanOrEqual(ENRICH_CALLS_PER_MIN_DEFAULT + 8);
    }
  });

  it("shows the recheck queue on /api/state and skips a hard rug", async () => {
    const desk = new Desk(testConfig());
    try {
      // 13.34: a volume or liquidity miss is a free-feed kill. It does not take an RPC recheck slot.
      desk.bus.emit("scout.candidate", makeToken({ volume1hUsd: 0, liquidityUsd: 1_000 }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(desk.snapshot().recheck).toEqual({ pending: 0, ran: 0, dropped: 0 });
      const holders = desk.updateSettings({ minHolderCount: 20 });
      expect(holders.ok).toBe(true);
      desk.bus.emit(
        "scout.candidate",
        makeToken({
          mint: "HolderMint11111111111111111111111111111111",
          volume1hUsd: 50_000,
          liquidityUsd: 50_000,
          holderCount: 1,
          holderCountAtLeast: false,
          mintAuthorityRevoked: true
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(desk.snapshot().recheck).toEqual({ pending: 1, ran: 0, dropped: 0 });
      desk.bus.emit("scout.candidate", makeToken({ mint: "RugMint111111111111111111111111111111111", mintAuthorityRevoked: false, volume1hUsd: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(desk.snapshot().recheck?.pending).toBe(1);
    } finally {
      desk.stop();
    }
  });
});
