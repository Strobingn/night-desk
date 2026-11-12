import { describe, expect, it } from "vitest";
import { Scout, enrichBefore } from "../src/agents/scout.js";
import { EventBus } from "../src/bus.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import type { TapeQuoter } from "../src/market/tape-quotes.js";
import {
  ENRICH_RPC_PER_COIN,
  KillMemory,
  PREFILTER_BACKOFF_MS,
  estimateRpcDemand,
  junkIdentity,
  prefilterFree,
  type PrefilterThresholds
} from "../src/market/prefilter.js";
import { NetLimiter } from "../src/market/net.js";
import type { DeskEvents, RawSighting } from "../src/types.js";
import { testConfig } from "./helpers.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const HELIUS = "https://mainnet.helius-rpc.com/?api-key=test";

const thresholds: PrefilterThresholds = {
  minVolume1hUsd: 10_000,
  minLiquidityUsd: 4_000,
  minAgeSeconds: 0,
  maxAgeSeconds: 0,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  bannedMints: new Set()
};

function sighting(over: Partial<RawSighting> = {}): RawSighting {
  return {
    mint: MINT,
    symbol: "LOW",
    name: "Low Coin",
    source: "pumpfun",
    observedAt: 1_700_000_000_000,
    ...over
  };
}

function scoutWith(fetchImpl: typeof fetch, extra: { laneBusy?: () => boolean } = {}): { scout: Scout; published: string[] } {
  const bus = new EventBus<DeskEvents>();
  const published: string[] = [];
  bus.on("scout.candidate", (token) => {
    published.push(token.mint);
  });
  const memory = new KillMemory();
  const scout = new Scout({
    bus,
    feedMode: "live",
    demo: false,
    rpcUrl: HELIUS,
    pumpWsUrl: "ws://unused",
    enrichConcurrency: 1,
    queueCap: 8,
    fetchImpl,
    prefilter: () => thresholds,
    killMemory: memory,
    laneBusy: extra.laneBusy,
    onStatus: () => {}
  });
  return { scout, published };
}

