/**
 * Hard floors. Environment variables may only tighten these.
 * Looser overrides are discarded so a bad env file cannot arm a looser desk.
 * Volume, the analyst line, the top-10 cap, and the position cap can move at
 * runtime inside their bands. A saved settings row wins over the env on boot.
 * The −6% hard stop is not in a band the desk can loosen.
 */
export const HARD_RULES = {
  /** Looser than this is ignored. Env may still tighten. */
  maxTop10Pct: 0.35,
  /** Boot default when no saved floor exists. Runtime band stays $1,000–$500,000. */
  minVolume1hUsd: 10_000,
  /** Default trade line. Settings may move it inside 0.10–0.95. */
  analystMinScore: 0.5,
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
   * Loosest entry a buy may pay above the mark. Settings may tighten this. They cannot
   * remove it or raise it. A quote past this cap is refused. It is not a fill price.
   */
  maxEntrySlippage: 0.03,
  /**
   * Unused by the paper sell. Exit impact is the constant-product haircut against pool
   * depth, and a buy is refused when that haircut is past the entry cap plus exitImpactSlack.
   * Kept so an old env file that names it cannot change the stop or the entry cap.
   */
  maxSlippage: 0.5,
  /**
   * Room past the entry slippage cap that a full exit may cost. A wider exit is refused
   * before the buy, so a coin that cannot get out near the hard stop is never opened.
   */
  exitImpactSlack: 0.03,
  /** Paper fee, 10 bps. */
  feeBps: 10
} as const;

/** Dirk can lower the 1h volume line from the terminal. */
export const VOLUME_BAND = { min: 1_000, max: 500_000 } as const;

/** Analyst trade line. Default stays 0.50. The desk accepts 0.10 through 0.95. */
export const SCORE_BAND = { min: 0.1, max: 0.95 } as const;

/** How many names may be open at once. The desk can move this. It does not change the stop. */
export const OPEN_POSITION_BAND = { min: 1, max: 24, fallback: 12 } as const;

/** Entry slippage. 3% is the loosest. 0.5% is the tightest. The gate cannot be turned off. */
export const ENTRY_SLIPPAGE_BAND = { min: 0.005, max: HARD_RULES.maxEntrySlippage } as const;

export function clampVolumeUsd(raw: number, fallback = HARD_RULES.minVolume1hUsd): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(VOLUME_BAND.max, Math.max(VOLUME_BAND.min, Math.round(raw)));
}

export function clampScore(raw: number, fallback = HARD_RULES.analystMinScore): number {
  if (!Number.isFinite(raw)) return fallback;
  const clamped = Math.min(SCORE_BAND.max, Math.max(SCORE_BAND.min, raw));
  return Math.round(clamped * 100) / 100;
}

