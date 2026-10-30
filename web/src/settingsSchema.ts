/**
 * Every setting the desk accepts, grouped the way the Android Settings screen groups them.
 * The web Settings tab renders straight from this list, and a test checks that it covers
 * every key in the server's ALLOWED_SETTINGS. Percent fields are shown as percents and
 * sent as fractions (except pnlAlertPct, which the desk takes as whole percent).
 */

export type SettingGroup = "Scout sources" | "Filter / Analyst gates" | "Sizing / risk" | "Exits / stops" | "Alerts";

export const SETTING_GROUPS: SettingGroup[] = ["Sizing / risk", "Filter / Analyst gates", "Exits / stops", "Scout sources", "Alerts"];

interface Base {
  key: string;
  label: string;
  group: SettingGroup;
  hint?: string;
}

export interface SliderField extends Base {
  kind: "slider";
  min: number;
  max: number;
  step: number;
  /** Shown next to the number. */
  unit: "$" | "%" | "min" | "h" | "" | "score";
  /** Display value → value sent to POST /api/settings. */
  toWire: (display: number) => number;
  /** Value read from /api/state → display value. */
  fromState: (raw: number) => number;
  /** When set, the field can be blank (null) with this toggle label. */
  nullable?: string;
}

export interface ToggleField extends Base {
  kind: "toggle";
  locked?: boolean;
}

export type SettingField = SliderField | ToggleField;

const same = (n: number) => n;
const pct = { toWire: (d: number) => Math.round(d * 100) / 10_000, fromState: (raw: number) => Math.round(raw * 10_000) / 100 };

export const SETTINGS_FIELDS: SettingField[] = [
  // Sizing / risk
  { key: "maxPositionPct", label: "Position size % of book", group: "Sizing / risk", kind: "slider", min: 1, max: 50, step: 0.5, unit: "%", ...pct, hint: "Per-position cap for auto buys and unconfirmed manual buys. A confirmed manual buy may go to 100%." },
  { key: "positionSizeUsd", label: "Position size $", group: "Sizing / risk", kind: "slider", min: 1, max: 10_000, step: 1, unit: "$", toWire: same, fromState: same, nullable: "Size from the % cap", hint: "Fixed dollars per auto buy, still cut to the % cap, cash and exposure room." },
  { key: "maxExposurePct", label: "Max total exposure %", group: "Sizing / risk", kind: "slider", min: 10, max: 100, step: 5, unit: "%", ...pct, hint: "Open positions at market value, as a share of equity. 100% = cash is the only limit." },
  { key: "defaultBuyUsd", label: "Manual buy $", group: "Sizing / risk", kind: "slider", min: 1, max: 10_000, step: 1, unit: "$", toWire: same, fromState: same, nullable: "Use the position cap instead" },
  { key: "maxOpenPositions", label: "Max open", group: "Sizing / risk", kind: "slider", min: 1, max: 24, step: 1, unit: "", toWire: same, fromState: same },
  { key: "maxTradesPerHour", label: "Max trades / hour", group: "Sizing / risk", kind: "slider", min: 0, max: 60, step: 1, unit: "", toWire: same, fromState: same, hint: "0 = no hourly cap." },
  { key: "dailyMaxLossUsd", label: "Daily max loss $", group: "Sizing / risk", kind: "slider", min: 0, max: 5_000, step: 5, unit: "$", toWire: same, fromState: same, hint: "0 = off. Pauses auto-buys until the next UTC day." },
  { key: "maxEntrySlippage", label: "Entry slippage %", group: "Sizing / risk", kind: "slider", min: 0.5, max: 3, step: 0.1, unit: "%", ...pct, hint: "Locked at 3% or tighter. Buys past it, or past the pool-depth exit check, are refused." },
  { key: "paperResetUsd", label: "Paper reset amount $", group: "Sizing / risk", kind: "slider", min: 100, max: 10_000, step: 100, unit: "$", toWire: same, fromState: same, hint: "What Reset paper book refills to." },
  { key: "autoBuy", label: "Auto-buy", group: "Sizing / risk", kind: "toggle", hint: "Off still leaves manual Buy and Buy anyway." },
  // Filter / Analyst gates
  { key: "minVolume1hUsd", label: "1h volume $", group: "Filter / Analyst gates", kind: "slider", min: 1_000, max: 500_000, step: 1_000, unit: "$", toWire: same, fromState: same },
  { key: "analystMinScore", label: "Trade line", group: "Filter / Analyst gates", kind: "slider", min: 0.1, max: 0.95, step: 0.01, unit: "score", toWire: same, fromState: same },
  { key: "maxTop10Pct", label: "Top 10 cap %", group: "Filter / Analyst gates", kind: "slider", min: 5, max: 35, step: 1, unit: "%", ...pct },
  { key: "minLiquidityUsd", label: "Min liquidity $", group: "Filter / Analyst gates", kind: "slider", min: 0, max: 200_000, step: 1_000, unit: "$", toWire: same, fromState: same, hint: "0 = off." },
  { key: "minTokenAgeMin", label: "Min age", group: "Filter / Analyst gates", kind: "slider", min: 0, max: 1_440, step: 5, unit: "min", toWire: same, fromState: same },
  { key: "maxTokenAgeMin", label: "Max age", group: "Filter / Analyst gates", kind: "slider", min: 0, max: 10_080, step: 30, unit: "min", toWire: same, fromState: same, hint: "0 = no maximum." },
  { key: "minHolderCount", label: "Min holders", group: "Filter / Analyst gates", kind: "slider", min: 0, max: 2_000, step: 10, unit: "", toWire: same, fromState: same },
  { key: "maxDevHoldingPct", label: "Max dev holding %", group: "Filter / Analyst gates", kind: "slider", min: 0, max: 50, step: 1, unit: "%", ...pct, hint: "0 = off." },
  { key: "allowUnlockedLp", label: "Allow unlocked LP", group: "Filter / Analyst gates", kind: "toggle", hint: "Mint authority and dev rugs stay hard kills." },
  // Exits / stops
  { key: "stopLossPct", label: "Hard stop %", group: "Exits / stops", kind: "slider", min: 1, max: 6, step: 0.5, unit: "%", ...pct, hint: "Locked at 6% or tighter. The desk refuses a looser stop." },
  { key: "cooldownHours", label: "Cooldown after a stop", group: "Exits / stops", kind: "slider", min: 6, max: 72, step: 1, unit: "h", toWire: same, fromState: same },
  { key: "trailTakeProfit", label: "Trailing take profit", group: "Exits / stops", kind: "toggle", hint: "Off by default. Winners stay until you sell." },
  { key: "trailArmPct", label: "Trail arm %", group: "Exits / stops", kind: "slider", min: 12, max: 80, step: 1, unit: "%", ...pct },
  { key: "trailGapPct", label: "Trail gap %", group: "Exits / stops", kind: "slider", min: 0.5, max: 4, step: 0.5, unit: "%", ...pct },
  // Scout sources
  { key: "scoutPump", label: "Pump", group: "Scout sources", kind: "toggle", locked: true, hint: "Pump stays on. It is the primary feed." },
  { key: "scoutDexscreener", label: "DexScreener", group: "Scout sources", kind: "toggle" },
  { key: "scoutGecko", label: "Gecko", group: "Scout sources", kind: "toggle" },
  { key: "scoutJupiter", label: "Jupiter", group: "Scout sources", kind: "toggle" },
  { key: "scoutDexpaprika", label: "DexPaprika / Meteora", group: "Scout sources", kind: "toggle" },
  { key: "scoutBitquery", label: "Bitquery", group: "Scout sources", kind: "toggle" },
  // Alerts
  { key: "notifyNearMiss", label: "Near misses", group: "Alerts", kind: "toggle" },
  { key: "notifyFills", label: "Fills", group: "Alerts", kind: "toggle" },
  { key: "notifyStops", label: "Stops", group: "Alerts", kind: "toggle" },
  { key: "pnlAlertPct", label: "PnL alert %", group: "Alerts", kind: "slider", min: 0, max: 50, step: 1, unit: "%", toWire: same, fromState: same, hint: "0 = off." }
];

