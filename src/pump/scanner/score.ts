/**
 * Hot-coin score for new pump.fun coins.
 * A rug flag forces the score to 0 no matter how strong the other factors are.
 */

export const RUG_LIMITS = {
  devHoldingPct: 0.1,
  top10HoldingPct: 0.3
} as const;

export const SCORE_SCALES = {
  volumeLamports: 10_000_000_000,
  uniqueBuyers: 40,
  holderGrowth: 25,
  ageMs: 30 * 60 * 1000
} as const;

export const SCORE_WEIGHTS = {
  volume: 0.25,
  progress: 0.15,
  buySell: 0.2,
  uniqueBuyers: 0.15,
  holderGrowth: 0.15,
  age: 0.1
} as const;

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export interface ScanInput {
  mint: string;
  symbol?: string;
  createdAt: number;
  volumeLamports: number;
  progressPct: number;
  buyLamports: number;
  sellLamports: number;
  uniqueBuyers: number;
  holderGrowth: number;
  devHoldingPct?: number | null;
  top10HoldingPct?: number | null;
  /** Set when the mint account still has a mint authority. */
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  creatorDumping?: boolean;
}

export interface ScoredCoin extends ScanInput {
  score: number;
  rug: string[];
}

export function rugReasons(coin: ScanInput): string[] {
  const reasons: string[] = [];
  if (coin.devHoldingPct != null && coin.devHoldingPct > RUG_LIMITS.devHoldingPct) reasons.push("dev holding");
  if (coin.top10HoldingPct != null && coin.top10HoldingPct > RUG_LIMITS.top10HoldingPct) reasons.push("top 10 holding");
  if (authorityLive(coin.mintAuthority)) reasons.push("mint authority");
  if (authorityLive(coin.freezeAuthority)) reasons.push("freeze authority");
  if (coin.creatorDumping) reasons.push("creator dumping");
  return reasons;
}

export function scoreCoin(coin: ScanInput, now: number): { score: number; rug: string[] } {
  const rug = rugReasons(coin);
  if (rug.length) return { score: 0, rug };
  const volume = unit(coin.volumeLamports / SCORE_SCALES.volumeLamports);
  const progress = unit((coin.progressPct ?? 0) / 100);
  const flow = (coin.buyLamports ?? 0) + (coin.sellLamports ?? 0);
  const buySell = flow <= 0 ? 0 : unit(coin.buyLamports / flow);
  const buyers = unit(coin.uniqueBuyers / SCORE_SCALES.uniqueBuyers);
  const holders = unit(coin.holderGrowth / SCORE_SCALES.holderGrowth);
  const ageMs = Math.max(0, now - (coin.createdAt ?? now));
  const age = 1 - unit(ageMs / SCORE_SCALES.ageMs);
  const w = SCORE_WEIGHTS;
  const score = volume * w.volume + progress * w.progress + buySell * w.buySell + buyers * w.uniqueBuyers + holders * w.holderGrowth + age * w.age;
  return { score: round(score), rug: [] };
}

export function rankCoins(coins: readonly ScanInput[], now: number, limit = 20): ScoredCoin[] {
  const scored = coins.map((coin) => {
    const result = scoreCoin(coin, now);
    return { ...coin, score: result.score, rug: result.rug };
  });
  scored.sort((a, b) => b.score - a.score || a.mint.localeCompare(b.mint));
  return scored.slice(0, Math.max(0, limit));
}

function authorityLive(value: string | null | undefined): boolean {
  if (value == null) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== SYSTEM_PROGRAM;
}

function unit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
