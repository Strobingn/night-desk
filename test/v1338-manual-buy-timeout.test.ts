import { describe, expect, it } from "vitest";
import { Desk } from "../src/desk/orchestrator.js";
import { testConfig } from "./helpers.js";

/** Same ceiling as BuyRoute.PAPER_BUY_TIMEOUT_SEC on the phone. */
const PAPER_BUY_TIMEOUT_MS = 12_000;
const MINT = "DacityTest111111111111111111111111111pump";

function neverResolve<T>(): Promise<T> {
  return new Promise(() => {});
}

function jupiterAndHang(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("api.jup.ag/price")) {
    return Promise.resolve(
      Response.json({
        [MINT]: { usdPrice: 0.00193, liquidity: 298_700 }
      })
    );
  }
  // A saturated Helius / Dex / other read never comes back.
  return neverResolve();
}

describe("v13.38 manual buy timeout caps", () => {
  it("paper-fills an unenriched pump coin inside the 12s client timer while Helius is saturated", async () => {
    const desk = new Desk(testConfig({ feedMode: "live", demoFeed: false }), {
      lookupFetch: jupiterAndHang as typeof fetch,
      chainFetch: (() => neverResolve()) as typeof fetch,
      launchBundle: () => neverResolve()
    });
    try {
      desk.noteRawSighting({
        mint: MINT,
        symbol: "Dacity",
        name: "Dacity",
        source: "pumpfun",
        observedAt: Date.now(),
        priceUsd: 0.00193,
        volume1hUsd: 298_700
      });
      const row = desk.snapshot().rawTape?.find((item) => item.mint === MINT);
      expect(row?.enrich).toBe("pending");
      expect(desk.snapshot().positions).toHaveLength(0);

      const started = Date.now();
      const bought = await desk.manualBuy(MINT, 100, { book: "paper", confirmHardKill: true });
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(PAPER_BUY_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(5_000);
      expect(bought).toMatchObject({ ok: true, mint: MINT, symbol: "Dacity", sizeUsd: 100, mode: "paper" });
      expect(desk.book.positions.get(MINT)?.costUsd).toBe(100);
    } finally {
      desk.stop();
    }
  });

  it("refuses an unenriched pump coin quickly when the quote and the curve both sit in a saturated Helius queue", async () => {
    const desk = new Desk(testConfig({ feedMode: "live", demoFeed: false }), {
      lookupFetch: (() => neverResolve()) as typeof fetch,
      chainFetch: (() => neverResolve()) as typeof fetch,
      launchBundle: () => neverResolve()
    });
    try {
      desk.noteRawSighting({
        mint: MINT,
        symbol: "Dacity",
        name: "Dacity",
        source: "pumpfun",
        observedAt: Date.now(),
        priceUsd: 0.00193
      });
      const started = Date.now();
      const result = await desk.manualBuy(MINT, 100, { book: "paper", confirmHardKill: true });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(PAPER_BUY_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(7_000);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("PRICE_UNAVAILABLE");
      expect(desk.book.positions.has(MINT)).toBe(false);
    } finally {
      desk.stop();
    }
  });
});
