import { describe, expect, it } from "vitest";
import { BUCKETS, HELIUS_FRONT_RESERVE, NetLimiter } from "../src/market/net.js";

const HELIUS = "https://mainnet.helius-rpc.com/?api-key=test";
const body = (id: number, method: string) => JSON.stringify({ jsonrpc: "2.0", id, method, params: [`m${id}`] });
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

function limiter() {
  const sent: number[] = [];
  const net = new NetLimiter({
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      sent.push(Number(JSON.parse(String(init?.body)).id));
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }) as typeof fetch
  });
  const background = (id: number) => net.fetch(HELIUS, { method: "POST", body: body(id, "getAccountInfo"), ndPriority: 2 }).catch(() => null);
  const front = (id: number, method: string) => net.fetch(HELIUS, { method: "POST", body: body(id, method), ndPriority: -1, ndReadLane: true });
  const lane = (id: string) => net.stats().find((row) => row.id === id);
  return { net, sent, background, front, lane };
}

describe("v13.46 Helius read lane keeps room for a buy's checks", () => {
  it("sends a buy's safety and bundle reads at once behind a background pile that drained the bucket", async () => {
    const { sent, background, front, lane } = limiter();
    for (let i = 1; i <= 12; i += 1) void background(i);
    await tick();
    expect(sent).toEqual([1, 2, 3]); // burst 3, bucket now empty, nine still queued
    const started = Date.now();
    await front(101, "getAccountInfo");
    await front(102, "getSignaturesForAddress");
    await front(103, "getBlock");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sent.slice(-3)).toEqual([101, 102, 103]);
    expect(lane("helius:exec")?.reqLastMin ?? 0).toBe(0); // no swap slot used
  });

  it("never lets priority -1 reads pass the 10 a minute ceiling", async () => {
    const { sent, front } = limiter();
    const ceiling = BUCKETS.find((b) => b.id === "helius")!.budgetPerMin;
    for (let i = 1; i <= ceiling + 4; i += 1) void front(i, "getAccountInfo").catch(() => null);
    await tick(60);
    expect(sent.length).toBe(ceiling);
  });

  it("stops background reads short of the ceiling by the reserve", () => {
    let now = 0;
    const sentAt: number[] = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: ((fn: () => void, ms: number) => {
          // Stop the fake clock inside the first minute so the window never slides.
          if (now + ms >= 59_000) return 0;
          now += ms;
          fn();
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async () => {
        sentAt.push(now);
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });
    for (let i = 1; i <= 20; i += 1) void net.fetch(HELIUS, { method: "POST", body: body(i, "getAccountInfo"), ndPriority: 2 }).catch(() => null);
    const ceiling = BUCKETS.find((b) => b.id === "helius")!.budgetPerMin;
    expect(net.stats().find((row) => row.id === "helius")?.reqLastMin).toBe(ceiling - HELIUS_FRONT_RESERVE);
  });

  it("front reads on an empty bucket leave no token debt for the marks behind them", () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const sent: number[] = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: ((fn: () => void, ms: number) => {
          timers.push({ at: now + ms, fn });
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent.push(Number(JSON.parse(String(init?.body)).id));
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });
    const post = (id: number, method: string, ndPriority: -1 | 0 | 2, ndReadLane = false) =>
      void net.fetch(HELIUS, { method: "POST", body: body(id, method), ndPriority, ndReadLane }).catch(() => null);
    for (let i = 1; i <= 3; i += 1) post(i, "getAccountInfo", 2); // drains the burst of 3
    for (let i = 11; i <= 13; i += 1) post(i, "getBlock", -1, true); // three front reads on an empty bucket
    post(21, "getMultipleAccounts", 0); // a mark poll behind them
    const step = () => {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) return false;
      now = Math.max(now, next.at);
      next.fn();
      return true;
    };
    expect(net.stats().find((row) => row.id === "helius")?.reqLastMin).toBe(6); // 3 background, 3 front, mark queued
    while (timers.length && timers.reduce((min, t) => Math.min(min, t.at), Infinity) <= 7_000 && step());
    // One token is 6 s at 10/min. With a debt of three the mark would wait about 24 s.
    expect(net.stats().find((row) => row.id === "helius")?.reqLastMin).toBe(7);
    expect(net.stats().find((row) => row.id === "helius")?.queued).toBe(0);
  });
});
