import type { CandidateToken, FilterCheck, FilterResult, Rejection, RugLookup } from "../types.js";
import type { ResolvedRules } from "../rules.js";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Hard filter. A token is rejected when ANY check fails.
 * Unknown mint authority and unknown top-10 concentration fail closed.
 * Unknown LP fails closed only once a pool exists. A Pump mint still on the bonding
 * curve has no LP to lock, so that check is skipped.
 * A verified unlocked LP is a hard kill unless `allowUnlockedLp` is set and it is the
 * only miss. That path passes with an LP_UNLOCKED flag. It does not waive mint
 * authority, holder concentration, volume, or a dev rug.
 */
export function evaluateFilter(
  token: CandidateToken,
  rug: RugLookup,
  rules: ResolvedRules,
  options?: {
    allowUnlockedLp?: boolean;
    /** 0 or omitted skips the floor. Unknown or thin liquidity fails closed when the floor is positive. */
    minLiquidityUsd?: number;
    minAgeSeconds?: number;
    /** 0 or omitted means no maximum age. */
    maxAgeSeconds?: number;
    minHolderCount?: number;
    /** Fraction. 0 or omitted skips the gate. Unknown dev holding fails closed when set. */
    maxDevHoldingPct?: number;
  }
): FilterResult {
  const checks: FilterCheck[] = [];

  if (token.mintAuthorityRevoked !== true) {
    checks.push({
      code: "MINT_AUTHORITY_ACTIVE",
      pass: false,
      message:
        token.mintAuthorityRevoked === false
          ? "Mint authority is still active and can inflate supply."
          : "Mint authority could not be verified as revoked. Fail closed."
    });
  } else {
    checks.push({
      code: "MINT_AUTHORITY_ACTIVE",
      pass: true,
      message: "Mint authority is revoked."
    });
  }

  const poolNote = token.lpLockPool ? ` Judged ${token.lpLockPool}.` : "";
  if (token.lpLockedOrBurned === false) {
    checks.push({
      code: "LP_NOT_LOCKED",
      pass: false,
      message: `LP is not locked or burned, so the pool can be pulled.${poolNote}`
    });
  } else if (token.lpLockedOrBurned == null && token.onBondingCurve) {
    checks.push({
      code: "LP_NOT_LOCKED",
      pass: true,
      message: "Still on the Pump bonding curve. No pool LP to lock yet, so the LP check is skipped."
    });
  } else if (token.lpLockedOrBurned !== true) {
    checks.push({
      code: "LP_NOT_LOCKED",
      pass: false,
      message: "LP lock or burn could not be verified. Fail closed."
    });
  } else {
    const extra =
      token.lpLockPct != null ? ` Lock reported at ${token.lpLockPct >= 1 ? token.lpLockPct.toFixed(0) : (token.lpLockPct * 100).toFixed(0)}%.` : "";
    checks.push({
      code: "LP_NOT_LOCKED",
      pass: true,
      message: `LP is locked or burned.${extra}${poolNote}`
    });
  }

  const holderPct = token.top10HolderPct;
  const holdersKnown = typeof holderPct === "number" && Number.isFinite(holderPct);
  if (!holdersKnown) {
    checks.push({
      code: "HOLDER_CONCENTRATION",
      pass: false,
      message: "Top 10 holder concentration could not be verified. Fail closed."
    });
  } else if (holderPct > rules.maxTop10Pct) {
    checks.push({
      code: "HOLDER_CONCENTRATION",
      pass: false,
      message: `Top 10 holders control ${pct(holderPct)} of supply (limit ${pct(rules.maxTop10Pct)}).`
    });
  } else {
    checks.push({
      code: "HOLDER_CONCENTRATION",
      pass: true,
      message: `Top 10 holders control ${pct(holderPct)} of supply.`
    });
  }

  if (!(token.volume1hUsd >= rules.minVolume1hUsd)) {
    checks.push({
      code: "VOLUME_TOO_LOW",
      pass: false,
      message: `One-hour volume is ${usd(token.volume1hUsd || 0)} (minimum ${usd(rules.minVolume1hUsd)}).`
    });
  } else {
    checks.push({
      code: "VOLUME_TOO_LOW",
      pass: true,
      message: `One-hour volume is ${usd(token.volume1hUsd)}.`
    });
  }

  const minLiquidity = options?.minLiquidityUsd ?? 0;
  if (minLiquidity > 0) {
    if (!(token.liquidityUsd >= minLiquidity)) {
      checks.push({
        code: "LIQUIDITY_TOO_THIN",
        pass: false,
        message: `Liquidity is ${usd(token.liquidityUsd || 0)} (minimum ${usd(minLiquidity)}).`
      });
    } else {
      checks.push({
        code: "LIQUIDITY_TOO_THIN",
        pass: true,
        message: `Liquidity is ${usd(token.liquidityUsd)}.`
      });
    }
  }

  const minAge = options?.minAgeSeconds ?? 0;
  if (minAge > 0) {
    if (!(token.ageSeconds >= minAge)) {
      checks.push({
        code: "TOKEN_TOO_NEW",
        pass: false,
        message: `Token age is ${Math.floor((token.ageSeconds || 0) / 60)} min (minimum ${Math.floor(minAge / 60)} min).`
      });
    } else {
      checks.push({
        code: "TOKEN_TOO_NEW",
        pass: true,
        message: `Token age is ${Math.floor(token.ageSeconds / 60)} min.`
      });
    }
  }

  const maxAge = options?.maxAgeSeconds ?? 0;
  if (maxAge > 0) {
    if (!(Number.isFinite(token.ageSeconds) && token.ageSeconds <= maxAge)) {
      checks.push({
        code: "TOKEN_TOO_OLD",
        pass: false,
        message: Number.isFinite(token.ageSeconds)
          ? `Token age is ${Math.floor(token.ageSeconds / 60)} min (maximum ${Math.floor(maxAge / 60)} min).`
          : "Token age could not be verified. Fail closed."
      });
    } else {
      checks.push({
        code: "TOKEN_TOO_OLD",
        pass: true,
        message: `Token age is ${Math.floor(token.ageSeconds / 60)} min.`
      });
    }
  }

  const minHolders = options?.minHolderCount ?? 0;
  if (minHolders > 0) {
    const countLabel =
      typeof token.holderCount === "number" ? (token.holderCountAtLeast ? `${token.holderCount}+` : String(token.holderCount)) : null;
    if (!(typeof token.holderCount === "number" && token.holderCount >= minHolders)) {
      checks.push({
        code: "HOLDER_COUNT",
        pass: false,
        message:
          countLabel == null
            ? "Holder count could not be verified. Fail closed."
            : `Holder count is ${countLabel} (minimum ${minHolders}).`
      });
    } else {
      checks.push({
        code: "HOLDER_COUNT",
        pass: true,
        message: `Holder count is ${countLabel}.`
      });
    }
  }

  const maxDev = options?.maxDevHoldingPct ?? 0;
  if (maxDev > 0) {
    const held = token.devHoldingPct;
    const bound = token.devHoldingUpperBound === true;
    if (!(typeof held === "number" && Number.isFinite(held) && held <= maxDev)) {
      checks.push({
        code: "DEV_HOLDING",
        pass: false,
        message:
          typeof held === "number" && Number.isFinite(held)
            ? bound
              ? `Dev wallet holds at most ${pct(held)} (limit ${pct(maxDev)}).`
              : `Dev wallet holds ${pct(held)} (limit ${pct(maxDev)}).`
            : "Dev holding could not be verified. Fail closed."
      });
    } else {
      checks.push({
        code: "DEV_HOLDING",
        pass: true,
        message: bound ? `Dev wallet holds at most ${pct(held)}.` : `Dev wallet holds ${pct(held)}.`
      });
    }
  }

  const rugHit = rug.status === "rugged" || token.devRug?.rugged === true;
  if (rugHit) {
    const evidence = rug.status === "rugged" ? rug.evidence : token.devRug?.evidence;
    checks.push({
      code: "DEV_RUG_HISTORY",
      pass: false,
      message: evidence
        ? `Dev wallet is linked to a previous rug (${evidence}).`
        : "Dev wallet is linked to a previous rug."
    });
  } else if (!token.devWallet && !token.devRug) {
    checks.push({
      code: "DEV_RUG_HISTORY",
      pass: true,
      message: "No dev wallet on the sighting. Rug-link check skipped."
    });
  } else {
    checks.push({
      code: "DEV_RUG_HISTORY",
      pass: true,
      message: "Dev wallet has no known rug link in the registry."
    });
  }

  const reasons: Rejection[] = checks.filter((c) => !c.pass).map((c) => ({ code: c.code, message: c.message }));
  const onlyUnlockedLp =
    options?.allowUnlockedLp === true &&
    reasons.length === 1 &&
    reasons[0]?.code === "LP_NOT_LOCKED" &&
    token.lpLockedOrBurned === false;
  if (onlyUnlockedLp) {
    const flagged = checks.map((check) =>
      check.code === "LP_NOT_LOCKED"
        ? {
            ...check,
            pass: true,
            message: "LP is unlocked. Allowed by the desk setting and flagged. The pool can still be pulled."
          }
        : check
    );
    return { token, decision: "pass", checks: flagged, reasons: [], flags: ["LP_UNLOCKED"] };
  }
  return {
    token,
    decision: reasons.length ? "reject" : "pass",
    checks,
    reasons
  };
}
