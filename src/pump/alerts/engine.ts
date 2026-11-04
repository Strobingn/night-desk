/**
 * Edge-triggered alert engine.
 * A rule fires once when a sample crosses its threshold, stays quiet while the
 * sample remains above the hysteresis band, and can fire again only after a
 * fresh crossing once the cooldown has elapsed.
 */
import type { AlertKind } from "../types.js";
import { type AlertRule, type AlertSample, DEFAULT_RULES } from "./rules.js";

export interface DeskAlert {
  id: string;
  ruleId: string;
  kind: AlertRule["kind"];
  mint: string;
  at: number;
  message: string;
  delivery: AlertRule["delivery"];
  value: number;
  threshold: number;
  /** Core feed kind, so the existing alerts table can store the fire. */
  coreKind: AlertKind;
}

interface StepLatch {
  high: boolean;
  lastFiredAt: number | null;
}

interface Latch {
  high: boolean;
  lastFiredAt: number | null;
  holders?: number;
  seen: string[];
  steps: Map<number, StepLatch>;
  highest: number;
}

export class AlertEngine {
  private latches = new Map<string, Latch>();

  constructor(private rules: AlertRule[] = DEFAULT_RULES.map((rule) => ({ ...rule }))) {}

  setRules(rules: AlertRule[]): void {
    this.rules = rules.map((rule) => ({ ...rule }));
  }

  getRules(): AlertRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  /** Fires at most once per threshold crossing. */
  evaluate(sample: AlertSample): DeskAlert[] {
    const fired: DeskAlert[] = [];
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.mint && rule.mint !== sample.mint) continue;
      if (rule.kind === "large_buy" || rule.kind === "whale_sell") {
        const hit = this.evalEvent(rule, sample);
        if (hit) fired.push(hit);
        continue;
      }
      if (rule.kind === "graduation") {
        const hit = this.evalGraduation(rule, sample);
        if (hit) fired.push(hit);
        continue;
      }
      if (rule.kind === "holders") {
        const hit = this.evalHolders(rule, sample);
        if (hit) fired.push(hit);
        continue;
      }
      const value = levelOf(rule, sample);
      if (value == null) continue;
      if (rule.milestoneStep && rule.milestoneStep > 0 && (rule.kind === "mcap" || rule.kind === "price")) {
        fired.push(...this.evalSteps(rule, sample, value));
        continue;
      }
      const hit = this.evalLevel(rule, sample, this.latch(`${rule.id}\n${sample.mint}`), rule.threshold, value);
      if (hit) fired.push(hit);
    }
    return fired;
  }

  private evalSteps(rule: AlertRule, sample: AlertSample, value: number): DeskAlert[] {
    const latch = this.latch(`${rule.id}\n${sample.mint}`);
    const step = rule.milestoneStep ?? rule.threshold;
    const span = Math.max(value, latch.highest) - rule.threshold;
    const count = span <= 0 ? 0 : Math.min(500, Math.floor(span / step));
    const top = rule.threshold + count * step;
    if (top > latch.highest) latch.highest = top;
    const fired: DeskAlert[] = [];
    for (let milestone = rule.threshold; milestone <= top; milestone += step) {
      let stepLatch = latch.steps.get(milestone);
      if (!stepLatch) {
        stepLatch = { high: false, lastFiredAt: null };
        latch.steps.set(milestone, stepLatch);
      }
      const hit = this.evalLevel(rule, sample, stepLatch, milestone, value);
      if (hit) fired.push(hit);
    }
    return fired;
  }

  private evalLevel(rule: AlertRule, sample: AlertSample, latch: StepLatch, milestone: number, value: number): DeskAlert | null {
    if (value >= milestone) {
      if (latch.high) return null;
      latch.high = true;
      if (latch.lastFiredAt != null && sample.at - latch.lastFiredAt < rule.cooldownMs) return null;
      latch.lastFiredAt = sample.at;
      return this.alert(rule, sample, value, milestone);
    }
    if (value <= milestone - Math.max(0, rule.hysteresis)) latch.high = false;
    return null;
  }

  private evalHolders(rule: AlertRule, sample: AlertSample): DeskAlert | null {
    if (sample.holderCount == null || !Number.isFinite(sample.holderCount)) return null;
    const latch = this.latch(`${rule.id}\n${sample.mint}`);
    if (latch.holders == null) {
      latch.holders = sample.holderCount;
      return null;
    }
    const delta = sample.holderCount - latch.holders;
    latch.holders = sample.holderCount;
    if (delta >= rule.threshold) {
      if (latch.high) return null;
      latch.high = true;
      if (latch.lastFiredAt != null && sample.at - latch.lastFiredAt < rule.cooldownMs) return null;
      latch.lastFiredAt = sample.at;
      return this.alert(rule, sample, delta, rule.threshold);
    }
    if (delta <= rule.threshold - Math.max(0, rule.hysteresis)) latch.high = false;
    return null;
  }

  private evalGraduation(rule: AlertRule, sample: AlertSample): DeskAlert | null {
    if (sample.graduated == null) return null;
    const latch = this.latch(`${rule.id}\n${sample.mint}`);
    if (sample.graduated) {
      if (latch.high) return null;
      latch.high = true;
      if (latch.lastFiredAt != null && sample.at - latch.lastFiredAt < rule.cooldownMs) return null;
      latch.lastFiredAt = sample.at;
      return this.alert(rule, sample, 1, rule.threshold);
    }
    latch.high = false;
    return null;
  }

  private evalEvent(rule: AlertRule, sample: AlertSample): DeskAlert | null {
    const event = rule.kind === "large_buy" ? sample.buy : sample.sell;
    if (!event || !Number.isFinite(event.lamports) || event.lamports < rule.threshold) return null;
    const signature = event.signature || `${sample.mint}:${sample.at}`;
    const latch = this.latch(`${rule.id}\n${sample.mint}`);
    if (latch.seen.includes(signature)) return null;
    latch.seen.push(signature);
    if (latch.seen.length > 200) latch.seen.shift();
    if (latch.lastFiredAt != null && sample.at - latch.lastFiredAt < rule.cooldownMs) return null;
    latch.lastFiredAt = sample.at;
    return this.alert(rule, sample, event.lamports, rule.threshold);
  }

  private alert(rule: AlertRule, sample: AlertSample, value: number, threshold: number): DeskAlert {
    return {
      id: `${rule.id}:${sample.mint}:${threshold}:${sample.at}`,
      ruleId: rule.id,
      kind: rule.kind,
      mint: sample.mint,
      at: sample.at,
      message: messageFor(rule, sample.mint, value, threshold),
      delivery: rule.delivery,
      value,
      threshold,
      coreKind: coreKind(rule.kind)
    };
  }

  private latch(id: string): Latch {
    let latch = this.latches.get(id);
    if (!latch) {
      latch = { high: false, lastFiredAt: null, seen: [], steps: new Map(), highest: 0 };
      this.latches.set(id, latch);
    }
    return latch;
  }
}

