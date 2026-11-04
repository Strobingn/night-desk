/**
 * Desk alert rules. A rule latches when a sample crosses its threshold and
 * re-arms only after the sample falls back through the hysteresis band.
 */

export type AlertRuleKind = "price" | "mcap" | "curve" | "large_buy" | "holders" | "graduation" | "whale_sell";

export type DeliveryMode = "silent" | "sound" | "fullscreen";

export interface AlertRule {
  id: string;
  kind: AlertRuleKind;
  /** Empty string watches every mint. */
  mint: string;
  /** Price ratio, mcap lamports, curve percent, buy/sell lamports, or new-holder count. */
  threshold: number;
  /** Absolute distance below the threshold that re-arms the rule. */
  hysteresis: number;
  cooldownMs: number;
  delivery: DeliveryMode;
  enabled: boolean;
  /**
   * Price and mcap only. Fires at `threshold`, then `threshold + step`, and so on.
   * Each step latches on its own.
   */
  milestoneStep?: number;
}

export interface AlertSample {
  mint: string;
  /** Unix milliseconds. */
  at: number;
  /** Quote lamports per raw token, or any unit the rule's threshold uses. */
  price?: number;
  marketCapLamports?: number;
  progressPct?: number;
  /** Paged holder count. The engine stores the previous count and alerts on the delta. */
  holderCount?: number;
  graduated?: boolean;
  buy?: { lamports: number; signature: string };
  sell?: { lamports: number; signature: string };
}

const KINDS = new Set<AlertRuleKind>(["price", "mcap", "curve", "large_buy", "holders", "graduation", "whale_sell"]);
const DELIVERIES = new Set<DeliveryMode>(["silent", "sound", "fullscreen"]);

export const DEFAULT_RULES: readonly AlertRule[] = [
  {
    id: "mcap-50sol",
    kind: "mcap",
    mint: "",
    threshold: 50_000_000_000,
    hysteresis: 5_000_000_000,
    cooldownMs: 60_000,
    delivery: "sound",
    enabled: true,
    milestoneStep: 50_000_000_000
  },
  { id: "curve-50", kind: "curve", mint: "", threshold: 50, hysteresis: 5, cooldownMs: 60_000, delivery: "sound", enabled: true },
  { id: "curve-90", kind: "curve", mint: "", threshold: 90, hysteresis: 5, cooldownMs: 60_000, delivery: "fullscreen", enabled: true },
  { id: "large-buy", kind: "large_buy", mint: "", threshold: 1_000_000_000, hysteresis: 0, cooldownMs: 30_000, delivery: "sound", enabled: true },
  { id: "whale-sell", kind: "whale_sell", mint: "", threshold: 2_000_000_000, hysteresis: 0, cooldownMs: 30_000, delivery: "fullscreen", enabled: true },
  { id: "holders", kind: "holders", mint: "", threshold: 10, hysteresis: 3, cooldownMs: 60_000, delivery: "silent", enabled: true },
  { id: "graduation", kind: "graduation", mint: "", threshold: 1, hysteresis: 0, cooldownMs: 0, delivery: "fullscreen", enabled: true },
  { id: "price", kind: "price", mint: "", threshold: 0, hysteresis: 0, cooldownMs: 60_000, delivery: "silent", enabled: false }
];

export function parseRule(raw: unknown): AlertRule | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const kind = row.kind;
  const delivery = row.delivery;
  if (typeof kind !== "string" || !KINDS.has(kind as AlertRuleKind)) return null;
  if (typeof delivery !== "string" || !DELIVERIES.has(delivery as DeliveryMode)) return null;
  const threshold = num(row.threshold);
  const hysteresis = num(row.hysteresis);
  const cooldownMs = num(row.cooldownMs);
  if (threshold == null || hysteresis == null || hysteresis < 0 || cooldownMs == null || cooldownMs < 0) return null;
  let milestoneStep: number | undefined;
  if (row.milestoneStep != null) {
    const step = num(row.milestoneStep);
    if (step == null || step <= 0) return null;
    milestoneStep = step;
  }
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `${kind}-${threshold}`;
  return {
    id,
    kind: kind as AlertRuleKind,
    mint: typeof row.mint === "string" ? row.mint.trim() : "",
    threshold,
    hysteresis,
    cooldownMs,
    delivery: delivery as DeliveryMode,
    enabled: row.enabled !== false,
    milestoneStep
  };
}

export function parseRules(raw: unknown): AlertRule[] | null {
  if (!Array.isArray(raw)) return null;
  const rules: AlertRule[] = [];
  for (const row of raw) {
    const rule = parseRule(row);
    if (!rule) return null;
    rules.push(rule);
  }
  return rules;
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
