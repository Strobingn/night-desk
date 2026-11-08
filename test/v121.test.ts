import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_CAP_MS, BUCKETS, NetLimiter, bucketFor, retryAfterMs } from "../src/market/net.js";
import { DexTokenBatcher } from "../src/market/dex-batch.js";
import { fetchDexQuotes, fetchJupiterQuotes } from "../src/market/dex-prices.js";
import { BANNER_AFTER_MS, FeedHealth } from "../src/agents/feed-health.js";
import { DEXPAPRIKA_NEW_URL, GONE_RECHECK_MS, SCOUT_POLL_MS, Scout } from "../src/agents/scout.js";
import { parseDexPaprika } from "../src/market/listings.js";
import { EventBus } from "../src/bus.js";
import type { DeskEvents } from "../src/types.js";

const SOL = "So11111111111111111111111111111111111111112";
const spec = (id: string) => BUCKETS.find((b) => b.id === id)!;

function okJson(body: unknown = {}): Response {
  return Response.json(body);
}

describe("v12.1 shared rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("every bucket's budget is ~80% of the limit and budget + burst never exceeds the limit", () => {
    for (const b of BUCKETS) {
      expect(b.budgetPerMin / b.limitPerMin).toBeGreaterThanOrEqual(0.75);
      expect(b.budgetPerMin / b.limitPerMin).toBeLessThanOrEqual(0.8);
      expect(b.budgetPerMin + b.burst).toBeLessThanOrEqual(b.limitPerMin);
    }
  });

  it("maps every Scout host and both Jupiter hosts to one shared bucket each", () => {
    expect(bucketFor("https://api.jup.ag/price/v3?ids=x")?.id).toBe("jupiter");
    expect(bucketFor("https://lite-api.jup.ag/tokens/v2/recent")?.id).toBe("jupiter");
    expect(bucketFor("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1")?.id).toBe("gecko");
    expect(bucketFor("https://api.dexscreener.com/tokens/v1/solana/a,b")?.id).toBe("dexscreener:pairs");
    expect(bucketFor("https://api.dexscreener.com/latest/dex/tokens/a")?.id).toBe("dexscreener:pairs");
    expect(bucketFor("https://api.dexscreener.com/token-boosts/top/v1")?.id).toBe("dexscreener:boosts-top");
    expect(bucketFor("https://api.dexpaprika.com/networks/solana/pools/search")?.id).toBe("dexpaprika");
    expect(bucketFor("https://pumpportal.fun/api/data")).toBeNull();
  });

  it("stays under budget: 300 callers over 5 minutes never exceed the limit in any 60s window", async () => {
    for (const id of ["gecko", "jupiter", "dexscreener:profiles"]) {
      const sentAt: number[] = [];
      const net = new NetLimiter({
        fetchImpl: (async () => {
          sentAt.push(Date.now());
          return okJson([]);
        }) as unknown as typeof fetch
      });
      const s = spec(id);
      const base = id === "gecko" ? "https://api.geckoterminal.com/x" : id === "jupiter" ? "https://api.jup.ag/price/v3" : "https://api.dexscreener.com/token-profiles/latest/v1";
      const all: Promise<unknown>[] = [];
      for (let i = 0; i < 300; i += 1) {
        all.push(net.fetch(`${base}?n=${i}`, { ndPriority: 2 }).catch(() => null));
        if (i % 60 === 0) await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const t0 = sentAt[0]!;
      const fiveMin = sentAt.filter((t) => t < t0 + 5 * 60_000).length;
      expect(fiveMin).toBeLessThanOrEqual(s.budgetPerMin * 5 + s.burst);
      for (const start of sentAt) {
        const inWindow = sentAt.filter((t) => t >= start && t < start + 60_000).length;
        expect(inWindow).toBeLessThanOrEqual(s.limitPerMin);
      }
    }
  });

  it("honors Retry-After on a 429 and retries once after the pause", async () => {
    const calls: number[] = [];
    const net = new NetLimiter({
      fetchImpl: (async () => {
        calls.push(Date.now());
        return calls.length === 1 ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : okJson({ ok: 1 });
      }) as unknown as typeof fetch
    });
    const p = net.fetch("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1");
    await vi.advanceTimersByTimeAsync(10);
    expect(net.pausedUntil(spec("gecko"))).not.toBeNull();
    // The rate is halved after a 429, so the retry waits for both the pause and a fresh token.
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(7_000);
    expect(net.stats().find((b) => b.id === "gecko")?.count429).toBe(1);
  });

  it("reads Jupiter's absolute x-ratelimit-reset and DexPaprika's relative ratelimit-reset", () => {
    expect(retryAfterMs("12", 0)).toBe(12_000);
    expect(retryAfterMs(new Date(60_000).toUTCString(), 0)).toBe(60_000);
    const net = new NetLimiter({ clock: { now: () => 1_000_000_000_000 } });
    // @ts-expect-error private access in test
    net.readWindowHeaders(spec("jupiter"), new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(1_000_000_000 + 9) }));
    expect(net.pausedUntil(spec("jupiter"))).toBe(1_000_000_000_000 + 9_000);
  });

  it("backs off exponentially with jitter when there is no Retry-After, capped at 2 minutes", () => {
    let r = 0.5;
    const net = new NetLimiter({ clock: { random: () => r } });
    const waits: number[] = [];
    for (let i = 0; i < 12; i += 1) waits.push(net.note429(spec("gecko"), null));
    expect(waits[0]).toBe(2_000);
    expect(waits[1]).toBe(4_000);
    expect(waits[2]).toBe(8_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(waits.at(-1)).toBe(BACKOFF_CAP_MS);
    r = 0;
    const jittered = new NetLimiter({ clock: { random: () => r } }).note429(spec("gecko"), null);
    expect(jittered).toBe(1_500);
  });

  it("steps back up after successes: rate returns to full budget and the backoff ladder resets", () => {
    const net = new NetLimiter({ clock: { random: () => 0.5 } });
    net.note429(spec("jupiter"), null);
    net.note429(spec("jupiter"), null);
    expect(net.stats().find((b) => b.id === "jupiter")?.rateFactor).toBe(0.25);
    for (let i = 0; i < 20; i += 1) net.noteOk(spec("jupiter"));
    expect(net.stats().find((b) => b.id === "jupiter")?.rateFactor).toBe(1);
    expect(net.note429(spec("jupiter"), null)).toBe(2_000);
  });

  it("held marks never wait out a backoff: priority 0 gets a local 429 at once", async () => {
    let calls = 0;
    const net = new NetLimiter({ fetchImpl: (async () => { calls += 1; return okJson({}); }) as unknown as typeof fetch });
    net.note429(spec("jupiter"), 30_000);
    const res = await net.fetchAt(0)("https://api.jup.ag/price/v3?ids=x");
    expect(res.status).toBe(429);
    expect(calls).toBe(0);
    expect(net.stats().find((b) => b.id === "jupiter")?.count429).toBe(1);
  });

  it("dedupes identical in-flight GETs and caches them for a few seconds", async () => {
    let calls = 0;
    const net = new NetLimiter({ fetchImpl: (async () => { calls += 1; return okJson([{ n: calls }]); }) as unknown as typeof fetch });
    const url = "https://api.dexscreener.com/token-profiles/latest/v1";
    const [a, b] = await Promise.all([net.fetch(url), net.fetch(url)]);
    expect(await a.json()).toEqual([{ n: 1 }]);
    expect(await b.json()).toEqual([{ n: 1 }]);
    await net.fetch(url);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(spec("dexscreener:profiles").cacheMs + 100);
    await net.fetch(url);
    expect(calls).toBe(2);
  });

  it("Pump is not a limited host", () => {
    expect(bucketFor("wss://pumpportal.fun/api/data")).toBeNull();
  });
});

