import { describe, expect, it } from "vitest";
import { scoreToken } from "../src/agents/analyst.js";
import { makeToken } from "../src/demo/tokens.js";
import { HeldQuoteBook } from "../src/market/dex-prices.js";
import { HELD_MARK_POLL_MS } from "../src/market/position-pricer.js";
import { resolveRules } from "../src/rules.js";
import { testDesk } from "./helpers.js";

const rules = resolveRules({});
const floatMint = "EeMmpB1vpdhoeuK9hytSboS168mhPanoxTX75ajeTwS";

describe("unlocked LP flag and held-mint marks", () => {
  it("polls held marks faster than five seconds", () => {
    expect(HELD_MARK_POLL_MS).toBeLessThanOrEqual(5_000);
    expect(HELD_MARK_POLL_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("rotates to Jupiter after a DexScreener 429 and then stays off the cooled source", async () => {
    const book = new HeldQuoteBook();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes("dexscreener")) return new Response("", { status: 429 });
      return Response.json({ data: { [floatMint]: { price: "0.42" } } });
    }) as typeof fetch;
    const first = await book.fetch([floatMint], fetchImpl, 1_000);
    expect(first.get(floatMint)?.priceUsd).toBe(0.42);
    expect(urls[0]).toContain("dexscreener");
    expect(urls[1]).toContain("api.jup.ag");
    const before = urls.length;
    const second = await book.fetch([floatMint], fetchImpl, 1_000);
    expect(second.get(floatMint)?.priceUsd).toBe(0.42);
    expect(urls.slice(before).every((url) => url.includes("api.jup.ag"))).toBe(true);
  });

  it("does not hammer either source while both are cooling off a 429", async () => {
    const book = new HeldQuoteBook();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("", { status: 429 });
    }) as typeof fetch;
    await expect(book.fetch([floatMint], fetchImpl, 5_000)).rejects.toThrow(/429/);
    expect(calls).toBe(2);
    const quiet = await book.fetch([floatMint], fetchImpl, 5_000);
    expect(quiet.size).toBe(0);
    expect(calls).toBe(2);
  });

  it("auto-buys a lone unlocked LP, badges it, and stops out on the next fresh mark", async () => {
    const desk = testDesk();
    try {
      expect(desk.snapshot().prefs.allowUnlockedLp).toBe(true);
      await desk.submitCandidate(makeToken({ mint: floatMint, symbol: "FLOAT", source: "raydium", lpLockedOrBurned: false }));
      const pos = desk.snapshot().positions.find((row) => row.mint === floatMint);
      expect(pos?.lpUnlocked).toBe(true);
      expect(pos?.entry).toBe("analyst");
      expect(pos?.markAgeMs).toBeGreaterThanOrEqual(0);
      expect(pos?.markAgeMs).toBeLessThan(5_000);
      expect(desk.snapshot().events.some((event) => event.code === "LP_UNLOCKED" && event.message.includes("LP unlocked"))).toBe(true);
      expect(desk.config.rules.stopLossPct).toBe(0.06);
      const stop = pos?.stopPrice ?? 0;
      await desk.markPrice(floatMint, stop * 0.5);
      expect(desk.book.positions.has(floatMint)).toBe(true);
      await desk.markPrice(floatMint, stop * 0.5);
      expect(desk.book.positions.has(floatMint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "STOP_LOSS")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("still kills unlocked LP when another hard gate fails, or when the setting is off", async () => {
    const desk = testDesk();
    try {
      const rugMint = "RugMint111111111111111111111111111111111111";
      await desk.submitCandidate(
        makeToken({ mint: rugMint, symbol: "RUGGED", lpLockedOrBurned: false, mintAuthorityRevoked: false, source: "raydium" })
      );
      expect(desk.book.positions.has(rugMint)).toBe(false);
      const turnedOff = desk.updateSettings({ allowUnlockedLp: false });
      expect(turnedOff.ok).toBe(true);
      if (turnedOff.ok) expect(turnedOff.settings.allowUnlockedLp).toBe(false);
      expect(desk.snapshot().prefs.allowUnlockedLp).toBe(false);
      const again = "OffMint11111111111111111111111111111111111";
      await desk.submitCandidate(makeToken({ mint: again, symbol: "OFF", lpLockedOrBurned: false, source: "raydium" }));
      expect(desk.book.positions.has(again)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.mint === again && event.code === "LP_NOT_LOCKED")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("prices a held mint from the position poll and fires the hard stop without waiting on scout", async () => {
    const mint = "HeldMint11111111111111111111111111111111111";
    let price = "0.001";
    const desk = testDesk(
      {},
      {
        priceFetch: (async (url: string) => {
          if (String(url).includes("dexscreener")) {
            return Response.json([{ baseToken: { address: mint }, priceUsd: price, liquidity: { usd: 80_000 } }]);
          }
          return Response.json({ data: {} });
        }) as typeof fetch
      }
    );
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "GROKNAM", source: "pumpfun", priceUsd: 0.001, priceFeed: "dexscreener" }));
      const open = desk.snapshot().positions.find((row) => row.mint === mint);
      expect(open).toBeTruthy();
      price = String((open?.stopPrice ?? 0) * 0.5);
      await desk.repricePositions();
      expect(desk.book.positions.has(mint)).toBe(true);
      await desk.repricePositions();
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "STOP_LOSS" && event.symbol === "GROKNAM")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("stores the analyst score on a manual buy instead of zero", async () => {
    const mint = "ManualScoreMint111111111111111111111111111";
    const token = makeToken({
      mint,
      symbol: "FLOAT",
      source: "raydium",
      volume1hUsd: 2_500,
      priceUsd: 1,
      liquidityUsd: 100_000
    });
    const expected = scoreToken(token, rules).score;
    expect(expected).toBeGreaterThan(0);
    const desk = testDesk();
    try {
      await desk.submitCandidate(token);
      expect(desk.book.positions.has(mint)).toBe(false);
      const bought = await desk.manualBuy(mint, 10);
      expect(bought.ok).toBe(true);
      const pos = desk.snapshot().positions.find((row) => row.mint === mint);
      expect(pos?.score).toBeCloseTo(expected, 6);
      expect(pos?.score).not.toBe(0);
      expect(pos?.entry).toBe("manual");
    } finally {
      desk.stop();
    }
  });
});