/** Keys the desk saves. scoutPump is display-only (always on). */
export const SAVED_KEYS = SETTINGS_FIELDS.filter((f) => !(f.kind === "toggle" && f.locked)).map((f) => f.key);

type StateLike = { rules: Record<string, unknown>; prefs: Record<string, unknown> };

/** Raw value from /api/state, in the desk's own units (fractions, dollars, booleans). */
export function readSetting(snap: StateLike, key: string): number | boolean | null {
  if (key === "cooldownHours") {
    const fromPrefs = snap.prefs.cooldownHours;
    if (typeof fromPrefs === "number") return fromPrefs;
    const ms = snap.rules.revengeCooldownMs;
    return typeof ms === "number" ? Math.round(ms / 3_600_000) : 6;
  }
  if (key === "scoutPump") return true;
  const raw = key in snap.rules ? snap.rules[key] : snap.prefs[key];
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  return null;
}

export type Draft = Record<string, number | boolean | null>;

export function draftFrom(snap: StateLike): Draft {
  const draft: Draft = {};
  for (const field of SETTINGS_FIELDS) {
    const raw = readSetting(snap, field.key);
    if (field.kind === "toggle") draft[field.key] = raw === true || (raw == null && field.locked === true);
    else draft[field.key] = typeof raw === "number" ? field.fromState(raw) : null;
  }
  return draft;
}

/** Only changed fields are sent, so a save never rewrites a value Dirk did not touch. */
export function changedPatch(before: Draft, after: Draft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) {
    if (field.kind === "toggle" && field.locked) continue;
    const a = before[field.key];
    const b = after[field.key];
    if (a === b) continue;
    if (field.kind === "toggle") patch[field.key] = b === true;
    else patch[field.key] = b == null ? null : field.toWire(Number(b));
  }
  return patch;
}