describe("v12.1 batching", () => {
  it("batches enrichment DexScreener lookups 30 per /tokens/v1 call", async () => {
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      const batcher = new DexTokenBatcher((async (url: string) => {
        urls.push(url);
        const mints = url.split("/").pop()!.split(",");
        return Response.json(mints.map((m) => ({ chainId: "solana", baseToken: { address: m }, priceUsd: "1" })));
      }) as unknown as typeof fetch);
      const mints = Array.from({ length: 45 }, (_, i) => `Mint${i}`);
      const all = Promise.all([...mints, "Mint0"].map((m) => batcher.get(m)));
      await vi.advanceTimersByTimeAsync(1_000);
      const got = await all;
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain("/tokens/v1/solana/");
      expect(urls[0]!.split("/").pop()!.split(",")).toHaveLength(30);
      expect((got[7] as { pairs: Array<{ baseToken: { address: string } }> }).pairs[0]!.baseToken.address).toBe("Mint7");
      expect(got[45]).toEqual(got[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Jupiter price ids go 50 per call, DexScreener 30 per call, duplicates dropped", async () => {
    const jup: string[] = [];
    const dex: string[] = [];
    const mints = Array.from({ length: 120 }, (_, i) => `M${i}`);
    await fetchJupiterQuotes([...mints, ...mints.slice(0, 10)], (async (url: string) => {
      jup.push(url);
      return Response.json({});
    }) as unknown as typeof fetch);
    await fetchDexQuotes([...mints, ...mints.slice(0, 10)], (async (url: string) => {
      dex.push(url);
      return Response.json([]);
    }) as unknown as typeof fetch);
    expect(jup).toHaveLength(3);
    expect(jup[0]).toContain("https://api.jup.ag/price/v3?ids=");
    expect(dex).toHaveLength(4);
  });
});

describe("v12.1 banner debounce and Scout status", () => {
  it("one 429 is backing off, not a banner; 2 minutes of failures is down plus a banner; a success clears it", () => {
    const h = new FeedHealth();
    const t0 = 1_000_000;
    h.fail("gecko", "HTTP 429", t0);
    let st = h.status("gecko", { enabled: true, buckets: [], now: t0 + 60_000 });
    expect(st.state).toBe("backoff");
    expect(h.banner([st], t0 + 60_000)).toBeUndefined();
    st = h.status("gecko", { enabled: true, buckets: [], now: t0 + BANNER_AFTER_MS + 1_000 });
    expect(st.state).toBe("down");
    expect(h.banner([st], t0 + BANNER_AFTER_MS + 1_000)).toContain("GeckoTerminal failing for 2 min (HTTP 429)");
    h.ok("gecko", t0 + BANNER_AFTER_MS + 2_000);
    st = h.status("gecko", { enabled: true, buckets: [], now: t0 + BANNER_AFTER_MS + 3_000 });
    expect(st.state).toBe("live");
    expect(h.banner([st], t0 + BANNER_AFTER_MS + 3_000)).toBeUndefined();
  });

  it("a source that is turned off never banners", () => {
    const h = new FeedHealth();
    h.fail("dexpaprika", "HTTP 500", 0);
    const st = h.status("dexpaprika", { enabled: false, buckets: [], now: 600_000 });
    expect(st.state).toBe("off");
    expect(h.banner([st], 600_000)).toBeUndefined();
  });

  it("shows the backoff countdown target from the shared limiter", () => {
    const net = new NetLimiter({ clock: { now: () => 5_000, random: () => 0.5 } });
    net.note429(spec("gecko"), 30_000);
    const h = new FeedHealth();
    h.fail("gecko", "HTTP 429", 5_000);
    const st = h.status("gecko", { enabled: true, buckets: net.stats(), now: 5_000 });
    expect(st.state).toBe("backoff");
    expect(st.retryAt).toBe(35_000);
    expect(st.count429).toBe(1);
    expect(st.limitPerMin).toBe(5);
    expect(st.budgetPerMin).toBe(4);
  });

  it("DexPaprika: new pools/search shape parses, SOL-first pools skip the SOL price", () => {
    const rows = parseDexPaprika({
      results: [
        { id: "p1", dex_name: "Pump.fun", price_usd: 95, tokens: [{ id: SOL }, { id: "CoinMint1111111111111111111111111111111111" }] },
        { id: "p2", dex_name: "Meteora", price_usd: 0.02, tokens: [{ id: "CoinMint2222222222222222222222222222222222" }, { id: SOL }] }
      ]
    });
    expect(rows.map((r) => r.mint)).toEqual(["CoinMint1111111111111111111111111111111111", "CoinMint2222222222222222222222222222222222"]);
    expect(rows[0]?.priceUsd).toBeUndefined();
    expect(rows[1]?.priceUsd).toBe(0.02);
    expect(DEXPAPRIKA_NEW_URL).toContain("/networks/solana/pools/search");
  });

  it("DexPaprika 410 marks it down once, no banner, no re-poll for 30 minutes, toggle untouched", async () => {
    let calls = 0;
    const net = new NetLimiter({ fetchImpl: (async () => { calls += 1; return Response.json({ error: "endpoint_removed" }, { status: 410 }); }) as unknown as typeof fetch });
    const scout = new Scout({ bus: new EventBus<DeskEvents>(), feedMode: "live", demo: false, pumpWsUrl: "ws://x", net, onStatus: () => undefined });
    scout.setSources({ dexpaprika: true });
    const s = scout as unknown as { pollDexPaprika: (url: string) => Promise<void> };
    await s.pollDexPaprika(DEXPAPRIKA_NEW_URL);
    await s.pollDexPaprika(DEXPAPRIKA_NEW_URL);
    expect(calls).toBe(1);
    const report = scout.report(Date.now() + GONE_RECHECK_MS - 1_000);
    const src = report.sources!.find((x) => x.id === "dexpaprika")!;
    expect(src.state).toBe("down");
    expect(src.enabled).toBe(true);
    expect(src.detail).toContain("410");
    expect(report.lastError).toBeUndefined();
    scout.stop();
  });

  it("Scout reports every source; Bitquery without a key is off, not an error", () => {
    const scout = new Scout({ bus: new EventBus<DeskEvents>(), feedMode: "live", demo: false, pumpWsUrl: "ws://x", net: new NetLimiter(), onStatus: () => undefined });
    const report = scout.report();
    expect(report.sources!.map((s) => s.id)).toEqual(["pump", "pumpapi", "launchlab", "dexscreener", "jupiter", "gecko", "dexpaprika", "bitquery", "solana"]);
    expect(report.sources!.find((s) => s.id === "solana")?.enabled).toBe(true);
    expect(report.sources!.find((s) => s.id === "bitquery")).toMatchObject({ state: "off", detail: "no API key" });
    expect(report.budgets!.length).toBeGreaterThanOrEqual(9);
    scout.stop();
  });

  it("feed stays fast: DexScreener lists and Jupiter poll at least as often as v12, Gecko inside its budget", () => {
    expect(SCOUT_POLL_MS.dexProfiles).toBeLessThanOrEqual(20_000);
    expect(SCOUT_POLL_MS.dexBoostsLatest).toBeLessThanOrEqual(20_000);
    expect(SCOUT_POLL_MS.jupiterRecent).toBeLessThanOrEqual(20_000);
    const geckoPerMin = 60_000 / SCOUT_POLL_MS.geckoNew + 60_000 / SCOUT_POLL_MS.geckoTrending;
    expect(geckoPerMin).toBeLessThanOrEqual(spec("gecko").budgetPerMin);
    for (const [key, id] of [["dexProfiles", "dexscreener:profiles"], ["dexBoostsLatest", "dexscreener:boosts-latest"], ["dexBoostsTop", "dexscreener:boosts-top"], ["dexTakeovers", "dexscreener:takeovers"]] as const) {
      expect(60_000 / SCOUT_POLL_MS[key]).toBeLessThanOrEqual(spec(id).budgetPerMin);
    }
    const paprika = 60_000 / SCOUT_POLL_MS.dexPaprikaNew + 60_000 / SCOUT_POLL_MS.dexPaprikaTop;
    expect(paprika).toBeLessThanOrEqual(spec("dexpaprika").budgetPerMin);
  });
});

describe("v12.1 desk snapshot", () => {
  it("the snapshot feed carries every source and the shared budgets, with no banner on a fresh desk", async () => {
    const { testDesk } = await import("./helpers.js");
    const desk = testDesk();
    try {
      const feed = desk.snapshot().feed;
      expect(feed.sources?.map((s) => s.id)).toEqual(["pump", "pumpapi", "launchlab", "dexscreener", "jupiter", "gecko", "dexpaprika", "bitquery", "solana"]);
      expect(feed.budgets?.find((b) => b.id === "gecko")?.budgetPerMin).toBe(4);
      expect(feed.lastError).toBeUndefined();
    } finally {
      desk.stop();
    }
  });
});

describe("v12.1 optional keys", () => {
  it("a rejected Bitquery key (HTTP 402) is down with a reason, never a banner, and is not hammered", async () => {
    let calls = 0;
    const net = new NetLimiter({ fetchImpl: (async () => { calls += 1; return new Response("", { status: 402 }); }) as unknown as typeof fetch });
    const scout = new Scout({ bus: new EventBus<DeskEvents>(), feedMode: "live", demo: false, pumpWsUrl: "ws://x", bitqueryKey: "k", net, onStatus: () => undefined });
    const s = scout as unknown as { pollBitquery: () => Promise<void> };
    await s.pollBitquery();
    await s.pollBitquery();
    expect(calls).toBe(1);
    const report = scout.report(Date.now() + 10 * 60_000);
    expect(report.sources!.find((x) => x.id === "bitquery")).toMatchObject({ state: "down", detail: "key or plan rejected (HTTP 402)" });
    expect(report.lastError).toBeUndefined();
    scout.stop();
  });
});
