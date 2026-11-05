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

  it("passes a lone unlocked LP only when the desk allows that flag", () => {
    const unlocked = makeToken({ lpLockedOrBurned: false, symbol: "FLOAT" });
    const blocked = evaluateFilter(unlocked, clean, rules);
    expect(blocked.decision).toBe("reject");
    expect(blocked.reasons.map((reason) => reason.code)).toEqual(["LP_NOT_LOCKED"]);
    const allowed = evaluateFilter(unlocked, clean, rules, { allowUnlockedLp: true });
    expect(allowed.decision).toBe("pass");
    expect(allowed.reasons).toEqual([]);
    expect(allowed.flags).toEqual(["LP_UNLOCKED"]);
    expect(allowed.checks.find((check) => check.code === "LP_NOT_LOCKED")?.pass).toBe(true);
    const withVolume = evaluateFilter(makeToken({ lpLockedOrBurned: false, volume1hUsd: 1_000 }), clean, rules, { allowUnlockedLp: true });
    expect(withVolume.decision).toBe("reject");
    expect(withVolume.reasons.map((reason) => reason.code)).toEqual(["LP_NOT_LOCKED", "VOLUME_TOO_LOW"]);
    const withMint = evaluateFilter(makeToken({ lpLockedOrBurned: false, mintAuthorityRevoked: false }), clean, rules, { allowUnlockedLp: true });
    expect(withMint.decision).toBe("reject");
    expect(withMint.flags).toBeUndefined();
    expect(withMint.reasons.map((reason) => reason.code)).toContain("MINT_AUTHORITY_ACTIVE");
    const unknownLp = evaluateFilter(makeToken({ lpLockedOrBurned: null }), clean, rules, { allowUnlockedLp: true });
    expect(unknownLp.decision).toBe("reject");
    expect(unknownLp.reasons.map((reason) => reason.code)).toContain("LP_NOT_LOCKED");
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

  it("rejects top 10 holders above 35% and passes at exactly 35%", () => {
    expect(rules.maxTop10Pct).toBe(0.35);
    const over = evaluateFilter(makeToken({ top10HolderPct: 0.351 }), clean, rules);
    expect(over.reasons.map((r) => r.code)).toContain("HOLDER_CONCENTRATION");
    expect(over.reasons.find((r) => r.code === "HOLDER_CONCENTRATION")?.message).toMatch(/35\.1%/);
    const exact = evaluateFilter(makeToken({ top10HolderPct: 0.35 }), clean, rules);
    expect(exact.decision).toBe("pass");
    const inside = evaluateFilter(makeToken({ top10HolderPct: 0.33 }), clean, rules);
    expect(inside.reasons.map((r) => r.code)).not.toContain("HOLDER_CONCENTRATION");
    const missing = evaluateFilter(makeToken({ top10HolderPct: null }), clean, rules);
    expect(missing.reasons.map((r) => r.code)).toContain("HOLDER_CONCENTRATION");
    expect(resolveRules({ MAX_TOP10_PCT: "0.5" }).maxTop10Pct).toBe(0.35);
    expect(resolveRules({ MAX_TOP10_PCT: "0.15" }).maxTop10Pct).toBe(0.15);
  });

  it("rejects volume under $10k and passes at exactly $10k", () => {
    expect(rules.minVolume1hUsd).toBe(10_000);
    const low = evaluateFilter(makeToken({ volume1hUsd: 9_999 }), clean, rules);
    expect(low.reasons.map((r) => r.code)).toContain("VOLUME_TOO_LOW");
    expect(low.reasons.find((r) => r.code === "VOLUME_TOO_LOW")?.message).toMatch(/\$9,999/);
    expect(evaluateFilter(makeToken({ volume1hUsd: 10_000 }), clean, rules).decision).toBe("pass");
    expect(resolveRules({ MIN_VOLUME_1H_USD: "1000" }).minVolume1hUsd).toBe(1_000);
    expect(resolveRules({ MIN_VOLUME_1H_USD: "50" }).minVolume1hUsd).toBe(1_000);
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
