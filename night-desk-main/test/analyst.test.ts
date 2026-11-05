import { describe, expect, it } from "vitest";
import { decideScore, scoreToken } from "../src/agents/analyst.js";
import { makeToken } from "../src/demo/tokens.js";
import { resolveRules } from "../src/rules.js";

const rules = resolveRules({});

describe("Analyst threshold", () => {
  it("trades at 0.6 and rejects anything under it", () => {
    expect(decideScore(0.6, rules.analystMinScore)).toBe("trade");
    expect(decideScore(0.5999, rules.analystMinScore)).toBe("reject");
  });

  it("scores a deep, distributed, active survivor as a trade", () => {
    const report = scoreToken(makeToken(), rules);
    expect(report.score).toBeGreaterThanOrEqual(0.6);
    expect(report.score).toBeLessThanOrEqual(1);
    expect(report.decision).toBe("trade");
    expect(report.reason).toBeUndefined();
    const sum = report.breakdown.reduce((total, factor) => total + factor.raw * factor.weight, 0);
    expect(Math.abs(sum - report.score)).toBeLessThan(0.0002);
    expect(report.breakdown.map((f) => f.key)).toEqual(["liquidity", "holders", "volume", "age", "social"]);
  });

  it("rejects a filter survivor that is thin, young, and quiet", () => {
    const report = scoreToken(
      makeToken({
        symbol: "QUIETCAT",
        liquidityUsd: 12_000,
        volume1hUsd: 52_000,
        top10HolderPct: 0.19,
        holderCount: 40,
        ageSeconds: 120,
        social: { mentions1h: 0, hasWebsite: false, hasTelegram: false, hasTwitter: false }
      }),
      rules
    );
    expect(report.score).toBeLessThan(0.6);
    expect(report.decision).toBe("reject");
    expect(report.reason).toMatchObject({
      code: "SCORE_BELOW_THRESHOLD",
      message: expect.stringContaining("below")
    });
  });

  it("does not let a looser env score line through", () => {
    const tightened = resolveRules({ ANALYST_MIN_SCORE: "0.2" });
    expect(tightened.analystMinScore).toBe(0.6);
  });
});
