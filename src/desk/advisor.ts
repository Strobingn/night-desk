import { tinyPx } from "../price-text.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface FeatureSample {
  volume1hUsd: number;
  top10HolderPct: number | null;
  liquidityUsd: number;
  ageSeconds: number;
  onBondingCurve: boolean;
  score?: number;
  /** The mint was shown as a near-miss card before this entry. */
  nearMiss?: boolean;
}

export interface NearMissStat {
  surfaced: number;
  taken: number;
  wins: number;
  losses: number;
  pnlSum: number;
}

export interface BucketStat {
  n: number;
  wins: number;
  pnlSum: number;
}

export interface AdvisorMemory {
  version: 1;
  updatedAt: number;
  kills: Record<string, number>;
  passes: number;
  buckets: Record<string, BucketStat>;
  entries: Record<string, FeatureSample & { symbol: string }>;
  lessons: string[];
  nearMiss: NearMissStat;
}

export interface AdvicePosition {
  mint: string;
  symbol: string;
  pnlPct: number;
  markPrice: number;
  stopPrice: number;
  entryPrice: number;
  entryLiquidityUsd: number;
  markLiquidityUsd: number;
  score: number;
}

export interface WeakSurvivor {
  mint: string;
  symbol: string;
  score: number;
  sample: FeatureSample;
}

export interface Advice {
  stance: "sell" | "skip" | "hold" | "watch" | "near-miss";
  symbol?: string;
  mint?: string;
  text: string;
  code?: string;
  score?: number;
}

export function emptyNearMiss(): NearMissStat {
  return { surfaced: 0, taken: 0, wins: 0, losses: 0, pnlSum: 0 };
}

export function emptyMemory(): AdvisorMemory {
  return {
    version: 1,
    updatedAt: Date.now(),
    kills: {},
    passes: 0,
    buckets: {},
    entries: {},
    lessons: [],
    nearMiss: emptyNearMiss()
  };
}

export function bucketKey(sample: FeatureSample): string {
  const vol = sample.volume1hUsd < 100_000 ? "v50" : sample.volume1hUsd < 250_000 ? "v100" : "v250";
  const holders =
    sample.top10HolderPct == null ? "h?" : sample.top10HolderPct < 0.08 ? "h8" : sample.top10HolderPct < 0.15 ? "h15" : "h20";
  const liq = sample.liquidityUsd < 30_000 ? "l30" : sample.liquidityUsd < 100_000 ? "l100" : "l250";
  const curve = sample.onBondingCurve ? "curve" : "pool";
  return `${vol}|${holders}|${liq}|${curve}`;
}

export function noteKill(memory: AdvisorMemory, code: string): void {
  memory.kills[code] = (memory.kills[code] ?? 0) + 1;
  memory.updatedAt = Date.now();
}

export function notePass(memory: AdvisorMemory): void {
  memory.passes += 1;
  memory.updatedAt = Date.now();
}

export function noteNearMissSurface(memory: AdvisorMemory): void {
  memory.nearMiss = memory.nearMiss ?? emptyNearMiss();
  memory.nearMiss.surfaced += 1;
  memory.updatedAt = Date.now();
}

export function noteNearMissTaken(memory: AdvisorMemory): void {
  memory.nearMiss = memory.nearMiss ?? emptyNearMiss();
  memory.nearMiss.taken += 1;
  memory.updatedAt = Date.now();
}

export function noteEntry(memory: AdvisorMemory, mint: string, symbol: string, sample: FeatureSample): void {
  memory.entries[mint] = { ...sample, symbol };
  memory.updatedAt = Date.now();
}

/** A closed trade teaches the bucket. Wins are profitable manual closes. Stops are losses. */
export function noteOutcome(memory: AdvisorMemory, mint: string, pnlPct: number, won: boolean): string | null {
  const entry = memory.entries[mint];
  delete memory.entries[mint];
  if (!entry) return null;
  const key = bucketKey(entry);
  const stat = memory.buckets[key] ?? { n: 0, wins: 0, pnlSum: 0 };
  stat.n += 1;
  if (won) stat.wins += 1;
  stat.pnlSum += pnlPct;
  memory.buckets[key] = stat;
  const lesson = `${entry.symbol} ${won ? "won" : "lost"} ${(pnlPct * 100).toFixed(1)}% in ${key} (${stat.wins}/${stat.n}).`;
  if (entry.nearMiss) {
    memory.nearMiss = memory.nearMiss ?? emptyNearMiss();
    if (won) memory.nearMiss.wins += 1;
    else memory.nearMiss.losses += 1;
    memory.nearMiss.pnlSum += pnlPct;
  }
  memory.lessons.push(lesson);
  memory.lessons = memory.lessons.slice(-40);
  memory.updatedAt = Date.now();
  return lesson;
}

