import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CandidateToken } from "../../src/types.js";
import { STRATEGY } from "../../src/strategy/config.js";
import { StrategyEngine, defaultSettings, patchSettings } from "../../src/strategy/engine.js";
import { ShadowStore } from "../../src/strategy/store.js";

const t0 = Date.UTC(2026, 10, 11, 15, 0, 0);

function token(over: Partial<CandidateToken> = {}): CandidateToken {
  return {
    mint: "MintA",
    symbol: "AAA",
    name: "Alpha",
    source: "pumpfun",
    discoveredAt: t0,
    priceUsd: 1,
    liquidityUsd: 200_000,
    volume1hUsd: 100_000,
    volume5mUsd: 20_000,
    priceChange1hPct: 10,
    ageSeconds: 600,
    mintAuthorityRevoked: true,
    lpLockedOrBurned: true,
    top10HolderPct: 0.1,
    holderCount: 500,
    social: { mentions1h: 0, hasWebsite: false, hasTelegram: false, hasTwitter: false },
    ...over
  } as CandidateToken;
}

const quote = (at: number, priceUsd: number) => ({ at, priceUsd, vol5mUsd: 20_000, vol1hUsd: 100_000, change1hPct: 10 });
const on = () => ({ ...defaultSettings(), enabled: true });

function fireLaunch(engine: StrategyEngine, t = token()) {
  engine.watch(t, 0.7, t0);
  engine.onQuote(t.mint, quote(t0 + 10_000, 1.01), t0 + 10_000);
  return engine.onQuote(t.mint, quote(t0 + 22_000, 1.025), t0 + 22_000);
}

