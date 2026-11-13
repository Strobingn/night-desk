import { describe, expect, it } from "vitest";
import { STRATEGY, VARIANTS, variantById } from "../../src/strategy/config.js";
import { defaultSettings, patchSettings, StrategyEngine } from "../../src/strategy/engine.js";
import { assessStrategyExit, fadeReason, strategyLinePrice, type StrategyMeta } from "../../src/strategy/exits.js";
import { ShadowBook } from "../../src/strategy/shadow-book.js";

const base: StrategyMeta = { variant: "launch-3-t8", signal: "launch", stopPct: 0.03, targetNetUsd: 3, timeLimitMs: 600_000, trailPct: 0.08 };
const at = (meta: StrategyMeta, mark: number, net: number | null, now = 10_000, extra: Partial<Parameters<typeof assessStrategyExit>[0]> = {}) =>
  assessStrategyExit({ entryPrice: 1.005, entryMark: 1, openedAt: 0, mark, markFresh: true, netPnlUsd: net, now, meta, ...extra });

describe("trailing and fade exits", () => {
  it("adds twelve trailing books and keeps the six fixed-target ids", () => {
    expect(VARIANTS.map((v) => v.id).slice(0, 6)).toEqual(["launch-1", "launch-3", "launch-6", "momentum-1", "momentum-3", "momentum-6"]);
    expect(VARIANTS).toHaveLength(18);
    expect(variantById("momentum-3-t12f")).toMatchObject({ signal: "momentum", stopPct: 0.03, trailPct: 0.12, fade: true });
    expect(variantById("launch-3-t4")?.fade).toBeUndefined();
    expect(new Set(VARIANTS.map((v) => v.id)).size).toBe(18);
  });

  it("does not sell at the target: it starts trailing, follows the high, and sells 8% under it", () => {
    const armed = at(base, 1.09, 3.2);
    expect(armed.action).toBe("hold");
    expect(armed.patch).toEqual({ trailArmed: true, peakMark: 1.09, peakAt: 10_000 });
    let meta = { ...base, ...armed.patch };
    const up = at(meta, 1.3, 12, 20_000);
    expect(up.action).toBe("hold");
    expect(up.patch).toEqual({ peakMark: 1.3, peakAt: 20_000 });
    meta = { ...meta, ...up.patch };
    expect(at(meta, 1.3 * 0.93, 9, 30_000).action).toBe("hold");
    const out = at(meta, 1.3 * 0.92, 8.5, 31_000);
    expect(out.code).toBe("ENGINE_TRAIL");
    expect(strategyLinePrice(1.005, 1, meta)).toBeCloseTo(1.3 * 0.92, 12);
    expect(strategyLinePrice(1.005, 1, base)).toBeCloseTo(0.97, 12);
  });

  it("locks a profit once trailing: back to half the target sells", () => {
    const meta = { ...base, trailArmed: true, peakMark: 1.09, peakAt: 10_000 };
    expect(at(meta, 1.06, 1.6, 12_000).action).toBe("hold");
    expect(at(meta, 1.055, 1.5, 12_000).code).toBe("PROFIT_LOCK");
  });

  it("keeps the stop first, and a stale mark only ever fires the stop", () => {
    expect(at(base, 0.97, -2).code).toBe("STRATEGY_STOP");
    const meta = { ...base, trailArmed: true, peakMark: 1.3, peakAt: 10_000 };
    expect(at(meta, 1.1, 5, 20_000, { markFresh: false }).action).toBe("hold");
    expect(at(meta, 0.96, -3, 20_000, { markFresh: false }).code).toBe("STRATEGY_STOP");
  });

  it("a plain trailing book ignores fade signals; a fade book sells on them", () => {
    const armed = { trailArmed: true, peakMark: 1.2, peakAt: 10_000, entryVol5mUsd: 40_000, entryLiquidityUsd: 50_000 };
    const plain = { ...base, ...armed };
    const fade = { ...base, variant: "launch-3-t8f", fade: true, ...armed };
    const quiet = { at: 99_000, vol5mUsd: 15_000, buys5m: 30, sells5m: 20, liquidityUsd: 50_000 };
    expect(at(plain, 1.19, 8, 100_000, { flow: quiet }).action).toBe("hold");
    // No new high for 90 s.
    expect(at(fade, 1.19, 8, 100_000, { flow: { at: 99_000 } }).code).toBe("FADE_EXIT");
    // Volume under half of the entry volume.
    expect(at({ ...fade, peakAt: 95_000 }, 1.19, 8, 100_000, { flow: quiet }).message).toMatch(/volume/);
    // Sellers lead.
    const sellers = { at: 99_000, vol5mUsd: 40_000, buys5m: 10, sells5m: 16, liquidityUsd: 50_000 };
    expect(at({ ...fade, peakAt: 95_000 }, 1.19, 8, 100_000, { flow: sellers }).message).toMatch(/sellers lead/);
    // Too few trades to judge, and stale flow, fire nothing.
    expect(fadeReason(fade, { at: 99_000, buys5m: 2, sells5m: 6 }, 100_000)).toBeNull();
    expect(fadeReason(fade, { ...sellers, at: 100_000 - STRATEGY.fade.freshMs - 1 }, 100_000)).toBeNull();
  });

  it("a fade book sells when the pool drains, even before the target", () => {
    const fade: StrategyMeta = { ...base, fade: true, entryLiquidityUsd: 50_000 };
    expect(at(fade, 1.01, 0.2, 10_000, { flow: { at: 9_000, liquidityUsd: 40_000 } }).action).toBe("hold");
    expect(at(fade, 1.01, 0.2, 10_000, { flow: { at: 9_000, liquidityUsd: 37_000 } }).code).toBe("LIQUIDITY_DROP");
    expect(at({ ...base, entryLiquidityUsd: 50_000 }, 1.01, 0.2, 10_000, { flow: { at: 9_000, liquidityUsd: 10_000 } }).action).toBe("hold");
  });

  it("a trailing trade that never gets going still has the breakeven and the time limit, and a long cap once trailing", () => {
    expect(at(base, 1.02, 0.5, 600_000).code).toBe("TIME_LIMIT");
    expect(at({ ...base, breakevenArmed: true }, 1.0, -0.1).code).toBe("BREAKEVEN_STOP");
    const meta = { ...base, trailArmed: true, peakMark: 1.2, peakAt: 2_390_000 };
    expect(at(meta, 1.2, 9, 2_399_000).action).toBe("hold");
    expect(at(meta, 1.2, 9, 2_400_000).code).toBe("TIME_LIMIT");
  });

  it("a trailing shadow book rides a run the fixed book sells early", () => {
    const trail = new ShadowBook(variantById("launch-3-t8")!);
    const fixed = new ShadowBook(variantById("launch-3")!);
    const token = { mint: "M", symbol: "M", priceUsd: 0.001, liquidityUsd: 200_000, vol5mUsd: 40_000 };
    trail.open(token, 0);
    fixed.open(token, 0);
    const first = fixed.onMark("M", 0.00108, 5_000);
    expect(first?.exitCode).toBe("TAKE_PROFIT");
    expect(trail.onMark("M", 0.00108, 5_000)).toBeNull();
    expect(trail.onMark("M", 0.0015, 10_000)).toBeNull();
    const out = trail.onMark("M", 0.0015 * 0.91, 15_000);
    expect(out?.exitCode).toBe("ENGINE_TRAIL");
    expect(out!.pnlUsd).toBeGreaterThan(first!.pnlUsd * 3);
  });

  it("the live variant is off by default, takes any known variant, and refuses an unknown one", () => {
    expect(defaultSettings().liveVariant).toBeNull();
    const on = patchSettings(defaultSettings(), { liveVariant: "launch-3-t8f" });
    expect(on.ok && on.settings.liveVariant).toBe("launch-3-t8f");
    expect(patchSettings(defaultSettings(), { liveVariant: "nope" }).ok).toBe(false);
    const off = patchSettings({ ...defaultSettings(), liveVariant: "launch-1" }, { liveVariant: null });
    expect(off.ok && off.settings.liveVariant).toBeNull();
    // Settings saved before this version have no liveVariant.
    const old = patchSettings(defaultSettings(), { enabled: true, targetNetUsd: 3, tradeUsd: 50, maxOpen: 2, active: { launch: "launch-1", momentum: "momentum-1" } });
    expect(old.ok && old.settings.liveVariant).toBeNull();
  });

  it("a signal carries live exit rules only for the live variant's own signal", () => {
    const engine = new StrategyEngine({ settings: { ...defaultSettings(), enabled: true, liveVariant: "launch-3-t8f" } });
    const t0 = 1_700_000_000_000;
    const token = { mint: "MintL", symbol: "L", name: "L", priceUsd: 1, liquidityUsd: 100_000, volume1hUsd: 120_000, volume5mUsd: 30_000, ageSeconds: 600, discoveredAt: t0 } as never;
    engine.watch(token, 0.7, t0);
    const q = (at: number, priceUsd: number) => ({ at, priceUsd, vol5mUsd: 30_000, vol1hUsd: 120_000, change1hPct: 12, liquidityUsd: 100_000 });
    engine.onQuote("MintL", q(t0 + 10_000, 1.01), t0 + 10_000);
    const fired = engine.onQuote("MintL", q(t0 + 22_000, 1.025), t0 + 22_000);
    expect(fired?.liveMeta).toMatchObject({ variant: "launch-3-t8f", stopPct: 0.03, trailPct: 0.08, fade: true, entryVol5mUsd: 30_000, entryLiquidityUsd: 100_000 });
    expect(engine.scorecard().variants.find((v) => v.variant === "launch-3-t8f")).toMatchObject({ live: true, trailPct: 0.08, fade: true });
    const other = new StrategyEngine({ settings: { ...defaultSettings(), enabled: true, liveVariant: "momentum-1" } });
    other.watch(token, 0.7, t0);
    other.onQuote("MintL", q(t0 + 10_000, 1.01), t0 + 10_000);
    expect(other.onQuote("MintL", q(t0 + 22_000, 1.025), t0 + 22_000)?.liveMeta).toBeUndefined();
  });
});
