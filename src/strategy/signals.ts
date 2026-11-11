import { STRATEGY, type SignalKind, type StrategyConfig } from "./config.js";
import type { TrackedMark } from "./mark-tracker.js";

export interface SignalInput {
  /** Coin age right now. */
  ageMs: number;
  /** Oldest first. */
  marks: TrackedMark[];
  now: number;
}

export interface Signal {
  signal: SignalKind;
  /** The mark that fired it. */
  priceUsd: number;
  risePct: number;
  reason: string;
}

/** 5-minute volume against the hourly pace. Unknown volume is not a pass. */
function volumeOnPace(mark: TrackedMark, pace: number): boolean {
  const v5 = mark.vol5mUsd;
  const v1h = mark.vol1hUsd;
  if (v5 == null || v1h == null || !(v5 > 0) || !(v1h > 0) || !Number.isFinite(v5) || !Number.isFinite(v1h)) return false;
  return v5 * 12 + 1e-9 >= v1h * pace;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Launch (under 30 minutes old) or Momentum (older). Null when neither rule is met.
 * Fails closed: a stale last mark, too little history, or unknown volume is no signal.
 */
export function evaluateSignal(input: SignalInput, cfg: StrategyConfig = STRATEGY): Signal | null {
  const { ageMs, marks, now } = input;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  const last = marks[marks.length - 1];
  if (!last || now - last.at > cfg.watch.markFreshMs || last.at > now + 5_000) return null;

  if (ageMs < cfg.launch.maxAgeMs) {
    const first = marks[0]!;
    if (marks.length < cfg.launch.minMarks) return null;
    if (last.at - first.at < cfg.launch.minSpanMs) return null;
    const rise = last.priceUsd / first.priceUsd - 1;
    if (!(rise + 1e-9 >= cfg.launch.minRisePct)) return null;
    if (!volumeOnPace(last, cfg.launch.volPace)) return null;
    return {
      signal: "launch",
      priceUsd: last.priceUsd,
      risePct: rise,
      reason: `Launch: up ${pct(rise)} in ${Math.round((last.at - first.at) / 1000)}s with 5m volume ahead of the hourly pace.`
    };
  }

  const inWindow = marks.filter((m) => now - m.at <= cfg.momentum.windowMs);
  const first = inWindow[0];
  if (!first || last.at - first.at < cfg.momentum.minSpanMs) return null;
  const rise = last.priceUsd / first.priceUsd - 1;
  if (!(rise + 1e-9 >= cfg.momentum.minRisePct)) return null;
  if (!volumeOnPace(last, cfg.momentum.volPace)) return null;
  if (last.change1hPct == null || !(last.change1hPct > 0)) return null;
  return {
    signal: "momentum",
    priceUsd: last.priceUsd,
    risePct: rise,
    reason: `Momentum: up ${pct(rise)} in ${Math.round((last.at - first.at) / 1000)}s, 5m volume ahead of the hourly pace, 1h change +${last.change1hPct.toFixed(1)}%.`
  };
}