describe("strategy engine", () => {
  it("does nothing while it is off", () => {
    const engine = new StrategyEngine();
    expect(engine.watch(token(), 0.7, t0)).toBe(false);
    expect(engine.pinned()).toEqual([]);
    expect(engine.onQuote("MintA", quote(t0 + 22_000, 2), t0 + 22_000)).toBeNull();
  });

  it("watches a coin, fires a launch signal once, and opens the three launch shadow books", () => {
    const engine = new StrategyEngine({ settings: on() });
    expect(engine.watch(token(), 0.7, t0)).toBe(true);
    expect(engine.pinned()).toEqual(["MintA"]);
    expect(engine.onQuote("MintA", quote(t0 + 10_000, 1.01), t0 + 10_000)).toBeNull();
    const fired = engine.onQuote("MintA", quote(t0 + 22_000, 1.025), t0 + 22_000);
    expect(fired?.signal.signal).toBe("launch");
    expect(fired?.token.priceUsd).toBe(1.025);
    expect(fired?.meta).toMatchObject({ variant: "launch-1", stopPct: 0.01, targetNetUsd: 3, timeLimitMs: STRATEGY.launch.timeLimitMs });
    const open = [...engine.books.values()].filter((b) => b.positions.has("MintA") && !b.variant.trailPct).map((b) => b.variant.id);
    expect(open.sort()).toEqual(["launch-1", "launch-3", "launch-6"]);
    expect([...engine.books.values()].filter((b) => b.positions.has("MintA") && b.variant.trailPct)).toHaveLength(6);
    // Still pinned for the shadow positions, but no longer watched and not re-signalled.
    expect(engine.pinned()).toEqual(["MintA"]);
    expect(engine.onQuote("MintA", quote(t0 + 30_000, 1.03), t0 + 30_000)).toBeNull();
    expect(engine.watch(token(), 0.7, t0 + 60_000)).toBe(false);
    expect(engine.watch(token(), 0.7, t0 + STRATEGY.reentryMs + 22_000)).toBe(true);
  });

  it("routes an older coin to the momentum books", () => {
    const engine = new StrategyEngine({ settings: on() });
    const old = token({ mint: "MintB", ageSeconds: 3_600 });
    engine.watch(old, 0.7, t0);
    engine.onQuote("MintB", quote(t0 + 60_000, 1.01), t0 + 60_000);
    const fired = engine.onQuote("MintB", quote(t0 + 120_000, 1.04), t0 + 120_000);
    expect(fired?.signal.signal).toBe("momentum");
    const open = [...engine.books.values()].filter((b) => b.positions.has("MintB") && !b.variant.trailPct).map((b) => b.variant.id);
    expect(open.sort()).toEqual(["momentum-1", "momentum-3", "momentum-6"]);
  });

  it("closes shadow positions on later quotes and saves the trades", () => {
    const store = new ShadowStore(new DatabaseSync(":memory:"));
    const engine = new StrategyEngine({ settings: on(), store });
    fireLaunch(engine);
    // −2% from the signal price: through the 1% stop only.
    engine.onQuote("MintA", quote(t0 + 32_000, 1.025 * 0.98), t0 + 32_000);
    expect(store.all().map((t) => t.variant)).toEqual(["launch-1"]);
    expect(engine.books.get("launch-3")!.positions.has("MintA")).toBe(true);
    // A run to +9% takes profit on the other two.
    engine.onTick("MintA", 1.025 * 1.09, t0 + 40_000);
    expect(store.all().map((t) => `${t.variant}:${t.exitCode}`).sort()).toEqual(["launch-1:STRATEGY_STOP", "launch-3:TAKE_PROFIT", "launch-6:TAKE_PROFIT"]);
    // The trailing books did not sell at the target: they are trailing the run.
    expect(engine.pinned()).toEqual(["MintA"]);
    expect([...engine.books.values()].filter((b) => b.positions.has("MintA")).every((b) => b.variant.trailPct && b.positions.get("MintA")!.state.trailArmed)).toBe(true);
    // −5% from the high: through the 4% trail only.
    engine.onTick("MintA", 1.025 * 1.09 * 0.95, t0 + 45_000);
    expect(store.all().filter((t) => t.exitCode === "ENGINE_TRAIL").map((t) => t.variant).sort()).toEqual(["launch-3-t4", "launch-3-t4f"]);
    const card = engine.scorecard();
    expect(card.variants.find((v) => v.variant === "launch-1")).toMatchObject({ trades: 1, wins: 0, active: true });
    expect(card.variants.find((v) => v.variant === "launch-3")).toMatchObject({ trades: 1, wins: 1, active: false });
    // A restart reloads the same numbers.
    const again = new StrategyEngine({ settings: on(), store });
    expect(again.scorecard().variants.find((v) => v.variant === "launch-3")?.netUsd).toBeCloseTo(card.variants.find((v) => v.variant === "launch-3")!.netUsd, 6);
    again.reset();
    expect(store.all()).toEqual([]);
    expect(again.scorecard().variants.every((v) => v.trades === 0)).toBe(true);
  });

  it("a shadow book that throws is counted and does not stop the signal or the other books", () => {
    const errors: string[] = [];
    const engine = new StrategyEngine({ settings: on(), onError: (where) => errors.push(where) });
    engine.books.get("launch-3")!.open = () => {
      throw new Error("boom");
    };
    const fired = fireLaunch(engine);
    expect(fired?.signal.signal).toBe("launch");
    expect(engine.books.get("launch-1")!.positions.has("MintA")).toBe(true);
    expect(engine.books.get("launch-6")!.positions.has("MintA")).toBe(true);
    expect(errors).toEqual(["open launch-3"]);
    engine.books.get("launch-1")!.onMark = () => {
      throw new Error("bang");
    };
    expect(() => engine.onTick("MintA", 0.5, t0 + 30_000)).not.toThrow();
    expect(engine.books.get("launch-6")!.positions.has("MintA")).toBe(false);
    expect(engine.stats.errors).toBe(2);
  });

  it("stops watching a coin after the watch window", () => {
    const engine = new StrategyEngine({ settings: on() });
    engine.watch(token(), 0.7, t0);
    engine.tick(t0 + STRATEGY.watch.maxWatchMs);
    expect(engine.pinned()).toEqual([]);
  });

  it("the active variant sets the main book's stop", () => {
    const patched = patchSettings(on(), { active: { launch: "launch-6" }, targetNetUsd: 4 });
    if (!patched.ok) throw new Error(patched.error);
    const engine = new StrategyEngine({ settings: patched.settings });
    expect(engine.metaFor("launch")).toMatchObject({ variant: "launch-6", stopPct: 0.06, targetNetUsd: 4 });
    expect(engine.metaFor("momentum")).toMatchObject({ variant: "momentum-1", stopPct: 0.01 });
  });
});

describe("strategy settings patch", () => {
  const base = defaultSettings();
  it("is off by default with the spec's sizes", () => {
    expect(base).toMatchObject({ enabled: false, targetNetUsd: 3, tradeUsd: 50, maxOpen: 2, active: { launch: "launch-1", momentum: "momentum-1" } });
  });
  it("clamps numbers into their bands", () => {
    const r = patchSettings(base, { tradeUsd: 9_999, targetNetUsd: 0.01, maxOpen: 2.6 });
    expect(r.ok && r.settings).toMatchObject({ tradeUsd: 500, targetNetUsd: 0.25, maxOpen: 3 });
  });
  it("rejects bad values and changes nothing", () => {
    for (const bad of [null, 5, { enabled: "yes" }, { tradeUsd: -1 }, { tradeUsd: Number.NaN }, { active: { launch: "momentum-1" } }, { active: { momentum: "nope" } }]) {
      expect(patchSettings(base, bad).ok).toBe(false);
    }
  });

  it("a carried-over volume reading keeps its own age", () => {
    const engine = new StrategyEngine({ settings: on() });
    engine.onQuote("MintF", { ...quote(t0 + 100_000, 1), flowAt: t0 }, t0 + 100_000);
    expect(engine.flowFor("MintF")?.at).toBe(t0);
    engine.onQuote("MintF", quote(t0 + 110_000, 1), t0 + 110_000);
    expect(engine.flowFor("MintF")?.at).toBe(t0 + 110_000);
  });
});
