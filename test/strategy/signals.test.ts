import { describe, expect, it } from "vitest";
import { STRATEGY } from "../../src/strategy/config.js";
import { MarkTracker, type TrackedMark } from "../../src/strategy/mark-tracker.js";
import { evaluateSignal } from "../../src/strategy/signals.js";

const MIN = 60_000;
const now = 10_000_000;

function mark(agoMs: number, priceUsd: number, extra: Partial<TrackedMark> = {}): TrackedMark {
  return { at: now - agoMs, priceUsd, vol5mUsd: 20_000, vol1hUsd: 100_000, change1hPct: 12, ...extra };
}

describe("launch signal", () => {
  const young = 10 * MIN;

  it("fires on a young coin rising 2% with volume on pace", () => {
    const marks = [mark(30_000, 1), mark(20_000, 1.01), mark(5_000, 1.02)];
    expect(evaluateSignal({ ageMs: young, marks, now })?.signal).toBe("launch");
  });

  it("stays quiet just under the 2% rise", () => {
    const marks = [mark(30_000, 1), mark(20_000, 1.01), mark(5_000, 1.0199)];
    expect(evaluateSignal({ ageMs: young, marks, now })).toBeNull();
  });

  it("needs three marks", () => {
    expect(evaluateSignal({ ageMs: young, marks: [mark(30_000, 1), mark(5_000, 1.05)], now })).toBeNull();
  });

  it("needs marks spread over at least 20 seconds", () => {
    const marks = [mark(15_000, 1), mark(10_000, 1.02), mark(5_000, 1.05)];
    expect(evaluateSignal({ ageMs: young, marks, now })).toBeNull();
  });

  it("stays quiet when 5m volume is under 1.5x the hourly pace", () => {
    // pace = 1h / 12 = 8,333. 1.5x = 12,500.
    const slow = { vol5mUsd: 12_000, vol1hUsd: 100_000 };
    const marks = [mark(30_000, 1, slow), mark(20_000, 1.01, slow), mark(5_000, 1.05, slow)];
    expect(evaluateSignal({ ageMs: young, marks, now })).toBeNull();
    const fast = { vol5mUsd: 12_500, vol1hUsd: 100_000 };
    expect(evaluateSignal({ ageMs: young, marks: [mark(30_000, 1, fast), mark(20_000, 1.01, fast), mark(5_000, 1.05, fast)], now })?.signal).toBe("launch");
  });

  it("fails closed when volume is unknown", () => {
    const blind = { vol5mUsd: null, vol1hUsd: null };
    const marks = [mark(30_000, 1, blind), mark(20_000, 1.01, blind), mark(5_000, 1.05, blind)];
    expect(evaluateSignal({ ageMs: young, marks, now })).toBeNull();
  });

  it("ignores a stale last mark", () => {
    const marks = [mark(90_000, 1), mark(70_000, 1.01), mark(STRATEGY.watch.markFreshMs + 1, 1.05)];
    expect(evaluateSignal({ ageMs: young, marks, now })).toBeNull();
  });
});

describe("momentum signal", () => {
  const old = 45 * MIN;

  it("fires on an older coin up 3% over the window with volume and 1h change behind it", () => {
    const marks = [mark(4 * MIN, 1), mark(2 * MIN, 1.01), mark(5_000, 1.03)];
    expect(evaluateSignal({ ageMs: old, marks, now })?.signal).toBe("momentum");
  });

  it("stays quiet just under 3%", () => {
    const marks = [mark(4 * MIN, 1), mark(2 * MIN, 1.01), mark(5_000, 1.0299)];
    expect(evaluateSignal({ ageMs: old, marks, now })).toBeNull();
  });

  it("only measures from marks inside the 5 minute window", () => {
    // The 6-minute-old low is outside the window. Inside it the coin is flat.
    const marks = [mark(6 * MIN, 0.5), mark(4 * MIN, 1), mark(5_000, 1.01)];
    expect(evaluateSignal({ ageMs: old, marks, now })).toBeNull();
  });

  it("needs at least 90 seconds of history", () => {
    const marks = [mark(80_000, 1), mark(40_000, 1.02), mark(5_000, 1.05)];
    expect(evaluateSignal({ ageMs: old, marks, now })).toBeNull();
  });

  it("stays quiet when the 1h change is flat, negative or unknown", () => {
    for (const change1hPct of [0, -4, null]) {
      const marks = [mark(4 * MIN, 1, { change1hPct }), mark(2 * MIN, 1.01, { change1hPct }), mark(5_000, 1.05, { change1hPct })];
      expect(evaluateSignal({ ageMs: old, marks, now })).toBeNull();
    }
  });

  it("uses the launch rule under 30 minutes and the momentum rule from 30 minutes", () => {
    const marks = [mark(30_000, 1), mark(20_000, 1.01), mark(5_000, 1.02)];
    expect(evaluateSignal({ ageMs: 30 * MIN - 1, marks, now })?.signal).toBe("launch");
    // Same marks: a 2% rise over 25s is not a momentum signal.
    expect(evaluateSignal({ ageMs: 30 * MIN, marks, now })).toBeNull();
  });
});

describe("mark tracker", () => {
  it("keeps at most the configured number of coins and drops the oldest watch", () => {
    const t = new MarkTracker();
    for (let i = 0; i < STRATEGY.watch.maxCoins + 3; i += 1) t.watch(`m${i}`, now + i);
    expect(t.mints()).toHaveLength(STRATEGY.watch.maxCoins);
    expect(t.has("m0")).toBe(false);
    expect(t.has(`m${STRATEGY.watch.maxCoins + 2}`)).toBe(true);
  });

  it("ignores marks for unwatched coins, bad prices and repeats of the same print", () => {
    const t = new MarkTracker();
    t.watch("a", now);
    t.note("b", mark(0, 1));
    t.note("a", mark(0, 0));
    t.note("a", mark(0, Number.NaN));
    t.note("a", mark(1_000, 1));
    t.note("a", mark(1_000, 1));
    expect(t.marks("b")).toEqual([]);
    expect(t.marks("a")).toHaveLength(1);
  });

  it("expires a coin 30 minutes after it was watched", () => {
    const t = new MarkTracker();
    t.watch("a", now);
    expect(t.expire(now + STRATEGY.watch.maxWatchMs - 1)).toEqual([]);
    expect(t.expire(now + STRATEGY.watch.maxWatchMs)).toEqual(["a"]);
    expect(t.has("a")).toBe(false);
  });

  it("caps the ring of marks per coin", () => {
    const t = new MarkTracker();
    t.watch("a", now);
    for (let i = 0; i < STRATEGY.watch.maxMarks + 10; i += 1) t.note("a", { ...mark(0, 1 + i / 1000), at: now + i * 1000 });
    expect(t.marks("a")).toHaveLength(STRATEGY.watch.maxMarks);
  });
});
