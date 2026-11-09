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

function absurdEquityJump(prev: EquityPoint, next: EquityPoint): boolean {
  const prevMv = Math.max(0, prev.equity - prev.cash);
  const mv = Math.max(0, next.equity - next.cash);
  if (next.equity <= prev.equity * 1.02) return false;
  if (next.cash > prev.cash + 500) return false;
  return prevMv > 1 && mv > prevMv * ABSURD_RISE && mv - prevMv > 500;
}
