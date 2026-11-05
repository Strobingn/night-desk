import { describe, expect, it } from "vitest";
import { enrichSighting } from "../src/market/enrich.js";
import { parseDexListings, parseGeckoPools, parseJupiterRecent } from "../src/market/listings.js";
import { pairHourVolume, parseDexPair } from "../src/market/parsers.js";

const MINT = "Mint111111111111111111111111111111111111111";
const SOL = "So11111111111111111111111111111111111111112";

describe("listing parsers", () => {
  it("keeps Solana mints from DexScreener boost and profile rows", () => {
    const rows = parseDexListings([
      { chainId: "solana", tokenAddress: MINT, description: "A new pool" },
      { chainId: "ethereum", tokenAddress: "0xabc" },
      { chainId: "solana", tokenAddress: SOL }
    ]);
    expect(rows.map((row) => row.mint)).toEqual([MINT]);
  });

  it("reads GeckoTerminal new pools and skips the quote mint", () => {
    const rows = parseGeckoPools({
      data: [
        {
          attributes: {
            name: "DOGE / SOL",
            base_token_price_usd: "0.002",
            reserve_in_usd: "40000",
            volume_usd: { h1: "18500.5" }
          },
          relationships: {
            base_token: { data: { id: `solana_${MINT}` } },
            dex: { data: { id: "pump-fun" } }
          }
        }
      ]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mint: MINT,
      symbol: "DOGE",
      source: "pumpfun",
      volume1hUsd: 18500.5,
      priceUsd: 0.002,
      liquidityUsd: 40000
    });
  });

  it("sums Jupiter recent 1h buy and sell volume", () => {
    const rows = parseJupiterRecent([
      {
        id: MINT,
        symbol: "NEW",
        name: "New",
        launchpad: "pump.fun",
        usdPrice: 0.0004,
        liquidity: 9000,
        stats1h: { buyVolume: 700, sellVolume: 300 }
      }
    ]);
    expect(rows[0]).toMatchObject({ mint: MINT, source: "pumpfun", volume1hUsd: 1000, priceUsd: 0.0004 });
  });

  it("uses DexScreener h1 when any pool has it, and h24 for a pool younger than an hour", () => {
    const now = 1_700_000_000_000;
    const young = pairHourVolume({ pairCreatedAt: now - 10 * 60_000, volume: { h1: 0, h24: 4200 } }, now);
    const old = pairHourVolume({ pairCreatedAt: now - 3 * 60 * 60_000, volume: { h1: 0, h24: 9000 } }, now);
    expect(young).toBe(4200);
    expect(old).toBe(0);
    const parsed = parseDexPair(
      {
        pairs: [
          {
            chainId: "solana",
            dexId: "raydium",
            priceUsd: "1",
            pairCreatedAt: now,
            baseToken: { address: MINT, symbol: "DEEP", name: "Deep" },
            liquidity: { usd: 80_000 },
            volume: { h1: 0, h24: 0 }
          },
          {
            chainId: "solana",
            dexId: "pumpfun",
            priceUsd: "1",
            pairCreatedAt: now,
            baseToken: { address: MINT, symbol: "THIN", name: "Thin" },
            liquidity: { usd: 2_000 },
            volume: { h1: 6400 }
          }
        ]
      },
      MINT
    );
    expect(parsed?.liquidityUsd).toBe(80_000);
    expect(parsed?.volume1hUsd).toBe(6400);
  });

  it("keeps a listing's 1h volume when the pair lookup is still empty", async () => {
    const token = await enrichSighting(
      { mint: MINT, symbol: "LIST", source: "pumpfun", observedAt: Date.now(), volume1hUsd: 2200, priceUsd: 0.01, liquidityUsd: 5000 },
      { fetchImpl: async () => Response.json({ pairs: null }) }
    );
    expect(token.volume1hUsd).toBe(2200);
    expect(token.priceUsd).toBe(0.01);
    expect(token.liquidityUsd).toBe(5000);
  });
});
