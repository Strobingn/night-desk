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
 * curve has no LP to lock, so that check is skipped. A verified unlocked LP still rejects.
 * Dev-rug linkage is enforced when a wallet or an upstream rug hint is present.
 */
export function evaluateFilter(token: CandidateToken, rug: RugLookup, rules: ResolvedRules): FilterResult {
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
  } else if (token.freezeAuthorityRevoked === false) {
    checks.push({
      code: "MINT_AUTHORITY_ACTIVE",
      pass: false,
      message: "Freeze authority is still active (honeypot vector)."
    });
  } else {
    checks.push({
      code: "MINT_AUTHORITY_ACTIVE",
      pass: true,
      message: "Mint authority is revoked."
    });
  }

  if (token.lpLockedOrBurned === false) {
    checks.push({
      code: "LP_NOT_LOCKED",
      pass: false,
      message: "LP is not locked or burned, so the pool can be pulled."
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
      message: `LP is locked or burned.${extra}`
    });
  }

  const holderPct = token.top10HolderPct;
  const holdersKnown = typeof holderPct === "number" && Number.isFinite(holderPct);
  const entropy = token.shannonEntropyNormalized;
  const bundleRatio = token.blockZeroBundleRatio;
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
  } else if (typeof bundleRatio === "number" && bundleRatio > 0.22) {
    checks.push({
      code: "HOLDER_CONCENTRATION",
      pass: false,
      message: `Block-0 dev bundle sniped ${pct(bundleRatio)} of total supply (limit 22.0%).`
    });
  } else if (typeof entropy === "number" && (token.holderCount ?? 0) >= 15 && entropy > 0.985) {
    checks.push({
      code: "HOLDER_CONCENTRATION",
      pass: false,
      message: `Sybil bundle detected: uniform holder Shannon entropy (${entropy.toFixed(3)} > 0.985).`
    });
  } else if (typeof entropy === "number" && (token.holderCount ?? 0) >= 5 && entropy < 0.45) {
    checks.push({
      code: "HOLDER_CONCENTRATION",
      pass: false,
      message: `Whale anomaly detected: low holder Shannon entropy (${entropy.toFixed(3)} < 0.45).`
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
  return {
    token,
    decision: reasons.length ? "reject" : "pass",
    checks,
    reasons
  };
}
