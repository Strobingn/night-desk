import { describe, expect, it } from "vitest";
import { evaluateFilter } from "../src/agents/filter.js";
import { makeToken } from "../src/demo/tokens.js";
import { DEMO_RUG_WALLET } from "../src/market/rug-registry.js";
import { resolveRules } from "../src/rules.js";
import type { RugLookup } from "../src/types.js";

const rules = resolveRules({});
const clean: RugLookup = { status: "clean" };
const rugged: RugLookup = { status: "rugged", evidence: "prior rug token DOG" };

describe("Filter hard rules", () => {
  it("passes a token that clears every check", () => {
    const result = evaluateFilter(makeToken(), clean, rules);
    expect(result.decision).toBe("pass");
    expect(result.reasons).toEqual([]);
  });

  it("rejects an active mint authority", () => {
    const result = evaluateFilter(makeToken({ mintAuthorityRevoked: false }), clean, rules);
    expect(result.decision).toBe("reject");
    expect(result.reasons[0]).toMatchObject({
      code: "MINT_AUTHORITY_ACTIVE",
      message: expect.stringContaining("still active")
    });
  });

  it("fails closed when mint authority was not verified", () => {
    const result = evaluateFilter(makeToken({ mintAuthorityRevoked: null }), clean, rules);
    expect(result.reasons.map((r) => r.code)).toContain("MINT_AUTHORITY_ACTIVE");
    expect(result.reasons[0]?.message).toMatch(/Fail closed/);
  });

  it("rejects unlocked LP and unverified LP off the bonding curve", () => {
    expect(evaluateFilter(makeToken({ lpLockedOrBurned: false }), clean, rules).reasons[0]?.code).toBe("LP_NOT_LOCKED");
    expect(evaluateFilter(makeToken({ lpLockedOrBurned: false, onBondingCurve: true }), clean, rules).reasons.map((r) => r.code)).toContain(
      "LP_NOT_LOCKED"
    );
    expect(evaluateFilter(makeToken({ lpLockedOrBurned: null }), clean, rules).reasons.map((r) => r.code)).toContain(
      "LP_NOT_LOCKED"
    );
  });

  it("skips the LP check when a Pump mint is still on the bonding curve and LP is unknown", () => {
    const result = evaluateFilter(
      makeToken({
        source: "pumpfun",
        onBondingCurve: true,
        lpLockedOrBurned: null,
        lpLockPct: null
      }),
      clean,
      rules
    );
    expect(result.decision).toBe("pass");
    expect(result.reasons.map((r) => r.code)).not.toContain("LP_NOT_LOCKED");
    expect(result.checks.find((check) => check.code === "LP_NOT_LOCKED")?.message).toMatch(/bonding curve/);
  });

  it("rejects top 10 holders above 20% and passes at exactly 20%", () => {
    const over = evaluateFilter(makeToken({ top10HolderPct: 0.201 }), clean, rules);
    expect(over.reasons.map((r) => r.code)).toContain("HOLDER_CONCENTRATION");
    expect(over.reasons.find((r) => r.code === "HOLDER_CONCENTRATION")?.message).toMatch(/20\.1%/);
    const exact = evaluateFilter(makeToken({ top10HolderPct: 0.2 }), clean, rules);
    expect(exact.decision).toBe("pass");
    const missing = evaluateFilter(makeToken({ top10HolderPct: null }), clean, rules);
    expect(missing.reasons.map((r) => r.code)).toContain("HOLDER_CONCENTRATION");
  });

  it("rejects volume under $50k and passes at exactly $50k", () => {
    const low = evaluateFilter(makeToken({ volume1hUsd: 49_999 }), clean, rules);
    expect(low.reasons.map((r) => r.code)).toContain("VOLUME_TOO_LOW");
    expect(low.reasons.find((r) => r.code === "VOLUME_TOO_LOW")?.message).toMatch(/\$49,999/);
    expect(evaluateFilter(makeToken({ volume1hUsd: 50_000 }), clean, rules).decision).toBe("pass");
  });

  it("rejects a dev wallet linked to a previous rug", () => {
    const result = evaluateFilter(makeToken({ devWallet: DEMO_RUG_WALLET }), rugged, rules);
    expect(result.decision).toBe("reject");
    expect(result.reasons[0]).toMatchObject({
      code: "DEV_RUG_HISTORY",
      message: expect.stringContaining("prior rug token DOG")
    });
  });

  it("rejects on an upstream rug hint even if the static lookup is clean", () => {
    const result = evaluateFilter(
      makeToken({ devRug: { rugged: true, evidence: "rugcheck creator rug risk" } }),
      clean,
      rules
    );
    expect(result.reasons.map((r) => r.code)).toContain("DEV_RUG_HISTORY");
  });

  it("returns every failed rule, with mint authority first", () => {
    const result = evaluateFilter(
      makeToken({
        mintAuthorityRevoked: false,
        lpLockedOrBurned: false,
        top10HolderPct: 0.8,
        volume1hUsd: 10,
        devWallet: DEMO_RUG_WALLET
      }),
      rugged,
      rules
    );
    expect(result.reasons.map((r) => r.code)).toEqual([
      "MINT_AUTHORITY_ACTIVE",
      "LP_NOT_LOCKED",
      "HOLDER_CONCENTRATION",
      "VOLUME_TOO_LOW",
      "DEV_RUG_HISTORY"
    ]);
  });
});