export function advise(
  memory: AdvisorMemory,
  input: { positions: AdvicePosition[]; weak?: WeakSurvivor | null; sessionKills?: Record<string, number> }
): Advice[] {
  const notes: Advice[] = [];
  const kills = mergeCounts(memory.kills, input.sessionKills ?? {});
  const total = Object.values(kills).reduce((sum, n) => sum + n, 0);
  const top = Object.entries(kills).sort((a, b) => b[1] - a[1])[0];
  if (total >= 4 && top) {
    const pct = Math.round((top[1] / total) * 100);
    notes.push({
      stance: "watch",
      text: `Kills are mostly ${top[0]} (${top[1]} of ${total}, ${pct}%). Filter lines are unchanged. Advice only — this does not place trades.`
    });
  }

  for (const pos of input.positions.slice(0, 6)) {
    notes.push(advisePosition(pos));
  }

  if (input.weak) notes.push(adviseWeak(memory, input.weak));
  const near = memory.nearMiss;
  if (near && near.surfaced > 0) {
    notes.push({
      stance: "watch",
      text: `Near-miss record: surfaced ${near.surfaced}, taken ${near.taken}, wins ${near.wins}, losses ${near.losses}. Advice only.`
    });
  }
  return notes.slice(0, 8);
}

function advisePosition(pos: AdvicePosition): Advice {
  const up = signedPct(pos.pnlPct);
  const distance = pos.markPrice > 0 ? ((pos.markPrice - pos.stopPrice) / pos.markPrice) * 100 : 0;
  const thinning =
    pos.entryLiquidityUsd > 0 && pos.markLiquidityUsd > 0 && pos.markLiquidityUsd < pos.entryLiquidityUsd * 0.65;
  if (pos.pnlPct >= 0.2 && thinning) {
    return {
      stance: "sell",
      mint: pos.mint,
      symbol: pos.symbol,
      text: `Consider selling ${pos.symbol} — up ${up}, liquidity thinning ($${Math.round(pos.markLiquidityUsd)} from $${Math.round(pos.entryLiquidityUsd)}). Hard stop distance ${distance.toFixed(1)}%. Manual close only.`
    };
  }
  if (pos.pnlPct >= 0.4) {
    return {
      stance: "sell",
      mint: pos.mint,
      symbol: pos.symbol,
      text: `Consider selling ${pos.symbol} — up ${up}. Hard stop distance ${distance.toFixed(1)}%. Take profit is a manual close.`
    };
  }
  if (distance >= 0 && distance < 3) {
    return {
      stance: "watch",
      mint: pos.mint,
      symbol: pos.symbol,
      text: `${pos.symbol} hard stop distance ${distance.toFixed(1)}% (stop ${fmtPx(pos.stopPrice)}). Advice only.`
    };
  }
  return {
    stance: "hold",
    mint: pos.mint,
    symbol: pos.symbol,
    text: `Hold ${pos.symbol} — ${up}. Hard stop distance ${distance.toFixed(1)}%. Advice only, no order.`
  };
}

function adviseWeak(memory: AdvisorMemory, weak: WeakSurvivor): Advice {
  const stat = memory.buckets[bucketKey(weak.sample)];
  if (stat && stat.n >= 4 && stat.wins / stat.n < 0.45) {
    const avg = (stat.pnlSum / stat.n) * 100;
    return {
      stance: "skip",
      mint: weak.mint,
      symbol: weak.symbol,
      text: `Skip / weak survivor ${weak.symbol} — similar names won ${stat.wins} of ${stat.n} (avg ${avg.toFixed(1)}%). Score ${weak.score.toFixed(2)}. Advice only.`
    };
  }
  if (weak.score < 0.5) {
    return {
      stance: "skip",
      mint: weak.mint,
      symbol: weak.symbol,
      text: `Skip / weak survivor ${weak.symbol} — score ${weak.score.toFixed(2)} is under 0.50. Advice only.`
    };
  }
  return {
    stance: "hold",
    mint: weak.mint,
    symbol: weak.symbol,
    text: `Hold bias ${weak.symbol} — score ${weak.score.toFixed(2)} and the learned bucket is not a loser yet. Advice only.`
  };
}

export class AdvisorBook {
  memory: AdvisorMemory;

  constructor(private readonly filePath: string) {
    this.memory = emptyMemory();
    if (!filePath || filePath === ":memory:") return;
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as AdvisorMemory;
      if (parsed && parsed.version === 1 && parsed.buckets && parsed.entries) {
        const fresh = emptyMemory();
        this.memory = {
          ...fresh,
          ...parsed,
          lessons: parsed.lessons ?? [],
          kills: parsed.kills ?? {},
          nearMiss: { ...fresh.nearMiss, ...(parsed.nearMiss ?? {}) }
        };
      }
    } catch {
      this.memory = emptyMemory();
    }
  }

  save(): void {
    if (!this.filePath || this.filePath === ":memory:") return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.memory));
    renameSync(tmp, this.filePath);
  }
}

function mergeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [key, count] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, count);
  return out;
}

function signedPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${(Math.abs(n) * 100).toFixed(1)}%`;
}

function fmtPx(n: number): string {
  if (!(n > 0)) return "—";
  if (n >= 1) return n.toFixed(4);
  return tinyPx(n);
}
