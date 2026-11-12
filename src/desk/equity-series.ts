import { ABSURD_RISE } from "../market/mark-guard.js";
import type { EquityPoint } from "../types.js";

/**
 * v13.20 display filter. Ledger rows stay. A point whose open-position value jumps by an
 * absurd multiple, and does not come back, is left off the curve. A drop is kept, so a
 * real rug still shows. A cash deposit is kept.
 */
export function visibleEquity(points: EquityPoint[]): EquityPoint[] {
  const out: EquityPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    const prev = out[out.length - 1];
    if (!prev || !absurdEquityJump(prev, point)) {
      out.push(point);
      continue;
    }
    let back = -1;
    for (let j = i + 1; j < points.length; j += 1) {
      if (!absurdEquityJump(prev, points[j]!)) {
        back = j;
        break;
      }
    }
    if (back === -1) break;
    i = back - 1;
  }
  return out;
}

/**
 * v13.33 chart cap. Keeps the first and last points and the min and max equity
 * so a bucketed series still shows the session ends and the spike.
 */
export function capEquitySeries(points: EquityPoint[], max: number): EquityPoint[] {
  if (points.length <= max) return points;
  if (max < 2) return points.slice(0, Math.max(0, max));
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let minP = first;
  let maxP = first;
  for (const point of points) {
    if (point.equity < minP.equity) minP = point;
    if (point.equity > maxP.equity) maxP = point;
  }
  const pinned = new Set<EquityPoint>([first, last, minP, maxP]);
  if (pinned.size >= max) {
    return [...pinned].sort((a, b) => a.t - b.t).slice(0, max);
  }
  const middle = points.filter((point) => !pinned.has(point));
  const room = max - pinned.size;
  const sampled = downsamplePoints(middle, room);
  const uniq = new Map<number, EquityPoint>();
  for (const point of [...pinned, ...sampled]) uniq.set(point.t, point);
  const out = [...uniq.values()].sort((a, b) => a.t - b.t);
  return out.length <= max ? out : out.slice(0, max);
}

function downsamplePoints(rows: EquityPoint[], max: number): EquityPoint[] {
  if (rows.length <= max) return rows;
  if (max <= 0) return [];
  if (max === 1) return [rows[0]!];
  const out: EquityPoint[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(rows[Math.round(i * step)]!);
  return out;
}

function absurdEquityJump(prev: EquityPoint, next: EquityPoint): boolean {
  const prevMv = Math.max(0, prev.equity - prev.cash);
  const mv = Math.max(0, next.equity - next.cash);
  if (next.equity <= prev.equity * 1.02) return false;
  if (next.cash > prev.cash + 500) return false;
  return prevMv > 1 && mv > prevMv * ABSURD_RISE && mv - prevMv > 500;
}
