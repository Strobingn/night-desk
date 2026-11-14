import { outlierReason, markUnusable, unitScale } from "./mark-guard.js";
import type { RawSighting } from "../types.js";

/**
 * Reads a passing enrich spends on the RPC host before Filter ever runs:
 * getAccountInfo, getTokenLargestAccounts, and getMultipleAccounts.
 * Helius DAS holder pages are extra and stay off unless holderPagesMax is set.
 * This stage does not change any of those calls. It skips them.
 */
export const ENRICH_RPC_PER_COIN = 3;

/** One soft recheck, aligned with the existing recheck window's upper bound. */
export const PREFILTER_BACKOFF_MS = 5 * 60_000;

const SOFT_CODES = new Set(["VOLUME_TOO_LOW", "LIQUIDITY_TOO_THIN", "TOKEN_TOO_NEW"]);

export interface PrefilterThresholds {
  minVolume1hUsd: number;
  /** 0 skips the floor, the same way Filter does. */
  minLiquidityUsd: number;
  /** 0 skips the floor. */
  minAgeSeconds: number;
  /** 0 means no maximum. */
  maxAgeSeconds: number;
  /**
   * The desk has no configured market-cap floor or ceiling (mcap is display-only).
   * 0 leaves the check off. A non-zero value would be an existing setting; none is invented here.
   */
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  bannedMints: ReadonlySet<string>;
}

export interface PrefilterReason {
  code: string;
  message: string;
}

export type PrefilterDecision =
  | { action: "pass" }
  | { action: "wait"; missing: string }
  | { action: "kill"; hard: boolean; reasons: PrefilterReason[] };

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Symbol or name that cannot be a ticker. A blank identity is not junk; a later free print may name it.
 * DexScreener profiles put the description in `name`. A URL in that blurb is not a junk ticker.
 */
export function junkIdentity(symbol?: string, name?: string): boolean {
  const s = (symbol ?? "").trim();
  const n = (name ?? "").trim();
  if (!s && !n) return false;
  if (s && (/https?:\/\/|www\./i.test(s) || !/[A-Za-z0-9]/.test(s))) return true;
  if (!s && n && !/[A-Za-z0-9]/.test(n)) return true;
  return false;
}

export function sightingAgeSeconds(raw: Pick<RawSighting, "createdAt" | "ageSeconds">, now: number): number | null {
  if (typeof raw.ageSeconds === "number" && Number.isFinite(raw.ageSeconds) && raw.ageSeconds >= 0) return raw.ageSeconds;
  if (typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) && raw.createdAt > 0) {
    return Math.max(0, (now - raw.createdAt) / 1000);
  }
  return null;
}

/**
 * Cheap gates that Filter already applies, using only numbers already on the free payload.
 * A missing number waits for one later free print. It does not invent a threshold.
 */
export function prefilterFree(raw: RawSighting, t: PrefilterThresholds, now: number, priorPriceUsd = 0): PrefilterDecision {
  const reasons: PrefilterReason[] = [];
  if (t.bannedMints.has(raw.mint)) {
    reasons.push({ code: "BANNED", message: "Mint is still on the hard-stop ban list." });
  }
  if (junkIdentity(raw.symbol, raw.name)) {
    reasons.push({ code: "JUNK_NAME", message: "Symbol or name is not a ticker." });
  }
  if (typeof raw.priceUsd === "number" && markUnusable(raw.priceUsd)) {
    reasons.push({ code: "PRICE_UNUSABLE", message: "Listing price is not a usable number." });
  } else if (
    priorPriceUsd > 0 &&
    typeof raw.priceUsd === "number" &&
    raw.priceUsd > 0 &&
    (unitScale(raw.priceUsd / priorPriceUsd) || outlierReason(priorPriceUsd, raw.priceUsd) === "unit")
  ) {
    reasons.push({ code: "PRICE_UNUSABLE", message: "Listing price jumped by a decimals or SOL/USD scale factor." });
  }

  const volKnown = typeof raw.volume1hUsd === "number" && Number.isFinite(raw.volume1hUsd);
  if (volKnown && !(raw.volume1hUsd! >= t.minVolume1hUsd)) {
    reasons.push({
      code: "VOLUME_TOO_LOW",
      message: `One-hour volume is ${usd(raw.volume1hUsd || 0)} (minimum ${usd(t.minVolume1hUsd)}).`
    });
  }
  const liqKnown = typeof raw.liquidityUsd === "number" && Number.isFinite(raw.liquidityUsd);
  if (t.minLiquidityUsd > 0 && liqKnown && !(raw.liquidityUsd! >= t.minLiquidityUsd)) {
    reasons.push({
      code: "LIQUIDITY_TOO_THIN",
      message: `Liquidity is ${usd(raw.liquidityUsd || 0)} (minimum ${usd(t.minLiquidityUsd)}).`
    });
  }
  const age = sightingAgeSeconds(raw, now);
  if (t.minAgeSeconds > 0 && age != null && !(age >= t.minAgeSeconds)) {
    reasons.push({
      code: "TOKEN_TOO_NEW",
      message: `Token age is ${Math.floor(age / 60)} min (minimum ${Math.floor(t.minAgeSeconds / 60)} min).`
    });
  }
  if (t.maxAgeSeconds > 0 && age != null && !(age <= t.maxAgeSeconds)) {
    reasons.push({
      code: "TOKEN_TOO_OLD",
      message: `Token age is ${Math.floor(age / 60)} min (maximum ${Math.floor(t.maxAgeSeconds / 60)} min).`
    });
  }
  const mcapKnown = typeof raw.marketCapUsd === "number" && Number.isFinite(raw.marketCapUsd);
  if (t.minMarketCapUsd > 0 && mcapKnown && !(raw.marketCapUsd! >= t.minMarketCapUsd)) {
    reasons.push({
      code: "MCAP_TOO_LOW",
      message: `Market cap is ${usd(raw.marketCapUsd || 0)} (minimum ${usd(t.minMarketCapUsd)}).`
    });
  }
  if (t.maxMarketCapUsd > 0 && mcapKnown && raw.marketCapUsd! > t.maxMarketCapUsd) {
    reasons.push({
      code: "MCAP_TOO_HIGH",
      message: `Market cap is ${usd(raw.marketCapUsd || 0)} (maximum ${usd(t.maxMarketCapUsd)}).`
    });
  }

  if (reasons.length) {
    return { action: "kill", hard: reasons.some((reason) => !SOFT_CODES.has(reason.code)), reasons };
  }
  if (!volKnown) return { action: "wait", missing: "volume1hUsd" };
  if (t.minLiquidityUsd > 0 && !liqKnown) return { action: "wait", missing: "liquidityUsd" };
  if ((t.minAgeSeconds > 0 || t.maxAgeSeconds > 0) && age == null) return { action: "wait", missing: "age" };
  if ((t.minMarketCapUsd > 0 || t.maxMarketCapUsd > 0) && !mcapKnown) return { action: "wait", missing: "marketCapUsd" };
  return { action: "pass" };
}

