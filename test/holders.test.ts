import { describe, expect, it } from "vitest";
import { evaluateFilter } from "../src/agents/filter.js";
import { makeToken } from "../src/demo/tokens.js";
import { pumpReserveAddresses, RESERVE_OWNER_SET } from "../src/market/exclusions.js";
import { parseRugcheckReport, parseTop10Pct } from "../src/market/parsers.js";
import { resolveRules } from "../src/rules.js";

const rules = resolveRules({});
const mint = "So11111111111111111111111111111111111111112";

describe("Pump reserve exclusion", () => {
  it("drops the bonding-curve vault before the top-10 percent", () => {
    const reserves = pumpReserveAddresses(mint);
    expect(reserves.length).toBeGreaterThan(0);
    const curve = reserves[0]!;
    const parsed = parseTop10Pct(
      {
        value: [
          { address: "CurveAta1111111111111111111111111111111111", owner: curve, uiAmount: 900_000 },
          { address: "RetailA11111111111111111111111111111111111", owner: "WalletA11111111111111111111111111111111111", uiAmount: 40_000 },
          { address: "RetailB11111111111111111111111111111111111", owner: "WalletB11111111111111111111111111111111111", uiAmount: 20_000 },
          { address: "RaydiumVault111111111111111111111111111111", owner: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", uiAmount: 30_000 }
        ]
      },
      1_000_000,
      { addresses: new Set(reserves), owners: RESERVE_OWNER_SET }
    );
    expect(parsed.excludedReserves).toBe(2);
    expect(parsed.top10HolderPct).toBeCloseTo(0.06, 8);
    expect(parsed.holderCount).toBeNull();
  });

  it("treats a curve-only largest-account list as measured, not missing", () => {
    const [curve] = pumpReserveAddresses(mint);
    const parsed = parseTop10Pct(
      { value: [{ address: "OnlyCurve", owner: curve, uiAmount: 1_000_000 }] },
      1_000_000,
      { addresses: new Set(pumpReserveAddresses(mint)), owners: RESERVE_OWNER_SET }
    );
    expect(parsed.top10HolderPct).toBe(0);
    expect(parsed.excludedReserves).toBe(1);
  });

  it("fails closed when there are no holder rows", () => {
    expect(parseTop10Pct({ value: [] }, 1_000_000).top10HolderPct).toBeNull();
    expect(parseTop10Pct(null, 1_000_000).top10HolderPct).toBeNull();
  });

  it("prefers RugCheck holders once reserves are labeled and removed", () => {
    const [curve] = pumpReserveAddresses(mint);
    const report = parseRugcheckReport(
      {
        topHolders: [
          { address: curve, pct: 92, label: "bonding curve" },
          { address: "RetailA11111111111111111111111111111111111", pct: 4 },
          { address: "RetailB11111111111111111111111111111111111", pct: 3 }
        ]
      },
      mint
    );
    expect(report.holdersExcludeReserves).toBe(true);
    expect(report.top10HolderPct).toBeCloseTo(0.07, 8);
  });

  it("lets a live-style Pump newborn through holder and LP checks when only the vault was concentrated", () => {
    const result = evaluateFilter(
      makeToken({
        source: "pumpfun",
        onBondingCurve: true,
        lpLockedOrBurned: null,
        top10HolderPct: 0.04,
        mintAuthorityRevoked: true,
        volume1hUsd: 50_000
      }),
      { status: "clean" },
      rules
    );
    expect(result.reasons.map((reason) => reason.code)).not.toContain("HOLDER_CONCENTRATION");
    expect(result.reasons.map((reason) => reason.code)).not.toContain("LP_NOT_LOCKED");
    expect(result.decision).toBe("pass");
  });
});
