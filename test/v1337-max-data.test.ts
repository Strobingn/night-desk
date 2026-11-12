import { describe, expect, it } from "vitest";
import { enrichSighting } from "../src/market/enrich.js";
import { parseRugcheckReport, parseTop10Pct } from "../src/market/parsers.js";

const MINT = "5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump";
const PUMP = "Eoe22HdCa9rhtBwKL6nNZmZxfuzF35xkxobcvfaF1vWQ";
const DAMM = "fVXfYwyDsnHkhiFYXzWqVM8j5kDeGqPdU6xQ3actds7";
const NO_LP = "11111111111111111111111111111111";

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    address: `Acct${i}111111111111111111111111111111111`,
    owner: `Owner${i}11111111111111111111111111111111`,
    uiAmount: 10
  }));
}

describe("v13.37 Max pool and holder data", () => {
  it("does not treat a figure-less DAMM v2 pool as an unlock when a traditional pool has a lock", () => {
    const report = parseRugcheckReport({
      totalHolders: 28000,
      markets: [
        {
          marketType: "pump_fun_amm",
          pubkey: PUMP,
          lp: { lpMint: "GBSnDNCoPsAMDkFTF6EseMsCRGMvAaYk9cfQ2wYU1Ahi", lpLockedPct: 99.99 }
        },
        {
          marketType: "meteora_damm_v2",
          pubkey: DAMM,
          lp: { lpMint: NO_LP, lpLockedPct: 0 }
        }
      ]
    });
    expect(report.lpLockedOrBurned).toBe(true);
    expect(report.lpPool).toMatch(/pump_fun_amm/);
    expect(report.lpPool).not.toMatch(/damm/);
    expect(report.totalHolders).toBe(28000);
  });

  it("ranks the deepest traditional pool by RugCheck reserve depth and ignores DAMM v2", () => {
    const locked = parseRugcheckReport({
      markets: [
        {
          marketType: "pump_fun_amm",
          pubkey: PUMP,
          lp: { lpMint: "GBSnDNCoPsAMDkFTF6EseMsCRGMvAaYk9cfQ2wYU1Ahi", lpLockedPct: 99.99, baseUSD: 92654, quoteUSD: 91925 }
        },
        {
          marketType: "meteora_damm_v2",
          pubkey: DAMM,
          lp: { lpMint: NO_LP, lpLockedPct: 0, baseUSD: 2.4, quoteUSD: 5.3 }
        }
      ]
    });
    expect(locked.lpLockedOrBurned).toBe(true);
    expect(locked.lpPool).toContain(PUMP.slice(0, 4));

    const deeperUnlock = parseRugcheckReport({
      markets: [
        {
          marketType: "pump_fun_amm",
          pubkey: PUMP,
          lp: { lpMint: "GBSnDNCoPsAMDkFTF6EseMsCRGMvAaYk9cfQ2wYU1Ahi", lpLockedPct: 100, baseUSD: 1000, quoteUSD: 1000 }
        },
        {
          marketType: "raydium_cpmm",
          pubkey: "9JNxjchHcNekGzqHVZPFcqgE5N7YCU69wtRQG12ev4Yc",
          lp: { lpMint: "32b1Y7Z4U2cY7bjNRdgDgZcnQ1ugRvKNzjH2QkyY6kbh", lpLockedPct: 0, baseUSD: 40000, quoteUSD: 40000 }
        }
      ]
    });
    expect(deeperUnlock.lpLockedOrBurned).toBe(false);
    expect(deeperUnlock.lpPool).toMatch(/raydium_cpmm/);
  });

  it("does not publish a top-20 sample as the holder total", () => {
    const sample = parseTop10Pct({ value: rows(17) }, 1_000_000);
    expect(sample.holderCount).toBeNull();
    expect(sample.top10HolderPct).not.toBeNull();
    expect(parseRugcheckReport({ totalHolders: 0 }).totalHolders).toBeNull();
    expect(parseRugcheckReport({}).totalHolders).toBeNull();
  });

  it("keeps RugCheck totalHolders when the largest-accounts page is short", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("dexscreener")) return Response.json({ pairs: [] });
      if (url.includes("/report")) {
        return Response.json({
          totalHolders: 28000,
          markets: [
            {
              marketType: "pump_fun_amm",
              pubkey: PUMP,
              lp: { lpMint: "GBSnDNCoPsAMDkFTF6EseMsCRGMvAaYk9cfQ2wYU1Ahi", lpLockedPct: 100, baseUSD: 90_000, quoteUSD: 90_000 }
            },
            { marketType: "meteora_damm_v2", pubkey: DAMM, lp: { lpMint: NO_LP, lpLockedPct: 0 } }
          ]
        });
      }
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      if (method === "getAccountInfo") {
        return Response.json({
          result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, supply: "1000000000000", decimals: 6 } } } } }
        });
      }
      if (method === "getTokenLargestAccounts") {
        return Response.json({ result: { value: rows(17).map((row) => ({ ...row, decimals: 6 })) } });
      }
      return Response.json({
        result: { value: rows(17).map(() => ({ data: { parsed: { info: { owner: "Retail111111111111111111111111111111111" } } } })) }
      });
    };
    const token = await enrichSighting(
      { mint: MINT, source: "pumpfun", observedAt: 1 },
      { rpcUrl: "https://solana-mainnet.g.alchemy.com/v2/supersecretkey", rugcheckUrl: "https://rugcheck.test/v1", fetchImpl }
    );
    expect(token.holderCount).toBe(28000);
    expect(token.holderCountAtLeast).toBe(false);
    expect(token.lpLockedOrBurned).toBe(true);
    expect(token.lpLockPool).toMatch(/pump_fun_amm/);
  });
});