/** Higher is a better use of a busy enrich slot: free-feed volume, then volume per dollar of liquidity. */
export function freeFeedScore(raw: Pick<RawSighting, "volume1hUsd" | "liquidityUsd">): number {
  const vol = raw.volume1hUsd ?? 0;
  const liq = raw.liquidityUsd ?? 0;
  if (!(vol > 0) && !(liq > 0)) return 0;
  const momentum = liq > 0 && vol > 0 ? vol / liq : 0;
  return vol + momentum * 1_000;
}

interface SoftKill {
  at: number;
  volume: number;
  used: boolean;
}

/**
 * A hard kill is never enriched again.
 * A soft kill (volume, thin liquidity, too new) gets one enrich after the backoff,
 * and only when free-feed volume has grown past the floor.
 */
export class KillMemory {
  private readonly hard = new Set<string>();
  private readonly soft = new Map<string, SoftKill>();
  hardKills = 0;
  softKills = 0;
  rechecks = 0;
  blocked = 0;

  note(mint: string, hard: boolean, now: number, volume: number): void {
    if (this.hard.has(mint)) return;
    if (hard) {
      this.hard.add(mint);
      this.soft.delete(mint);
      this.hardKills += 1;
      return;
    }
    if (this.soft.has(mint)) return;
    this.soft.set(mint, { at: now, volume, used: false });
    this.softKills += 1;
  }

  /**
   * `fresh` — never killed.
   * `block` — stay off the RPC lanes.
   * `enrich` — the single soft recheck.
   */
  admit(mint: string, now: number, volume: number, thresholds: PrefilterThresholds, ageSeconds: number | null): "fresh" | "block" | "enrich" {
    if (this.hard.has(mint)) {
      this.blocked += 1;
      return "block";
    }
    const row = this.soft.get(mint);
    if (!row) return "fresh";
    if (row.used || now - row.at < PREFILTER_BACKOFF_MS) {
      this.blocked += 1;
      return "block";
    }
    const volumeGrew = volume >= thresholds.minVolume1hUsd && volume > row.volume;
    const ageOk = !(thresholds.minAgeSeconds > 0) || (ageSeconds != null && ageSeconds >= thresholds.minAgeSeconds);
    if (!volumeGrew || !ageOk) {
      this.blocked += 1;
      return "block";
    }
    return "enrich";
  }

  /** A hard kill. Nothing brings this coin back to enrich. */
  isHard(mint: string): boolean {
    return this.hard.has(mint);
  }

  /** The one soft recheck is spent only once the free gates pass and enrich is queued. */
  commit(mint: string): void {
    const row = this.soft.get(mint);
    if (!row || row.used) return;
    row.used = true;
    this.rechecks += 1;
  }
}

export interface RpcMix {
  sightingsPerMin: number;
  /** Share that pass the free gates and still take a 3-call enrich. */
  enrichShare: number;
  /** Priority-0 curve/mark reads for coins that are not held and not watched. */
  strayChainMarksPerMin: number;
  /** Held and watch marks. These stay. */
  keptChainMarksPerMin: number;
}

/** Demand, not the 18/min cap. The cap still clips what is actually sent. */
export function estimateRpcDemand(mix: RpcMix): { beforePerMin: number; afterPerMin: number } {
  const enrichBefore = mix.sightingsPerMin * ENRICH_RPC_PER_COIN;
  const enrichAfter = mix.sightingsPerMin * mix.enrichShare * ENRICH_RPC_PER_COIN;
  return {
    beforePerMin: enrichBefore + mix.strayChainMarksPerMin + mix.keptChainMarksPerMin,
    afterPerMin: enrichAfter + mix.keptChainMarksPerMin
  };
}
