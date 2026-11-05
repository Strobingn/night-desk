import { describe, expect, it } from "vitest";
import { quotePaperSell } from "../src/agents/execution-math.js";
import { makeToken } from "../src/demo/tokens.js";
import { parseJupiterPrices } from "../src/market/dex-prices.js";
import { markUnusable, needsShockConfirm, sameMarkSource } from "../src/market/mark-guard.js";
import { testDesk } from "./helpers.js";

const mint = "CmoMint11111111111111111111111111111111111";

describe("marks that cannot stop a position", () => {
  it("treats 0, negative, and NaN as unusable", () => {
    expect(markUnusable(0)).toBe(true);
    expect(markUnusable(-1)).toBe(true);
    expect(markUnusable(Number.NaN)).toBe(true);
    expect(markUnusable(0.00005607)).toBe(false);
  });

  it("refuses a different pool or feed than the entry", () => {
    const anchor = { priceFeed: "jupiter", source: "pumpfun" };
    expect(sameMarkSource(anchor, { feed: "dexscreener", pairAddress: "OTHER" })).toBe(false);
    expect(sameMarkSource(anchor, { feed: "jupiter" })).toBe(true);
    expect(sameMarkSource({ priceFeed: "dexscreener", pairAddress: "PAIR" }, { feed: "dexscreener", pairAddress: "DUST" })).toBe(false);
    expect(sameMarkSource({ priceFeed: "dexscreener", pairAddress: "PAIR" }, { feed: "dexscreener", pairAddress: "PAIR" })).toBe(true);
    expect(sameMarkSource({ source: "pumpfun" }, { feed: "jupiter" })).toBe(false);
  });

  it("asks for a second tick only on a >30% gap inside 10 seconds", () => {
    const opened = 1_000;
    expect(needsShockConfirm(1, 0.5, opened, opened + 2_000)).toBe(true);
    expect(needsShockConfirm(1, 0.93, opened, opened + 2_000)).toBe(false);
    expect(needsShockConfirm(1, 0.5, opened, opened + 11_000)).toBe(false);
  });

  it("does not let a Jupiter dust print or a 0 stop CMO", async () => {
    let dexPrice = "0.00005607";
    const desk = testDesk(
      {},
      {
        priceFetch: (async (url: string) => {
          if (String(url).includes("dexscreener")) {
            return Response.json([
              {
                baseToken: { address: mint },
                priceUsd: dexPrice,
                liquidity: { usd: 180_000 },
                pairAddress: "CURVE",
                dexId: "pumpfun"
              }
            ]);
          }
          return Response.json({ [mint]: { usdPrice: 1e-12, liquidity: 0, decimals: 6 } });
        }) as typeof fetch
      }
    );
    try {
      await desk.submitCandidate(
        makeToken({
          mint,
          symbol: "CMO",
          priceUsd: 0.00005607,
          liquidityUsd: 180_000,
          source: "pumpfun",
          priceFeed: "dexscreener",
          pairAddress: "CURVE",
          dex: "pumpfun"
        })
      );
      expect(desk.book.positions.has(mint)).toBe(true);
      dexPrice = "0.00000000";
      await desk.repricePositions();
      expect(desk.book.positions.has(mint)).toBe(true);
      const ignored = desk.snapshot().events.find((event) => event.code === "PRICE_SOURCE" || event.code === "PRICE_UNUSABLE");
      expect(ignored?.message).toContain("Waiting for a valid mark");
      expect(desk.snapshot().closed).toHaveLength(0);
    } finally {
      desk.stop();
    }
  });

  it("stops a confirmed −6% from the entry pool and holds one unverified crash", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "CMO", priceUsd: 1, liquidityUsd: 180_000, priceFeed: "dexscreener", pairAddress: "CURVE" }));
      const entry = desk.book.positions.get(mint)!.entryPrice;
      await desk.markPrice(mint, entry * 0.5);
      expect(desk.book.positions.has(mint)).toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "PRICE_UNCONFIRMED")).toBe(true);
      await desk.markPrice(mint, entry * 0.93);
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "STOP_LOSS")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("keeps a paper fill above 0 while the pool has liquidity", () => {
    const dust = quotePaperSell(1e-12, 1_000_000, 12_000);
    expect(dust.fillPrice).toBeGreaterThan(0);
    expect(dust.proceedsUsd).toBeGreaterThanOrEqual(0);
    const crushed = quotePaperSell(1, 1_000_000, 10);
    expect(crushed.fillPrice).toBeGreaterThan(0);
  });

  it("reads Jupiter v3 usdPrice and drops a zero price", () => {
    const parsed = parseJupiterPrices(
      {
        [mint]: { usdPrice: 0.00005607, liquidity: 9000, decimals: 6 },
        OTHER: { price: "0" }
      },
      [mint, "OTHER"]
    );
    expect(parsed.get(mint)?.priceUsd).toBeCloseTo(0.00005607, 12);
    expect(parsed.get(mint)?.feed).toBe("jupiter");
    expect(parsed.has("OTHER")).toBe(false);
    const legacy = parseJupiterPrices({ data: { [mint]: { price: "0.42" } } }, [mint]);
    expect(legacy.get(mint)?.priceUsd).toBe(0.42);
  });
});
