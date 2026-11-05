import { Connection, PublicKey } from "@solana/web3.js";
import { unpackMint } from "@solana/spl-token";

export interface TokenSafetyReport {
  safe: boolean;
  riskScore: number; // 0 (Safest) to 100 (Guaranteed Rug)
  shannonEntropyNormalized: number;
  blockZeroBundleRatio: number;
  top10HolderPercentage: number;
  reasons: string[];
}

export interface FundingTransfer {
  holderAddress: string;
  funderAddress: string;
  timestampMs: number;
}

/**
 * Pure helper to compute Normalized Shannon Entropy H_norm in [0, 1]
 * across N holder balances.
 */
export function calculateNormalizedShannonEntropy(balances: number[]): number {
  const positive = balances.filter((b) => Number.isFinite(b) && b > 0);
  const N = positive.length;
  if (N <= 1) return 0;

  const total = positive.reduce((s, a) => s + a, 0);
  if (total <= 0) return 0;

  let rawEntropy = 0;
  for (const amount of positive) {
    const p_i = amount / total;
    if (p_i > 0) {
      rawEntropy -= p_i * Math.log(p_i);
    }
  }
  return rawEntropy / Math.log(N);
}

/**
 * 1-Hop Funding Graph Ancestor Check:
 * Detects whether multiple top holders received initial SOL funding from the same
 * parent wallet within a rolling time window (default 30 minutes).
 */
export function detectCommonFundingAncestor(
  transfers: FundingTransfer[],
  nowMs: number = Date.now(),
  windowMs: number = 30 * 60 * 1000
): { sybilClusterDetected: boolean; dominantFunder?: string; fundedHolderCount: number } {
  const byFunder = new Map<string, Set<string>>();

  for (const tx of transfers) {
    if (!tx.funderAddress || !tx.holderAddress) continue;
    if (nowMs - tx.timestampMs > windowMs) continue;
    let holders = byFunder.get(tx.funderAddress);
    if (!holders) {
      holders = new Set<string>();
      byFunder.set(tx.funderAddress, holders);
    }
    holders.add(tx.holderAddress);
  }

  let dominantFunder: string | undefined;
  let maxCount = 0;
  for (const [funder, holders] of byFunder.entries()) {
    if (holders.size > maxCount) {
      maxCount = holders.size;
      dominantFunder = funder;
    }
  }

  return {
    sybilClusterDetected: maxCount >= 3,
    dominantFunder: maxCount >= 3 ? dominantFunder : undefined,
    fundedHolderCount: maxCount,
  };
}

export async function analyzeMemeCoinSafety(
  connection: Connection,
  mintAddress: string,
  knownLiquidityPoolAddress?: string,
  blockZeroBuyerSupplyAmount: number = 0,
  recentFundingTransfers: FundingTransfer[] = []
): Promise<TokenSafetyReport> {
  const reasons: string[] = [];
  let riskScore = 0;
  const mintPubkey = new PublicKey(mintAddress);

  const [accountInfo, largestAccounts] = await Promise.all([
    connection.getAccountInfo(mintPubkey, "processed"),
    connection.getTokenLargestAccounts(mintPubkey, "processed"),
  ]);

  if (!accountInfo) {
    return {
      safe: false,
      riskScore: 100,
      shannonEntropyNormalized: 0,
      blockZeroBundleRatio: 1,
      top10HolderPercentage: 100,
      reasons: ["Mint account does not exist on-chain."],
    };
  }

  const mintData = unpackMint(mintPubkey, accountInfo);

  // 1. Authority Checks
  if (mintData.mintAuthority !== null) {
    riskScore += 55;
    reasons.push("CRITICAL: Mint authority enabled (Infinite inflation vector).");
  }
  if (mintData.freezeAuthority !== null) {
    riskScore += 55;
    reasons.push("CRITICAL: Freeze authority enabled (Honeypot vector).");
  }

  // 2. Filter out AMM Liquidity Pool & Extract Non-LP Holders (Top N = 25)
  const totalSupply = Number(mintData.supply);
  const nonLpHolders = largestAccounts.value
    .filter(
      (acc) => acc.address.toBase58() !== knownLiquidityPoolAddress && Number(acc.amount) > 0
    )
    .slice(0, 25);

  const top10Balance = nonLpHolders
    .slice(0, 10)
    .reduce((sum, acc) => sum + Number(acc.amount), 0);
  const top10Percentage = totalSupply > 0 ? (top10Balance / totalSupply) * 100 : 100;

  if (top10Percentage > 28) {
    riskScore += 35;
    reasons.push(`HIGH RISK: Top 10 wallets control ${top10Percentage.toFixed(1)}% of supply.`);
  }

  // 3. Normalized Shannon Entropy Calculation across Top N Holders
  // Detects both extreme whale concentration (<0.45) and scripted Sybil splitting (>0.985)
  const N = nonLpHolders.length;
  const totalNonLpHeld = nonLpHolders.reduce((s, a) => s + Number(a.amount), 0);
  let shannonEntropyNormalized = 0;

  if (N > 1 && totalNonLpHeld > 0) {
    let rawEntropy = 0;
    for (const holder of nonLpHolders) {
      const p_i = Number(holder.amount) / totalNonLpHeld;
      if (p_i > 0) {
        rawEntropy -= p_i * Math.log(p_i);
      }
    }
    shannonEntropyNormalized = rawEntropy / Math.log(N);

    if (shannonEntropyNormalized < 0.45) {
      riskScore += 30;
      reasons.push(
        `WHALE ANOMALY: Low holder entropy (${shannonEntropyNormalized.toFixed(3)}) indicates extreme concentration.`
      );
    } else if (N >= 15 && shannonEntropyNormalized > 0.985) {
      riskScore += 40;
      reasons.push(
        `SYBIL BUNDLE DETECTED: Unnaturally uniform holder distribution (H = ${shannonEntropyNormalized.toFixed(3)}).`
      );
    }
  }

  // 4. Block-0 Genesis Bundle Ratio Check
  const blockZeroBundleRatio =
    totalSupply > 0 ? blockZeroBuyerSupplyAmount / totalSupply : 0;
  if (blockZeroBundleRatio > 0.22) {
    riskScore += 45;
    reasons.push(
      `DEV BUNDLE: ${(blockZeroBundleRatio * 100).toFixed(1)}% of total supply was sniped in Block 0.`
    );
  }

  // 5. Optional 1-Hop Funding Graph Ancestor Check
  if (recentFundingTransfers.length > 0) {
    const fundingCheck = detectCommonFundingAncestor(recentFundingTransfers);
    if (fundingCheck.sybilClusterDetected) {
      riskScore += 40;
      reasons.push(
        `FUNDING SYBIL CLUSTER: ${fundingCheck.fundedHolderCount} top holders funded by ${fundingCheck.dominantFunder} within 30m.`
      );
    }
  }

  return {
    safe: riskScore < 35,
    riskScore: Math.min(riskScore, 100),
    shannonEntropyNormalized: Number(shannonEntropyNormalized.toFixed(4)),
    blockZeroBundleRatio: Number(blockZeroBundleRatio.toFixed(4)),
    top10HolderPercentage: Number(top10Percentage.toFixed(2)),
    reasons,
  };
}
