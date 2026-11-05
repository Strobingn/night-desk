import { describe, expect, it } from "vitest";
import { planOrder, resolveManualSize } from "../src/agents/execution-math.js";
import { makeToken } from "../src/demo/tokens.js";
import { HARD_RULES, resolveRules } from "../src/rules.js";
import { testDesk } from "./helpers.js";

const rules = resolveRules({});
const now = 1_700_000_000_000;

function plan(overrides: Partial<Parameters<typeof planOrder>[0]> = {}) {
  return planOrder({
    equityUsd: 10_000,
    cashUsd: 10_000,
    rules,
    token: makeToken(),
    hasPosition: false,
    cooldownUntil: null,
    now,
    ...overrides
  });
}

describe("Executor 8% cap", () => {
  it("does not reject a ticket solely because liquidity is under $5k", () => {
    const order = plan({ token: makeToken({ liquidityUsd: 100, priceUsd: 0.0004 }) });
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    expect(order.sizeUsd).toBe(800);
    const dust = plan({ token: makeToken({ liquidityUsd: 0, priceUsd: 0.0004 }) });
    expect(dust.ok).toBe(true);
  });

  it("sizes a full book at exactly 8% and never above", () => {
    const order = plan();
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    expect(order.sizeUsd).toBe(800);
    expect(order.sizeUsd).toBeLessThanOrEqual(10_000 * 0.08);
  });

  it("floors a fractional 8% so rounding cannot refuse a legal ticket", () => {
    const equityUsd = 10_020.2;
    const order = plan({ equityUsd, cashUsd: equityUsd });
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    expect(order.sizeUsd).toBeLessThanOrEqual(equityUsd * 0.08 + 1e-9);
    expect(order.sizeUsd).toBe(Math.floor(equityUsd * 0.08 * 100 + 1e-6) / 100);
  });

  it("clips to cash when cash is inside the cap", () => {
    const order = plan({ cashUsd: 50 });
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    expect(order.sizeUsd).toBe(50);
    expect(order.sizeUsd).toBeLessThanOrEqual(10_000 * HARD_RULES.maxPositionPct);
  });

  it("keeps the 8% ceiling even if rules were widened by hand", () => {
    const order = plan({ rules: { ...rules, maxPositionPct: 0.5 } });
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    expect(order.sizeUsd).toBe(800);
  });

  it("cuts a manual size above the plan down to the cap and keeps a blank size at the cap", () => {
    expect(resolveManualSize(800, undefined)).toEqual({ ok: true, sizeUsd: 800, capUsd: 800 });
    expect(resolveManualSize(800, 25)).toEqual({ ok: true, sizeUsd: 25, capUsd: 800 });
    expect(resolveManualSize(800, 800.004)).toMatchObject({ ok: true, sizeUsd: 800 });
    expect(resolveManualSize(800, 800.02)).toEqual({ ok: true, sizeUsd: 800, capUsd: 800, clampedFrom: 800.02 });
    expect(resolveManualSize(7.1, 10)).toEqual({ ok: true, sizeUsd: 7.1, capUsd: 7.1, clampedFrom: 10 });
    const dust = resolveManualSize(800, 0.001);
    expect(dust.ok).toBe(false);
    const bad = resolveManualSize(800, Number.NaN);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason.message).toBe("Manual size must be a positive USD amount. Order refused.");
    const zero = resolveManualSize(800, 0);
    expect(zero.ok).toBe(false);
  });

  it("ignores an env cap above 8%", () => {
    expect(resolveRules({ MAX_POSITION_PCT: "0.5" }).maxPositionPct).toBe(0.08);
    expect(resolveRules({ MAX_POSITION_PCT: "0.03" }).maxPositionPct).toBe(0.03);
  });

  it("refuses a book fill above 8% of the live equity", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ symbol: "NIGHTPEPE", mint: "NightPepeTestMint111111111111111111111" }));
      const pos = [...desk.book.positions.values()][0];
      expect(pos).toBeTruthy();
      expect(pos!.costUsd).toBeLessThanOrEqual(10_000 * 0.08 + 0.001);
      expect(pos!.costUsd).toBe(800);
      expect(desk.book.cashUsd).toBe(9_200);
      const snap = desk.snapshot();
      expect(snap.mode).toBe("paper");
      expect(snap.events.some((event) => event.stage === "executor" && event.kind === "fill")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("does not fill a name the analyst rejected", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(
        makeToken({
          mint: "QuietCatTest11111111111111111111111111111",
          symbol: "QUIETCAT",
          liquidityUsd: 12_000,
          volume1hUsd: 52_000,
          top10HolderPct: 0.19,
          holderCount: 40,
          ageSeconds: 120,
          social: { mentions1h: 0, hasWebsite: false, hasTelegram: false, hasTwitter: false }
        })
      );
      expect(desk.book.positions.size).toBe(0);
      const stages = desk.snapshot().events.map((event) => `${event.stage}:${event.kind}`);
      expect(stages).toContain("analyst:reject");
      expect(stages).not.toContain("executor:fill");
    } finally {
      desk.stop();
    }
  });
});
