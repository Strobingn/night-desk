import { describe, expect, it } from "vitest";
import { planOrder } from "../src/agents/execution-math.js";
import { assessPosition, entryAllowed } from "../src/agents/risk.js";
import { makeToken } from "../src/demo/tokens.js";
import { resolveRules } from "../src/rules.js";
import { testDesk } from "./helpers.js";

const rules = resolveRules({});

describe("Risk stop, trail, and no averaging down", () => {
  it("hard-stops at -6% from entry and holds just above it", () => {
    const entry = 1;
    const atStop = assessPosition({ entryPrice: entry, peakPrice: entry, trailArmed: false }, entry * (1 - 0.06), rules);
    expect(atStop.action).toBe("stop");
    expect(atStop.code).toBe("STOP_LOSS");
    const above = assessPosition(
      { entryPrice: entry, peakPrice: entry, trailArmed: false },
      entry * (1 - 0.06) + 0.01,
      rules
    );
    expect(above.action).toBe("hold");
    expect(above.trailArmed).toBe(false);
  });

  it("keeps the hard stop at -6% and does not sell a pullback from the peak", () => {
    const view = assessPosition({ entryPrice: 1, peakPrice: 1, trailArmed: false }, 1.11, rules);
    expect(view.action).toBe("hold");
    expect(view.trailArmed).toBe(false);
    expect(view.stopPrice).toBeCloseTo(0.94, 8);
    expect(view.trailHintPrice).toBeNull();

    const armed = assessPosition({ entryPrice: 1, peakPrice: 1, trailArmed: false }, 1.2, rules);
    expect(armed.action).toBe("hold");
    expect(armed.trailArmed).toBe(true);
    expect(armed.peakPrice).toBeCloseTo(1.2, 8);
    expect(armed.stopPrice).toBeCloseTo(0.94, 8);
    expect(armed.trailHintPrice).toBeCloseTo(1.2 * 0.96, 8);

    const pullback = assessPosition({ entryPrice: 1, peakPrice: 1.2, trailArmed: true }, 1.2 * 0.96, rules);
    expect(pullback.action).toBe("hold");
    expect(pullback.code).toBeUndefined();
    expect(pullback.stopPrice).toBeCloseTo(0.94, 8);
  });

  it("reports a gap through the hard stop as STOP_LOSS even after the peak hint is armed", () => {
    const crashed = assessPosition({ entryPrice: 1, peakPrice: 1.2, trailArmed: true }, 0.9, rules);
    expect(crashed.action).toBe("stop");
    expect(crashed.code).toBe("STOP_LOSS");
  });

  it("blocks adds and revenge entries", () => {
    const add = entryAllowed({ hasPosition: true, cooldownUntil: null, now: 1_000 });
    expect(add.ok).toBe(false);
    if (!add.ok) expect(add.reason.code).toBe("NO_AVERAGE_DOWN");

    const revenge = entryAllowed({ hasPosition: false, cooldownUntil: 5_000, now: 4_000 });
    expect(revenge.ok).toBe(false);
    if (!revenge.ok) expect(revenge.reason.code).toBe("REVENGE_COOLDOWN");

    expect(entryAllowed({ hasPosition: false, cooldownUntil: 5_000, now: 5_000 }).ok).toBe(true);
  });

  it("refuses to average down or re-enter after a stop on the desk", async () => {
    const desk = testDesk();
    const mint = "RiskMint111111111111111111111111111111111";
    const token = makeToken({ mint, symbol: "RISK", priceUsd: 1 });
    try {
      await desk.submitCandidate(token);
      expect(desk.book.positions.size).toBe(1);
      const qty = desk.book.positions.get(mint)!.qty;

      await desk.submitCandidate(token);
      expect(desk.book.positions.get(mint)!.qty).toBe(qty);
      expect(desk.snapshot().events.some((event) => event.code === "NO_AVERAGE_DOWN")).toBe(true);

      await desk.markPrice(mint, 0.93);
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "STOP_LOSS")).toBe(true);

      await desk.submitCandidate(makeToken({ mint, symbol: "RISK", priceUsd: 1 }));
      expect(desk.book.positions.has(mint)).toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "REVENGE_COOLDOWN")).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("ratchets the peak, keeps a winner through a pullback, and hard-stops on a live mark", async () => {
    const desk = testDesk();
    const mint = "TrailMint11111111111111111111111111111111";
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "MOONKIT", priceUsd: 1 }));
      await desk.markPrice(mint, 1.31);
      const entry = desk.book.positions.get(mint)!.entryPrice;
      const open = desk.snapshot().positions.find((pos) => pos.mint === mint);
      expect(open?.peakPrice).toBeCloseTo(1.31, 8);
      expect(open?.trailArmed).toBe(true);
      expect(open?.stopPrice).toBeCloseTo(entry * 0.94, 8);
      expect(desk.store.loadBook()?.positions.find((pos) => pos.mint === mint)?.peakPrice).toBeCloseTo(1.31, 8);

      await desk.submitCandidate(makeToken({ mint, symbol: "MOONKIT", priceUsd: 1.31 * 0.96 }));
      expect(desk.book.positions.has(mint)).toBe(true);
      expect(desk.book.positions.get(mint)?.peakPrice).toBeCloseTo(1.31, 8);
      expect(desk.snapshot().events.some((event) => event.code === "TRAIL_STOP")).toBe(false);

      await desk.markPrice(mint, entry * 0.94);
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "STOP_LOSS")).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("does not let the env loosen the stop, the arm, or the cooldown", () => {
    const loose = resolveRules({
      STOP_LOSS_PCT: "0.2",
      TRAIL_ARM_PCT: "0.02",
      TRAIL_GAP_PCT: "0.2",
      REVENGE_COOLDOWN_MS: "1000"
    });
    expect(loose.stopLossPct).toBe(0.06);
    expect(loose.trailArmPct).toBe(0.12);
    expect(loose.trailGapPct).toBe(0.04);
    expect(loose.revengeCooldownMs).toBe(0);
  });

  it("planOrder is the same no-add gate the executor uses", () => {
    const refused = planOrder({
      equityUsd: 10_000,
      cashUsd: 10_000,
      rules,
      token: makeToken(),
      hasPosition: true,
      cooldownUntil: null,
      now: 0
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason.code).toBe("NO_AVERAGE_DOWN");
  });
});