/** Accepts a fraction (0.35) or a percent (35). Never above the 35% hard cap. */
export function clampTop10(raw: number, fallback = HARD_RULES.maxTop10Pct): number {
  if (!Number.isFinite(raw)) return fallback;
  const fraction = raw > 1 ? raw / 100 : raw;
  const clamped = Math.min(HARD_RULES.maxTop10Pct, Math.max(0.05, fraction));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * v12 sizing bands. The boot default and any env value stay at or under the 8% hard cap.
 * Only a saved desk setting can raise the per-position cap, and never past autoMaxPct.
 * A single manual buy the operator confirms may go to manualMaxPct of the book.
 * Cash, the entry slippage cap and the pool-depth exit check still apply to every size.
 */
export const SIZING_BAND = {
  /** Settings slider ceiling for the per-position cap (auto and unconfirmed manual buys). */
  autoMaxPct: 0.5,
  /** Ceiling for one manual buy the operator confirmed. */
  manualMaxPct: 1,
  minPct: 0.01,
  /** Total open exposure as a share of equity. 1 = no extra limit beyond cash. */
  exposureMinPct: 0.1,
  exposureMaxPct: 1,
  exposureDefaultPct: 1,
  /** Fixed $ per position. null = size from the % cap. */
  positionUsdMin: 1,
  positionUsdMax: 100_000,
  /** Paper reset amount. */
  resetMinUsd: 100,
  resetMaxUsd: 10_000
} as const;

/**
 * Accepts a fraction (0.08) or a percent (8). A value of 1 or more is a percent, so 1 = 1%.
 * The ceiling defaults to the 8% hard cap. Saved settings pass SIZING_BAND.autoMaxPct.
 */
export function clampPositionPct(raw: number, fallback: number = HARD_RULES.maxPositionPct, ceiling: number = HARD_RULES.maxPositionPct): number {
  if (!Number.isFinite(raw)) return fallback;
  const fraction = raw >= 1 ? raw / 100 : raw;
  const top = Math.min(SIZING_BAND.autoMaxPct, Math.max(SIZING_BAND.minPct, ceiling));
  const clamped = Math.min(top, Math.max(SIZING_BAND.minPct, fraction));
  return Math.round(clamped * 1000) / 1000;
}

/** Total exposure cap. Fraction or percent (>= 1 is a percent). 10%–100%. */
export function clampExposurePct(raw: number, fallback: number = SIZING_BAND.exposureDefaultPct): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  const fraction = raw > 1 ? raw / 100 : raw;
  const clamped = Math.min(SIZING_BAND.exposureMaxPct, Math.max(SIZING_BAND.exposureMinPct, fraction));
  return Math.round(clamped * 1000) / 1000;
}

/** Fixed $ per position. Blank, zero or negative means "use the % cap". */
export function clampPositionUsd(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || !(raw > 0)) return null;
  const cents = Math.round(raw * 100) / 100;
  return Math.min(SIZING_BAND.positionUsdMax, Math.max(SIZING_BAND.positionUsdMin, cents));
}

/** Paper reset amount, $100–$10,000. */
export function clampResetUsd(raw: number, fallback: number = HARD_RULES.paperStartingUsd): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(SIZING_BAND.resetMaxUsd, Math.max(SIZING_BAND.resetMinUsd, Math.round(raw)));
}

export function clampOpenPositions(raw: number, fallback = OPEN_POSITION_BAND.fallback): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(OPEN_POSITION_BAND.max, Math.max(OPEN_POSITION_BAND.min, Math.round(raw)));
}

/**
 * Accepts a fraction (0.03) or a percent (3). Never above 3%, never below 0.5%.
 * A zero or a blank does not remove the gate; callers must keep the previous value
 * when the input is not a number.
 */
export function clampEntrySlippage(raw: number, fallback = HARD_RULES.maxEntrySlippage): number {
  if (!Number.isFinite(raw)) return fallback;
  // The settings field is a percent (3, 1, 0.5). A fraction (0.03) is already inside the cap.
  const fraction = raw > ENTRY_SLIPPAGE_BAND.max ? raw / 100 : raw;
  const clamped = Math.min(ENTRY_SLIPPAGE_BAND.max, Math.max(ENTRY_SLIPPAGE_BAND.min, fraction));
  return Math.round(clamped * 10_000) / 10_000;
}

/** 0 turns the extra floor off. A positive floor is $1–$500,000. */
export function clampLiquidityUsd(raw: number, fallback = 0): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback <= 0 ? 0 : fallback;
  return Math.min(500_000, Math.max(0, Math.round(raw)));
}

/** 0 means no age gate. Minutes, capped at 7 days. */
export function clampAgeMinutes(raw: number, fallback = 0): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback <= 0 ? 0 : fallback;
  return Math.min(10_080, Math.max(0, Math.round(raw)));
}

/** 0 means no holder-count gate. */
export function clampHolderCount(raw: number, fallback = 0): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback <= 0 ? 0 : fallback;
  return Math.min(10_000, Math.max(0, Math.round(raw)));
}