export function coreKind(kind: AlertRule["kind"]): AlertKind {
  if (kind === "graduation") return "graduation";
  if (kind === "curve") return "progress";
  if (kind === "large_buy" || kind === "whale_sell") return "trade";
  if (kind === "price" || kind === "mcap") return "cap";
  return "custom";
}

function levelOf(rule: AlertRule, sample: AlertSample): number | null {
  const value = rule.kind === "price" ? sample.price : rule.kind === "mcap" ? sample.marketCapLamports : rule.kind === "curve" ? sample.progressPct : null;
  return value == null || !Number.isFinite(value) ? null : value;
}

function messageFor(rule: AlertRule, mint: string, value: number, threshold: number): string {
  const label = mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
  if (rule.kind === "holders") return `${label} gained ${formatNum(value)} holders`;
  if (rule.kind === "graduation") return `${label} graduated`;
  if (rule.kind === "large_buy") return `${label} large buy ${formatNum(value)} lamports`;
  if (rule.kind === "whale_sell") return `${label} whale sell ${formatNum(value)} lamports`;
  if (rule.kind === "curve") return `${label} curve ${formatNum(value)}% crossed ${formatNum(threshold)}%`;
  if (rule.kind === "mcap") return `${label} mcap crossed ${formatNum(threshold)} lamports`;
  return `${label} price crossed ${formatNum(threshold)}`;
}

function formatNum(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}
