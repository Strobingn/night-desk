import type { FilterResult, ReasonCode } from "../types.js";
import type { ResolvedRules } from "../rules.js";

/** Absolute slack above the live top-10 cap. 35% allows a card through 40%, not 50%. */
export const HOLDER_NEAR_MISS_SLACK = 0.05;
/** A volume miss qualifies only when the print is at least this share of the floor. */
export const VOLUME_NEAR_MISS_RATIO = 0.7;

const NEVER: ReadonlySet<ReasonCode> = new Set(["MINT_AUTHORITY_ACTIVE", "DEV_RUG_HISTORY"]);

export interface NearMissGate {
  code: "HOLDER_CONCENTRATION" | "VOLUME_TOO_LOW";
  message: string;
}

/**
 * A near miss is exactly one soft miss: top-10 a little over the cap, or 1h volume
 * a little under the floor. Mint authority, a dev rug, an unknown holder print,
 * and any second miss stay hard kills. Unlocked LP is not a near miss.
 */
export function classifyNearMiss(result: FilterResult, rules: ResolvedRules): NearMissGate | null {
  if (result.decision !== "reject" || result.reasons.length !== 1) return null;
  const reason = result.reasons[0];
  if (!reason || NEVER.has(reason.code)) return null;
  if (reason.code === "HOLDER_CONCENTRATION") {
    const pct = result.token.top10HolderPct;
    if (pct == null) return null;
    const cap = rules.maxTop10Pct;
    if (pct > cap && pct <= cap + HOLDER_NEAR_MISS_SLACK) {
      return { code: "HOLDER_CONCENTRATION", message: reason.message };
    }
    return null;
  }
  if (reason.code === "VOLUME_TOO_LOW") {
    const floor = rules.minVolume1hUsd;
    const volume = result.token.volume1hUsd;
    if (floor > 0 && volume >= floor * VOLUME_NEAR_MISS_RATIO && volume < floor) {
      return { code: "VOLUME_TOO_LOW", message: reason.message };
    }
  }
  return null;
}
