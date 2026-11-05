export interface HistoricalTrade {
  pnlSol: number;
  returnMultiple: number; // e.g., +1.5 for +150% gain, -0.5 for -50% loss
  timestampMs: number;
}

export interface WalletScoreMetrics {
  walletAddress: string;
  compositeScore: number;
  weightedWinRate: number;
  weightedPayoffRatio: number;
  sortinoRatio: number;
}

export interface ClusterWalletBuy {
  walletAddress: string;
  walletScore: number;
  buyTimestampMs: number;
  winProbability?: number;
  payoffRatio?: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DECAY_LAMBDA = Math.LN2 / SEVEN_DAYS_MS; // 7-day half-life
const CLUSTER_WINDOW_MS = 90_000; // 90-second rolling convergence window
const CLUSTER_DECAY_GAMMA = Math.LN2 / 45_000; // 45-second half-life inside the 90s window

/**
 * Computes time-decayed Sortino & Win-Rate Composite Score W_k for an alpha wallet
 */
export function evaluateAlphaWallet(
  walletAddress: string,
  trades: HistoricalTrade[],
  nowMs: number = Date.now()
): WalletScoreMetrics {
  if (trades.length < 5) {
    return {
      walletAddress,
      compositeScore: 0,
      weightedWinRate: 0,
      weightedPayoffRatio: 0,
      sortinoRatio: 0,
    };
  }

  let weightSum = 0;
  let winWeightSum = 0;
  let weightedReturnSum = 0;
  let weightedWinReturnSum = 0;
  let weightedLossReturnSum = 0;
  let lossWeightSum = 0;
  let totalRealizedSol = 0;

  const weights: number[] = [];

  for (const t of trades) {
    const ageMs = Math.max(0, nowMs - t.timestampMs);
    const w = Math.exp(-DECAY_LAMBDA * ageMs);
    weights.push(w);

    weightSum += w;
    weightedReturnSum += w * t.returnMultiple;
    totalRealizedSol += t.pnlSol;

    if (t.returnMultiple > 0) {
      winWeightSum += w;
      weightedWinReturnSum += w * t.returnMultiple;
    } else {
      lossWeightSum += w;
      weightedLossReturnSum += w * Math.abs(t.returnMultiple);
    }
  }

  if (totalRealizedSol <= 0 || weightSum === 0) {
    return {
      walletAddress,
      compositeScore: 0,
      weightedWinRate: 0,
      weightedPayoffRatio: 0,
      sortinoRatio: 0,
    };
  }

  const weightedWinRate = winWeightSum / weightSum;
  const meanReturn = weightedReturnSum / weightSum;

  // Downside semi-variance (Sortino denominator: only penalizes negative returns)
  let downsideVarianceSum = 0;
  for (let i = 0; i < trades.length; i++) {
    const r = trades[i].returnMultiple;
    if (r < 0) {
      downsideVarianceSum += weights[i] * r * r;
    }
  }
  const downsideDeviation = Math.sqrt(downsideVarianceSum / weightSum) + 0.05;
  const sortinoRatio = Math.max(0, meanReturn / downsideDeviation);

  const avgWin = winWeightSum > 0 ? weightedWinReturnSum / winWeightSum : 0;
  const avgLoss = lossWeightSum > 0 ? weightedLossReturnSum / lossWeightSum : 1;
  const weightedPayoffRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin;

  const compositeScore =
    weightedWinRate * sortinoRatio * Math.log(1 + Math.max(0, totalRealizedSol));

  return {
    walletAddress,
    compositeScore: Number(compositeScore.toFixed(4)),
    weightedWinRate: Number(weightedWinRate.toFixed(4)),
    weightedPayoffRatio: Number(weightedPayoffRatio.toFixed(4)),
    sortinoRatio: Number(sortinoRatio.toFixed(4)),
  };
}

/**
 * Computes Multi-Wallet Convergence Signal C_token(t):
 * C_token(t) = sum_{k in Buyers} W_k * exp(-gamma * (t - t_{buy,k}))
 * over a rolling 90-second window.
 */
export function calculateClusterConvergenceSignal(
  buys: ClusterWalletBuy[],
  nowMs: number = Date.now(),
  windowMs: number = CLUSTER_WINDOW_MS
): {
  convergenceSignal: number;
  activeBuyerCount: number;
  clusterWinProbability: number;
  clusterPayoffRatio: number;
} {
  const uniqueByWallet = new Map<string, ClusterWalletBuy>();
  for (const buy of buys) {
    const age = nowMs - buy.buyTimestampMs;
    if (age < 0 || age > windowMs || buy.walletScore <= 0) continue;
    const prev = uniqueByWallet.get(buy.walletAddress);
    if (!prev || buy.buyTimestampMs > prev.buyTimestampMs) {
      uniqueByWallet.set(buy.walletAddress, buy);
    }
  }

  let signal = 0;
  let scoreWeightSum = 0;
  let weightedWinProb = 0;
  let weightedPayoff = 0;

  for (const buy of uniqueByWallet.values()) {
    const dt = Math.max(0, nowMs - buy.buyTimestampMs);
    const decayedScore = buy.walletScore * Math.exp(-CLUSTER_DECAY_GAMMA * dt);
    signal += decayedScore;
    scoreWeightSum += decayedScore;
    weightedWinProb += decayedScore * (buy.winProbability ?? 0.55);
    weightedPayoff += decayedScore * (buy.payoffRatio ?? 2.0);
  }

  return {
    convergenceSignal: Number(signal.toFixed(4)),
    activeBuyerCount: uniqueByWallet.size,
    clusterWinProbability:
      scoreWeightSum > 0 ? Number((weightedWinProb / scoreWeightSum).toFixed(4)) : 0,
    clusterPayoffRatio:
      scoreWeightSum > 0 ? Number((weightedPayoff / scoreWeightSum).toFixed(4)) : 0,
  };
}

/**
 * Quarter-Kelly Position Sizer: f* = 0.25 * (p - (1 - p) / b)
 * Caps single-trade allocation at 8% of active bankroll
 */
export function calculateFractionalKellyAllocationSol(params: {
  bankrollSol: number;
  winProbability: number;
  payoffRatio: number;
  kellyFraction?: number;
  maxBankrollCapPct?: number;
}): number {
  const {
    bankrollSol,
    winProbability: p,
    payoffRatio: b,
    kellyFraction = 0.25,
    maxBankrollCapPct = 0.08,
  } = params;

  if (b <= 0 || p <= 0 || bankrollSol <= 0) return 0;

  const fullKelly = p - (1 - p) / b;
  if (fullKelly <= 0) return 0; // Negative expectancy -> Do not trade

  const optimalFraction = Math.min(maxBankrollCapPct, kellyFraction * fullKelly);
  return Number((bankrollSol * optimalFraction).toFixed(4));
}