describe("v13.34 prefilter", () => {
  it("kills a cheap volume miss before any RPC mock is called", async () => {
    let calls = 0;
    const { scout } = scoutWith(async () => {
      calls += 1;
      throw new Error("RPC should not run");
    });
    scout.ingest(sighting({ volume1hUsd: 100, liquidityUsd: 50_000, priceUsd: 0.01 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(0);
    expect(scout.status.enriched).toBe(0);
    expect(scout.prefilterView().kills.VOLUME_TOO_LOW).toBe(1);
    expect(scout.prefilterView().rpcSaved).toBe(ENRICH_RPC_PER_COIN);
    scout.stop();
  });

  it("waits one free print when volume is missing, then kills without RPC", async () => {
    let calls = 0;
    const { scout } = scoutWith(async () => {
      calls += 1;
      return Response.json({ pairs: [] });
    });
    scout.ingest(sighting());
    scout.ingest(sighting());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);
    expect(scout.prefilterView().kills.VOLUME_TOO_LOW).toBe(1);
    scout.stop();
  });

  it("does not enrich a soft kill again until volume grows past the floor after the backoff", () => {
    const memory = new KillMemory();
    memory.note(MINT, false, 0, 100);
    expect(memory.admit(MINT, PREFILTER_BACKOFF_MS - 1, 50_000, thresholds, null)).toBe("block");
    expect(memory.admit(MINT, PREFILTER_BACKOFF_MS, 9_000, thresholds, null)).toBe("block");
    expect(memory.admit(MINT, PREFILTER_BACKOFF_MS, 50_000, thresholds, null)).toBe("enrich");
    expect(memory.admit(MINT, PREFILTER_BACKOFF_MS, 50_000, thresholds, null)).toBe("enrich");
    memory.commit(MINT);
    expect(memory.admit(MINT, PREFILTER_BACKOFF_MS + 60_000, 80_000, thresholds, null)).toBe("block");
    memory.note("hard-mint", true, 0, 0);
    expect(memory.admit("hard-mint", PREFILTER_BACKOFF_MS * 4, 1_000_000, thresholds, null)).toBe("block");
    expect(prefilterFree(sighting({ symbol: "??", volume1hUsd: 99_000, liquidityUsd: 20_000, priceUsd: 1 }), thresholds, 0).action).toBe("kill");
    expect(junkIdentity(undefined, "Visit https://example.com for project info")).toBe(false);
    expect(junkIdentity("https://scam.example", "Ok")).toBe(true);
  });

  it("still calls RPC for Search and a manual buy of a prefiltered mint", async () => {
    const rpcMethods: string[] = [];
    const chainCalls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const method = (JSON.parse(String(init.body)) as { method?: string }).method ?? "";
        rpcMethods.push(method);
        chainCalls.push(method);
        return Response.json({ jsonrpc: "2.0", result: { value: null } });
      }
      if (url.includes("dexscreener")) {
        return Response.json({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "Pair11111111111111111111111111111111111111",
              baseToken: { address: MINT, symbol: "LOW", name: "Low Coin" },
              priceUsd: "0.2",
              liquidity: { usd: 40_000 },
              volume: { h1: 100 },
              pairCreatedAt: Date.now()
            }
          ]
        });
      }
      return Response.json({});
    };
    const desk = new Desk(testConfig({ rpcUrl: HELIUS, rugcheckUrl: undefined }), {
      lookupFetch: fetchImpl,
      chainFetch: fetchImpl
    });
    try {
      const scout = (desk as unknown as { scout: Scout }).scout;
      scout.ingest(sighting({ volume1hUsd: 100, liquidityUsd: 50_000, priceUsd: 0.2 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rpcMethods).toEqual([]);
      const beforeBuy = chainCalls.length;
      await desk.manualBuy(MINT, 5, { book: "paper" });
      expect(chainCalls.length).toBeGreaterThan(beforeBuy);
      const looked = await desk.lookupCoin(MINT);
      expect(looked.ok).toBe(true);
      expect(rpcMethods).toContain("getAccountInfo");
    } finally {
      desk.stop();
    }
  });

  it("enriches the higher free-feed score first when the lane is busy", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const order: string[] = [];
    const { scout, published } = scoutWith(
      async () => {
        await gate;
        return Response.json({ pairs: [] });
      },
      { laneBusy: () => true }
    );
    scout.ingest(sighting({ mint: "thin", symbol: "THIN", observedAt: 30, volume1hUsd: 12_000, liquidityUsd: 5_000 }));
    scout.ingest(sighting({ mint: "fat", symbol: "FAT", observedAt: 10, volume1hUsd: 400_000, liquidityUsd: 80_000 }));
    scout.ingest(sighting({ mint: "mid", symbol: "MID", observedAt: 20, volume1hUsd: 40_000, liquidityUsd: 10_000 }));
    release();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("enrich did not finish")), 2_000);
      const poll = () => {
        if (published.length >= 3) {
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    order.push(...published);
    expect(order[0]).toBe("thin");
    expect(order[1]).toBe("fat");
    expect(order[2]).toBe("mid");
    expect(enrichBefore(sighting({ observedAt: 1, volume1hUsd: 9_000_000 }), sighting({ observedAt: 5, volume1hUsd: 1 }))).toBeGreaterThan(0);
    scout.stop();
  });

  it("serves a manual read before a queued Helius mark", async () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const sent: string[] = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: (fn, ms) => {
          timers.push({ at: now + Number(ms), fn });
          return 0;
        }
      },
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent.push(String(init?.body ?? ""));
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });
    const body = (method: string, tag: string) =>
      JSON.stringify({ jsonrpc: "2.0", id: tag, method, params: [[`Mint${tag}111111111111111111111111111111111`], { encoding: "base64" }] });
    for (let i = 0; i < 3; i += 1) {
      await net.fetchAt(0)(HELIUS, { method: "POST", body: body("getMultipleAccounts", `b${i}`) });
    }
    const mark = net.fetchAt(0)(HELIUS, { method: "POST", body: body("getMultipleAccounts", "mark") });
    const manual = net.fetchAt(-1)(HELIUS, { method: "POST", body: body("getMultipleAccounts", "manual") });
    for (let i = 0; i < 8 && sent.length < 5; i += 1) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) break;
      now = next.at;
      next.fn();
      await Promise.resolve();
    }
    await Promise.all([mark, manual]);
    const markAt = sent.findIndex((row) => row.includes("mark"));
    const manualAt = sent.findIndex((row) => row.includes("manual"));
    expect(manualAt).toBeGreaterThanOrEqual(0);
    expect(markAt).toBeGreaterThan(manualAt);
    expect(net.heliusQueue().priority0).toBe(0);
  });

  it("does not spend the soft retry on an incomplete free print", async () => {
    let calls = 0;
    const memory = new KillMemory();
    memory.note(MINT, false, Date.now() - PREFILTER_BACKOFF_MS - 1, 100);
    const bus = new EventBus<DeskEvents>();
    const scout = new Scout({
      bus,
      feedMode: "live",
      demo: false,
      rpcUrl: HELIUS,
      pumpWsUrl: "ws://unused",
      enrichConcurrency: 1,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ pairs: [] });
      },
      prefilter: () => thresholds,
      killMemory: memory,
      onStatus: () => {}
    });
    scout.ingest(sighting({ volume1hUsd: 50_000, priceUsd: 0.2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);
    expect(memory.admit(MINT, Date.now(), 50_000, thresholds, null)).toBe("enrich");
    scout.ingest(sighting({ volume1hUsd: 50_000, liquidityUsd: 50_000, priceUsd: 0.2 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBeGreaterThan(0);
    scout.stop();
  });

  it("lets a cooldown ban expire instead of hard-killing the mint", async () => {
    let calls = 0;
    const banned = new Set<string>([MINT]);
    const bus = new EventBus<DeskEvents>();
    const scout = new Scout({
      bus,
      feedMode: "live",
      demo: false,
      rpcUrl: HELIUS,
      pumpWsUrl: "ws://unused",
      enrichConcurrency: 1,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ pairs: [] });
      },
      prefilter: () => ({ ...thresholds, bannedMints: banned }),
      killMemory: new KillMemory(),
      onStatus: () => {}
    });
    const rich = sighting({ volume1hUsd: 50_000, liquidityUsd: 50_000, priceUsd: 0.2 });
    scout.ingest(rich);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);
    banned.delete(MINT);
    scout.ingest(rich);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBeGreaterThan(0);
    scout.stop();
  });

  it("still reads the curve for an open limit buy that is not held", async () => {
    const pump = "J1c4tDDUziWwZQ4D8c6kxuAXHg5hcBX8GTNFUEaBpump";
    const chainBodies: string[] = [];
    const desk = new Desk(testConfig({ rpcUrl: HELIUS, feedMode: "live" }), {
      lookupFetch: async () => Response.json({ pairs: [] }),
      chainFetch: async (_url, init) => {
        chainBodies.push(String(init?.body ?? ""));
        return Response.json({ jsonrpc: "2.0", result: { value: [null, null] } });
      }
    });
    try {
      expect(desk.updateSettings({ autoBuy: false }).ok).toBe(true);
      desk.bus.emit("scout.candidate", makeToken({ mint: pump, source: "pumpfun", symbol: "PUMP", priceUsd: 0.002, volume1hUsd: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const placed = desk.placeOrder({ side: "limit_buy", mint: pump, basis: "price", value: 0.001, sizeUsd: 5, book: "paper" });
      if (!placed.ok) throw new Error(placed.error);
      const tape = (desk as unknown as { tape?: TapeQuoter }).tape;
      expect(tape).toBeTruthy();
      await tape!.tick();
      expect(chainBodies.some((body) => body.includes("getMultipleAccounts"))).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("estimates the RPC demand from the production kill mix", () => {
    // 120 sightings in a busy minute. 86% die on free data (pump creates with no volume,
    // or a printed volume/liquidity under the existing floors — volume is 32151 of 79571
    // kill tags). 14% still enrich. Stray chain marks are one per sighting today;
    // afterwards only a handful of held and watch marks remain.
    const estimate = estimateRpcDemand({
      sightingsPerMin: 120,
      enrichShare: 0.14,
      strayChainMarksPerMin: 120,
      keptChainMarksPerMin: 4
    });
    expect(estimate.beforePerMin).toBe(484);
    expect(estimate.afterPerMin).toBeCloseTo(54.4);
    expect(estimate.afterPerMin).toBeLessThan(estimate.beforePerMin / 5);
  });
});
