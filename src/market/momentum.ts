/**
 * v13.3 pre-buy crash guard.
 *
 * Every mark and sighting the desk sees for a coin is kept for ~2 minutes. Before any buy
 * (auto or one-tap), the current price is compared with the highest price seen in the last
 * CRASH_WINDOW_MS, and the current pool liquidity with the highest liquidity in that window.
 * A hard drop means the coin is dumping or the pool is being pulled right now: skip it.
 *
 * This only avoids buying into a crash already under way. It cannot stop a later gap.
 */

export const CRASH_WINDOW_MS = 60_000;
/** Price down this much from the window high → PRICE_CRASH. */
export const CRASH_DROP = 0.2;
/** Liquidity down this much from the window high → LIQUIDITY_PULL. */
export const LIQUIDITY_PULL_DROP = 0.3;
const KEEP_MS = 120_000;
const MAX_POINTS = 40;
const MAX_MINTS = 3_000;

interface Point {
  at: number;
  price?: number;
  liquidity?: number;
}

export interface CrashVerdict {
  code: "PRICE_CRASH" | "LIQUIDITY_PULL";
  message: string;
  dropPct: number;
}

export class MomentumTracker {
  private readonly map = new Map<string, Point[]>();

  note(mint: string, price?: number, liquidity?: number, at = Date.now()): void {
    const p = typeof price === "number" && Number.isFinite(price) && price > 0 ? price : undefined;
    const l = typeof liquidity === "number" && Number.isFinite(liquidity) && liquidity > 0 ? liquidity : undefined;
    if (p == null && l == null) return;
    let list = this.map.get(mint);
    if (!list) {
      list = [];
      this.map.set(mint, list);
      if (this.map.size > MAX_MINTS) {
        const first = this.map.keys().next().value;
        if (first) this.map.delete(first);
      }
    }
    list.push({ at, price: p, liquidity: l });
    while (list.length && (list[0]!.at < at - KEEP_MS || list.length > MAX_POINTS)) list.shift();
  }

  /** null = no crash seen (including: not enough history to tell). */
  check(mint: string, price: number, liquidity: number | undefined, now = Date.now()): CrashVerdict | null {
    const list = this.map.get(mint);
    if (!list?.length) return null;
    const recent = list.filter((pt) => pt.at >= now - CRASH_WINDOW_MS);
    let highPrice = 0;
    let highLiq = 0;
    for (const pt of recent) {
      if (pt.price != null && pt.price > highPrice) highPrice = pt.price;
      if (pt.liquidity != null && pt.liquidity > highLiq) highLiq = pt.liquidity;
    }
    if (highPrice > 0 && price > 0) {
      const drop = 1 - price / highPrice;
      if (drop >= CRASH_DROP) {
        return {
          code: "PRICE_CRASH",
          dropPct: drop,
          message: `Price is down ${(drop * 100).toFixed(0)}% from its high in the last ${Math.round(CRASH_WINDOW_MS / 1000)}s. Not buying into a crash.`
        };
      }
    }
    // The freshest liquidity print wins (a pool tick can be newer than the sighting).
    const latestLiq = [...recent].reverse().find((pt) => pt.liquidity != null)?.liquidity;
    const curLiq = latestLiq ?? liquidity;
    if (highLiq > 0 && typeof curLiq === "number" && curLiq > 0) {
      const drop = 1 - curLiq / highLiq;
      if (drop >= LIQUIDITY_PULL_DROP) {
        return {
          code: "LIQUIDITY_PULL",
          dropPct: drop,
          message: `Pool liquidity fell ${(drop * 100).toFixed(0)}% in the last ${Math.round(CRASH_WINDOW_MS / 1000)}s. Liquidity looks like it is being pulled.`
        };
      }
    }
    return null;
  }
}
