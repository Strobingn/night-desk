import { describe, expect, it } from "vitest";
import { Desk } from "../src/desk/orchestrator.js";
import { BUCKETS, NetLimiter } from "../src/market/net.js";
import { formatBalanceUsd, liveCashLabel } from "../web/src/format.js";
import { makeToken } from "../src/demo/tokens.js";
import { testConfig } from "./helpers.js";

const WSOL = "So11111111111111111111111111111111111111112";
const MINT = "SolMark1111111111111111111111111111111111";

describe("v13.26 SOL/USD on the wallet snapshot", () => {
  it("renders SOL, its dollar estimate, and sub-cent USDC from a cached price", async () => {
    const priceFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("dexscreener.com")) {
        return Response.json([
          {
            baseToken: { address: MINT },
            quoteToken: { address: WSOL },
            priceUsd: "0.0008624",
            priceNative: "0.00001",
            liquidity: { usd: 180_000 }
          }
        ]);
      }
      if (url.includes("api.jup.ag/price") && url.includes(WSOL)) {
        return Response.json({ [WSOL]: { usdPrice: 86.24 } });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const cfg = testConfig();
    const desk = new Desk(cfg, {
      priceFetch,
      walletBalances: async () => ({ sol: 0.2951, usdc: 0.001008, at: Date.now(), error: null })
    });
    try {
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "MARK", priceUsd: 0.0008624, liquidityUsd: 180_000, source: "raydium" }));
      await desk.repricePositions();
      await desk.refreshWallet();
      const wallet = desk.snapshot().wallet;
      expect(wallet?.solBalance).toBe(0.2951);
      expect(wallet?.solPriceUsd).toBeCloseTo(86.24, 2);
      expect(wallet?.solPriceAt).toBeGreaterThan(0);
      const strip = liveCashLabel({
        sol: wallet?.solBalance,
        solUsd: wallet?.solPriceUsd,
        usdc: wallet?.usdcBalance,
        cashKnown: true
      });
      expect(strip).toContain("0.2951 SOL · ~$25.45");
      expect(strip).toContain("USDC $0.0010");
      const funded = liveCashLabel({ sol: 0.2951, solUsd: 86.24, usdc: 25, cashKnown: true });
      expect(funded).toContain("0.2951 SOL · ~$25.45");
      expect(funded).toContain("USDC $25.00");
      expect(formatBalanceUsd(0.001008)).toBe("$0.0010");
    } finally {
      desk.stop();
    }

    const idle = new Desk(testConfig({ feedMode: "live" }), { lookupFetch: priceFetch });
    try {
      await idle.refreshDisplaySol();
      expect(idle.snapshot().wallet?.solPriceUsd).toBeCloseTo(86.24, 2);
    } finally {
      idle.stop();
    }

    const again = new Desk({ ...cfg, resetPaper: false }, { priceFetch: (async () => new Response("{}", { status: 404 })) as typeof fetch });
    try {
      expect(again.snapshot().wallet?.solPriceUsd).toBeCloseTo(86.24, 2);
      expect(again.snapshot().wallet?.solPriceAt).toBeGreaterThan(0);
    } finally {
      again.stop();
    }
  });
});

describe("v13.26 Helius sliding minute", () => {
  it("never lets the read and exec lanes add up to more than 18 in one minute", async () => {
    const read = BUCKETS.find((row) => row.id === "helius")!;
    const exec = BUCKETS.find((row) => row.id === "helius:exec")!;
    expect(read.budgetPerMin).toBe(10);
    expect(exec.budgetPerMin).toBe(8);
    expect(read.budgetPerMin + exec.budgetPerMin).toBe(18);

    let now = 0;
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
      fetchImpl: (async () => {
        const rows = net.stats().filter((row) => row.id === "helius" || row.id === "helius:exec");
        const readCount = rows.find((row) => row.id === "helius")?.reqLastMin ?? 0;
        const execCount = rows.find((row) => row.id === "helius:exec")?.reqLastMin ?? 0;
        expect(readCount).toBeLessThanOrEqual(10);
        expect(execCount).toBeLessThanOrEqual(8);
        expect(readCount + execCount).toBeLessThanOrEqual(18);
        return Response.json({ jsonrpc: "2.0", result: { value: 1 } });
      }) as typeof fetch
    });
    const url = "https://mainnet.helius-rpc.com/?api-key=test";
    const balance = (i: number) => JSON.stringify({ jsonrpc: "2.0", id: i, method: "getBalance", params: [String(i)] });
    const sim = (i: number) => JSON.stringify({ jsonrpc: "2.0", id: i, method: "simulateTransaction", params: [String(i)] });
    for (let i = 0; i < 25; i += 1) {
      await net.fetchAt(0)(url, { method: "POST", body: balance(i) });
      await net.fetchAt(1)(url, { method: "POST", body: sim(i) });
    }
    const rows = net.stats().filter((row) => row.id === "helius" || row.id === "helius:exec");
    expect((rows.find((row) => row.id === "helius")?.reqLastMin ?? 0) + (rows.find((row) => row.id === "helius:exec")?.reqLastMin ?? 0)).toBeLessThanOrEqual(18);
  });
});
