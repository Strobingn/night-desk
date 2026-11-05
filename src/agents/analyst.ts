import type { AnalystReport, CandidateToken, ScoreFactor, SocialProxy } from "../types.js";
import { VOLUME_BOOST_BAND, type ResolvedRules } from "../rules.js";

/**
 * Weights sum to 1. Applied only to Filter survivors.
 *
 * liquidity — pool depth bands. Deeper locked liquidity scores higher.
 * holders   — top-10 share inside the 20% gate, plus a small breadth bonus.
 * volume    — last-hour notional, with a wash penalty when volume dwarfs liquidity.
 * age       — very new mints are penalized; 30 minutes to 6 hours is the sweet spot.
 * social    — weak proxy only: site, telegram, twitter, mention count. Never enough alone.
 */
export const SCORE_WEIGHTS = {
  liquidity: 0.25,
  holders: 0.25,
  volume: 0.2,
  age: 0.15,
  social: 0.15
} as const;

export function liquidityScore(liquidityUsd: number): { raw: number; note: string } {
  if (liquidityUsd >= 250_000) return { raw: 1, note: "Deep pool, at least $250k." };
  if (liquidityUsd >= 100_000) return { raw: 0.82, note: "Solid pool, $100k–$250k." };
  if (liquidityUsd >= 40_000) return { raw: 0.62, note: "Adequate pool, $40k–$100k." };
  if (liquidityUsd >= 15_000) return { raw: 0.38, note: "Thin pool, $15k–$40k." };
  return { raw: 0.12, note: "Very thin pool, under $15k." };
}

export function holderScore(top10: number | null, holders: number | null): { raw: number; note: string } {
  if (top10 == null) return { raw: 0, note: "Holder distribution missing." };
  let base: number;
  if (top10 <= 0.05) base = 1;
  else if (top10 <= 0.1) base = 0.82;
  else if (top10 <= 0.15) base = 0.64;
  else if (top10 <= 0.2) base = 0.42;
  else base = 0;
  const count = holders ?? 0;
  // Breadth only softens a concentration still inside the gate. It never lifts a zero.
  const bonus = base === 0 ? 0 : count >= 1000 ? 0.08 : count >= 400 ? 0.04 : 0;
  const raw = Math.min(1, base + bonus);
  return {
    raw,
    note: `Top 10 hold ${(top10 * 100).toFixed(1)}% across ${count || "unknown"} holders.`
  };
}

export function volumeScore(volume1hUsd: number, liquidityUsd: number): { raw: number; note: string } {
  let base: number;
  if (volume1hUsd >= 250_000) base = 0.9;
  else if (volume1hUsd >= 100_000) base = 0.72;
  else if (volume1hUsd >= 50_000) base = 0.5;
  else base = 0.1;
  const ratio = liquidityUsd > 0 ? volume1hUsd / liquidityUsd : 99;
  let note = `$${Math.round(volume1hUsd).toLocaleString("en-US")} volume vs $${Math.round(liquidityUsd).toLocaleString("en-US")} liquidity.`;
  if (ratio > 20) {
    base *= 0.7;
    note += " Volume dwarfs liquidity, so the print is discounted as possible wash.";
  } else if (ratio >= 0.4 && ratio <= 8) {
    base = Math.min(1, base + 0.08);
    note += " Turnover sits in a healthy band.";
  }
  return { raw: base, note };
}

export function ageScore(ageSeconds: number): { raw: number; note: string } {
  const minutes = ageSeconds / 60;
  if (minutes < 10) return { raw: 0.2, note: "Under 10 minutes old. Fresh-mint window is hostile." };
  if (minutes < 30) return { raw: 0.55, note: "10–30 minutes old. Still early." };
  if (minutes <= 360) return { raw: 0.92, note: "30 minutes to 6 hours. Preferred age band." };
  if (minutes <= 1440) return { raw: 0.7, note: "6–24 hours old. Momentum may be fading." };
  return { raw: 0.45, note: "Older than a day. Treated as stale for this desk." };
}

export function socialScore(social: SocialProxy): { raw: number; note: string } {
  let raw = 0.15;
  const bits: string[] = [];
  if (social.hasWebsite) {
    raw += 0.25;
    bits.push("site");
  }
  if (social.hasTelegram) {
    raw += 0.2;
    bits.push("telegram");
  }
  if (social.hasTwitter) {
    raw += 0.15;
    bits.push("twitter");
  }
  const mentionBoost = Math.min(0.25, Math.max(0, social.mentions1h) / 80);
  raw += mentionBoost;
  if (social.mentions1h > 0) bits.push(`${social.mentions1h} mentions/h`);
  return {
    raw: Math.min(1, raw),
    note: bits.length ? `Noise proxy: ${bits.join(", ")}.` : "No social surface on the sighting."
  };
}