/** 0 means no dev-holding gate. Accepts a fraction or a percent. Never above 100%. */
export function clampDevHoldingPct(raw: number, fallback = 0): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback <= 0 ? 0 : fallback;
  const fraction = raw > 1 ? raw / 100 : raw;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * 1000) / 1000;
}

/** 0 means unlimited. Otherwise 1–60 buys an hour. */
export function clampTradesPerHour(raw: number, fallback = 0): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback <= 0 ? 0 : fallback;
  return Math.min(60, Math.max(1, Math.round(raw)));
}

/** 0 means the daily loss pause is off. */
export function clampDailyLossUsd(raw: number, fallback = 0): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback <= 0 ? 0 : fallback;
  return Math.min(100_000, Math.round(raw * 100) / 100);
}

/**
 * Hours after a hard stop before that mint can be auto-bought again.
 * 6 is the floor. A smaller number is refused by the caller.
 */
export function clampCooldownHours(raw: number, fallback = 6): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(72, Math.max(6, Math.round(raw)));
}

/** Stop fraction. Callers reject anything looser than 6% before this runs. */
export function clampStopLossPct(raw: number, fallback = HARD_RULES.stopLossPct): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  const fraction = raw > 1 ? raw / 100 : raw;
  return Math.min(HARD_RULES.stopLossPct, Math.max(0.01, Math.round(fraction * 10_000) / 10_000));
}

/** Arm percent as a fraction. Cannot be easier than the 12% hard floor. */
export function clampTrailArmPct(raw: number, fallback = HARD_RULES.trailArmPct): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  const fraction = raw > 1 ? raw / 100 : raw;
  return Math.min(0.8, Math.max(HARD_RULES.trailArmPct, Math.round(fraction * 10_000) / 10_000));
}

/** Trail gap as a fraction. Cannot be wider than 4%. */
export function clampTrailGapPct(raw: number, fallback = HARD_RULES.trailGapPct): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  const fraction = raw > 1 ? raw / 100 : raw;
  return Math.min(HARD_RULES.trailGapPct, Math.max(0.005, Math.round(fraction * 10_000) / 10_000));
}

/** 0 means no phone alert. Otherwise 1–50 percent. */
export function clampPnlAlertPct(raw: number, fallback = 0): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback <= 0 ? 0 : fallback;
  return Math.min(50, Math.max(1, Math.round(raw)));
}

/** Stored preference. 0 or a non-positive value means "use the position cap". */
export function clampBuyUsd(raw: number | null): number | null {
  if (raw == null || !Number.isFinite(raw) || !(raw > 0)) return null;
  const cents = Math.round(raw * 100) / 100;
  return Math.min(100_000, Math.max(1, cents));
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
  /** Max a buy may pay above the mark. Default 3%. Cannot be loosened or removed. */
  maxEntrySlippage: number;
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
    analystMinScore: clampScore(readPositive(env.ANALYST_MIN_SCORE) ?? HARD_RULES.analystMinScore),
    maxPositionPct: tighterCap(env.MAX_POSITION_PCT, HARD_RULES.maxPositionPct, HARD_RULES.maxPositionPct),
    stopLossPct: tighterCap(env.STOP_LOSS_PCT, HARD_RULES.stopLossPct, HARD_RULES.stopLossPct),
    trailArmPct: tighterFloor(env.TRAIL_ARM_PCT, HARD_RULES.trailArmPct, HARD_RULES.trailArmPct),
    trailGapPct: tighterCap(env.TRAIL_GAP_PCT, HARD_RULES.trailGapPct, HARD_RULES.trailGapPct),
    revengeCooldownMs: tighterFloor(
      env.REVENGE_COOLDOWN_MS,
      HARD_RULES.revengeCooldownMs,
      HARD_RULES.revengeCooldownMs
    ),
    maxEntrySlippage: clampEntrySlippage(
      readPositive(env.MAX_ENTRY_SLIPPAGE) ?? HARD_RULES.maxEntrySlippage,
      HARD_RULES.maxEntrySlippage
    )
  };
}
