import { describe, expect, it } from "vitest";
import { scoreToken, volumeBoostBonus } from "../src/agents/analyst.js";
import { makeToken } from "../src/demo/tokens.js";
import { scoutExtras } from "../src/desk/orchestrator.js";
import { parseDexPair } from "../src/market/parsers.js";
import { HARD_RULES, VOLUME_BOOST_BAND, clampVolumeBoost, resolveRules } from "../src/rules.js";
import { testDesk } from "./helpers.js";

const base = resolveRules({});
const withBoost = (b: number) => ({ ...base, volumeBoost: b });

describe("v13.1 analyst volume boost", () => {
  it("is fail-closed on missing or broken volume data: no NaN, no boost", () => {
    for (const vol of [NaN, Infinity, -Infinity, -5, 0, undefined as unknown as number, null as unknown as number]) {
      const b = volumeBoostBonus(vol, 50_000, 1);
      expect(Number.isFinite(b.bonus)).toBe(true);
      expect(b.bonus).toBe(0);
    }
    for (const liq of [NaN, 0, -1, undefined as unknown as number]) expect(volumeBoostBonus(500_000, liq, 1).bonus).toBe(0);
    for (const boost of [NaN, undefined, -1, 0]) expect(volumeBoostBonus(500_000, 100_000, boost).bonus).toBe(0);
  });

  it("never yields NaN or a score above 1, even at 100% boost on a perfect coin", () => {
    const perfect = makeToken({ liquidityUsd: 2_000_000, volume1hUsd: 5_000_000, top10HolderPct: 0.03, holderCount: 5000, ageSeconds: 3600, social: { mentions1h: 500, hasWebsite: true, hasTelegram: true, hasTwitter: true } });
    const r = scoreToken(perfect, withBoost(1));
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.score).toBeLessThanOrEqual(1);
    for (const vol of [NaN, Infinity, undefined as unknown as number, -1]) {
      const broken = scoreToken({ ...perfect, volume1hUsd: vol }, withBoost(1));
      expect(Number.isFinite(broken.score)).toBe(true);
      expect(broken.score).toBeGreaterThanOrEqual(0);
      expect(broken.score).toBeLessThanOrEqual(1);
      expect(broken.breakdown.some((f) => f.key === "boost")).toBe(false);
    }
    const nanLiq = scoreToken({ ...perfect, liquidityUsd: NaN }, withBoost(1));
    expect(Number.isFinite(nanLiq.score)).toBe(true);
    expect(nanLiq.score).toBeLessThanOrEqual(1);
  });

  it("only ever raises scores, and raises high volume more", () => {
    const low = makeToken({ volume1hUsd: 8_000, liquidityUsd: 40_000 });
    const mid = makeToken({ volume1hUsd: 100_000, liquidityUsd: 60_000 });
    const high = makeToken({ volume1hUsd: 1_500_000, liquidityUsd: 300_000, ageSeconds: 120, social: { mentions1h: 0, hasWebsite: false, hasTelegram: false, hasTwitter: false } });
    expect(scoreToken(high, base).score).toBeLessThan(0.9);
    for (const t of [low, mid, high]) expect(scoreToken(t, withBoost(0.5)).score).toBeGreaterThanOrEqual(scoreToken(t, base).score);
    expect(scoreToken(low, withBoost(0.5)).score).toBe(scoreToken(low, base).score);
    expect(scoreToken(mid, withBoost(0.5)).score - scoreToken(mid, base).score).toBeCloseTo(0.05, 3);
    const lift = scoreToken(high, withBoost(0.5)).score - scoreToken(high, base).score;
    expect(lift).toBeGreaterThan(0.05);
    expect(lift).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("does not move any gate, the stop, or paper mode", () => {
    expect(base.analystMinScore).toBe(0.5);
    expect(base.maxTop10Pct).toBe(0.35);
    expect(HARD_RULES.stopLossPct).toBe(0.06);
    expect(base.volumeBoost).toBeUndefined();
    expect(clampVolumeBoost(NaN)).toBe(VOLUME_BOOST_BAND.default);
    expect(clampVolumeBoost(80)).toBe(0.8);
    expect(clampVolumeBoost(5)).toBe(0.05);
    expect(clampVolumeBoost(-3)).toBe(0);
  });

  it("boots with the default without writing it, and saves only what was sent", () => {
    const desk = testDesk();
    try {
      const view = (desk as unknown as { settingsView(): Record<string, unknown> }).settingsView();
      expect(view.volumeBoost).toBe(0.5);
      const saved = (desk as unknown as { readSettings(): Record<string, unknown> }).readSettings();
      expect("volumeBoost" in saved).toBe(false);
      const before = { ...view };
      const res = desk.updateSettings({ volumeBoost: 80 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.settings.volumeBoost).toBe(0.8);
        expect(res.settings.analystMinScore).toBe(before.analystMinScore);
        expect(res.settings.minVolume1hUsd).toBe(before.minVolume1hUsd);
        expect(res.settings.maxTop10Pct).toBe(before.maxTop10Pct);
        expect(res.settings.stopLossPct).toBe(before.stopLossPct);
      }
      expect(desk.updateSettings({ volumeBoost: "abc" }).ok).toBe(false);
      expect(desk.updateSettings({ volumeBoost: 150 }).ok).toBe(false);
      expect(desk.updateSettings({ volumeBoost: 0 }).ok).toBe(true);
    } finally {
      desk.stop();
    }
  });
});

describe("v13.1 tape data", () => {
  it("adds 5m volume and 1h change only when real", () => {
    expect(scoutExtras({})).toBe("");
    expect(scoutExtras({ volume5mUsd: NaN, priceChange1hPct: NaN })).toBe("");
    expect(scoutExtras({ volume5mUsd: 1234.5, priceChange1hPct: -7.25 })).toBe(", 5m volume $1,234.50, 1h change -7.3%");
    expect(scoutExtras({ priceChange1hPct: 12 })).toBe(", 1h change +12.0%");
  });

  it("parses DexScreener 5m volume and 1h change", () => {
    const pair = { chainId: "solana", baseToken: { address: "M", symbol: "M" }, priceUsd: "1", liquidity: { usd: 1000 }, volume: { h1: 500, m5: 40 }, priceChange: { h1: 3.5 }, pairCreatedAt: Date.now() - 7_200_000, dexId: "raydium" };
    const parsed = parseDexPair({ pairs: [pair] }, "M");
    expect(parsed?.volume5mUsd).toBe(40);
    expect(parsed?.priceChange1hPct).toBe(3.5);
    const bare = parseDexPair({ pairs: [{ ...pair, volume: { h1: 500 }, priceChange: undefined }] }, "M");
    expect(bare?.volume5mUsd).toBeUndefined();
    expect(bare?.priceChange1hPct).toBeUndefined();
  });
});