/**
 * v13.1 volume boost. Log-scaled 1h volume: $10k or less → 0, $100k → half, $1M+ → full.
 * Wash prints (volume over 20× liquidity) get half. Missing, zero or non-finite volume,
 * liquidity or boost → 0. The result is always a finite number from 0 to maxBonus.
 */
export function volumeBoostBonus(volume1hUsd: number, liquidityUsd: number, boost: number | undefined): { bonus: number; strength: number; note: string } {
  const b = typeof boost === "number" && Number.isFinite(boost) ? Math.min(1, Math.max(0, boost)) : 0;
  if (b <= 0) return { bonus: 0, strength: 0, note: "Volume boost off." };
  if (typeof volume1hUsd !== "number" || !Number.isFinite(volume1hUsd) || volume1hUsd <= 0) {
    return { bonus: 0, strength: 0, note: "No volume data, so no boost." };
  }
  if (typeof liquidityUsd !== "number" || !Number.isFinite(liquidityUsd) || liquidityUsd <= 0) {
    return { bonus: 0, strength: 0, note: "No liquidity read, so no boost." };
  }
  const lo = Math.log10(VOLUME_BOOST_BAND.floorUsd);
  const hi = Math.log10(VOLUME_BOOST_BAND.fullUsd);
  let strength = Math.min(1, Math.max(0, (Math.log10(volume1hUsd) - lo) / (hi - lo)));
  let note = `Volume boost ${(b * 100).toFixed(0)}%.`;
  if (volume1hUsd / liquidityUsd > 20) {
    strength *= 0.5;
    note += " Halved: volume dwarfs liquidity.";
  }
  const bonus = VOLUME_BOOST_BAND.maxBonus * b * strength;
  if (!Number.isFinite(bonus) || bonus <= 0) return { bonus: 0, strength: 0, note };
  return { bonus: Math.min(VOLUME_BOOST_BAND.maxBonus, bonus), strength, note };
}

export function decideScore(score: number, min: number): "trade" | "reject" {
  // The tolerance only absorbs float error. A true 0.60 summed as 0.5999999999 still trades.
  return score + 1e-9 >= min ? "trade" : "reject";
}

function digits(score: number, line: number): number {
  return score.toFixed(2) === line.toFixed(2) ? 4 : 2;
}

export function roundScore(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function scoreToken(token: CandidateToken, rules: ResolvedRules): AnalystReport {
  const parts = [
    { key: "liquidity" as const, label: "Liquidity quality", weight: SCORE_WEIGHTS.liquidity, ...liquidityScore(token.liquidityUsd) },
    { key: "holders" as const, label: "Holder distribution", weight: SCORE_WEIGHTS.holders, ...holderScore(token.top10HolderPct, token.holderCount) },
    { key: "volume" as const, label: "Volume momentum", weight: SCORE_WEIGHTS.volume, ...volumeScore(token.volume1hUsd, token.liquidityUsd) },
    { key: "age" as const, label: "Age", weight: SCORE_WEIGHTS.age, ...ageScore(token.ageSeconds) },
    { key: "social" as const, label: "Social / noise", weight: SCORE_WEIGHTS.social, ...socialScore(token.social) }
  ];
  const breakdown: ScoreFactor[] = parts.map((p) => ({
    key: p.key,
    label: p.label,
    weight: p.weight,
    raw: roundScore(p.raw),
    contribution: roundScore(p.raw * p.weight),
    note: p.note
  }));
  // Decide on the exact sum. Rounding first would let 0.59996 trade at a 0.60 line.
  const base = parts.reduce((sum, p) => sum + p.raw * p.weight, 0);
  const boost = volumeBoostBonus(token.volume1hUsd, token.liquidityUsd, rules.volumeBoost);
  if (boost.bonus > 0) {
    breakdown.push({
      key: "boost",
      label: "Volume boost",
      weight: roundScore(VOLUME_BOOST_BAND.maxBonus * Math.min(1, Math.max(0, rules.volumeBoost ?? 0))),
      raw: roundScore(boost.strength),
      contribution: roundScore(boost.bonus),
      note: boost.note
    });
  }
  // Fail closed: a non-finite sum scores 0 and is rejected. The boost never lifts a score past 1.
  const summed = base + boost.bonus;
  const exact = Number.isFinite(summed) ? Math.min(1, Math.max(0, summed)) : 0;
  const score = roundScore(exact);
  const decision = decideScore(exact, rules.analystMinScore);
  return {
    token,
    score,
    breakdown,
    decision,
    reason:
      decision === "reject"
        ? {
            code: "SCORE_BELOW_THRESHOLD",
            message: `Score ${exact.toFixed(digits(exact, rules.analystMinScore))} is below the ${rules.analystMinScore.toFixed(digits(exact, rules.analystMinScore))} trade line.`
          }
        : undefined
  };
}
