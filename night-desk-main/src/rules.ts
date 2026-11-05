/**
 * Hard floors. Environment variables may only tighten these.
 * Looser overrides are discarded so a bad env file cannot arm a looser desk.
 * The 1h volume floor is the exception: it lives in VOLUME_BAND and the desk
 * can move it at runtime. A saved settings row wins over the env on boot.
 */
export const HARD_RULES = {
  maxTop10Pct: 0.2,
  /** Boot default. The desk can move this at runtime inside VOLUME_BAND. */
  minVolume1hUsd: 50_000,
  analystMinScore: 0.6,
  maxPositionPct: 0.08,
  stopLossPct: 0.06,
  trailArmPct: 0.12,
  trailGapPct: 0.04,
  revengeCooldownMs: 6 * 60 * 60 * 1000,
  /** New paper book, and the in-app reset. Env PAPER_BALANCE_USD can override a fresh boot only. */
  paperStartingUsd: 100,
  /** Base slippage added to a liquidity-impact estimate. */
  baseSlippage: 0.0015,
  /**
   * Reported liquidity is the whole pool. A constant-product pool prices against one side,
   * about half of it. Impact is measured against that side.
   */
  poolSideShare: 0.5,
  /**
   * Sanity ceiling on a paper fill. 3% used to hide the cost of any order over about 6% of the pool.
   * Unknown liquidity is charged this ceiling. It is not a model of a real fill past 50%.
   */
  maxSlippage: 0.5,
  /** Paper fee, 10 bps. */
  feeBps: 10
} as const;

/** Dirk can lower the 1h volume line from the terminal. Other hard rules stay fixed. */
export const VOLUME_BAND = { min: 1_000, max: 500_000 } as const;

export function clampVolumeUsd(raw: number, fallback = HARD_RULES.minVolume1hUsd): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(VOLUME_BAND.max, Math.max(VOLUME_BAND.min, Math.round(raw)));
}

export interface ResolvedRules {
  maxTop10Pct: number;
  minVolume1hUsd: number;
  analystMinScore: number;
  maxPositionPct: number;
  stopLossPct: number;
  trailArmPct: number;
  trailGapPct: number;
  revengeCooldownMs: number;
}

function readPositive(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/** Smaller is stricter. Ignore values above `cap`. */
function tighterCap(raw: string | undefined, fallback: number, cap: number): number {
  const n = readPositive(raw);
  return Math.min(n ?? fallback, cap);
}

/** Larger is stricter. Ignore values below `floor`. */
function tighterFloor(raw: string | undefined, fallback: number, floor: number): number {
  const n = readPositive(raw);
  return Math.max(n ?? fallback, floor);
}

export function resolveRules(env: NodeJS.ProcessEnv = process.env): ResolvedRules {
  return {
    maxTop10Pct: tighterCap(env.MAX_TOP10_PCT, HARD_RULES.maxTop10Pct, HARD_RULES.maxTop10Pct),
    minVolume1hUsd: clampVolumeUsd(readPositive(env.MIN_VOLUME_1H_USD) ?? HARD_RULES.minVolume1hUsd),
    analystMinScore: tighterFloor(env.ANALYST_MIN_SCORE, HARD_RULES.analystMinScore, HARD_RULES.analystMinScore),
    maxPositionPct: tighterCap(env.MAX_POSITION_PCT, HARD_RULES.maxPositionPct, HARD_RULES.maxPositionPct),
    stopLossPct: tighterCap(env.STOP_LOSS_PCT, HARD_RULES.stopLossPct, HARD_RULES.stopLossPct),
    trailArmPct: tighterFloor(env.TRAIL_ARM_PCT, HARD_RULES.trailArmPct, HARD_RULES.trailArmPct),
    trailGapPct: tighterCap(env.TRAIL_GAP_PCT, HARD_RULES.trailGapPct, HARD_RULES.trailGapPct),
    revengeCooldownMs: tighterFloor(
      env.REVENGE_COOLDOWN_MS,
      HARD_RULES.revengeCooldownMs,
      HARD_RULES.revengeCooldownMs
    )
  };
}
