import { describe, expect, it } from "vitest";
import { Cached, EquityWindow, downsample } from "../src/desk/snapshot-cache.js";
import { visibleEquity } from "../src/desk/equity-series.js";
import type { EquityPoint } from "../src/types.js";

const pt = (i: number, equity = 100 + (i % 7)): EquityPoint => ({ t: i * 2_000, equity, cash: 60 });

describe("equity window", () => {
  it("draws the same curve as a full re-read for a short run", () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => pt(i));
    const w = new EquityWindow();
    w.load(rows.slice(0, 4_000));
    for (const r of rows.slice(4_000)) w.push(r);
    expect(w.view()).toEqual(downsample(visibleEquity(rows), 240));
    expect(w.size()).toBe(5_000);
  });

  it("caches the view until a point is pushed", () => {
    const w = new EquityWindow();
    w.load([pt(0), pt(1)]);
    const a = w.view();
    expect(w.view()).toBe(a);
    w.push(pt(2));
    expect(w.view()).not.toBe(a);
    expect(w.view()).toHaveLength(3);
  });

  it("folds a weeks-old book into a bounded head and keeps the last day raw", () => {
    const w = new EquityWindow();
    w.load(Array.from({ length: 300_000 }, (_, i) => pt(i)));
    expect(w.size()).toBeLessThanOrEqual(44_000);
    expect(w.view()).toHaveLength(240);
    expect(w.view()[0]?.t).toBe(0);
    expect(w.view()[239]?.t).toBe(299_999 * 2_000);
    for (let i = 300_000; i < 330_000; i += 1) w.push(pt(i));
    expect(w.size()).toBeLessThanOrEqual(64_000);
    expect(w.view()[239]?.t).toBe(329_999 * 2_000);
  });

  it("keeps the display filter: an absurd spike that never comes back is dropped", () => {
    const w = new EquityWindow();
    w.load([pt(0, 100), pt(1, 100), { t: 4_000, equity: 100_000, cash: 60 }, { t: 6_000, equity: 100_000, cash: 60 }]);
    expect(w.view().map((p) => p.equity)).toEqual([100, 100]);
  });

  it("clears on a paper reset", () => {
    const w = new EquityWindow();
    w.load([pt(0), pt(1)]);
    w.clear();
    expect(w.view()).toEqual([]);
    w.push(pt(9));
    expect(w.view()).toHaveLength(1);
  });
});

describe("cached and memo", () => {
  it("cached recomputes only after invalidate", () => {
    let n = 0;
    const c = new Cached(() => ++n);
    expect(c.get()).toBe(1);
    expect(c.get()).toBe(1);
    c.invalidate();
    expect(c.get()).toBe(2);
  });
});
