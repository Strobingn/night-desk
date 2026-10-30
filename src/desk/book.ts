import type { Position } from "../types.js";

export class PaperBook {
  positions = new Map<string, Position>();
  lastPrice = new Map<string, number>();
  /** Wall time of the last fresh mark per mint. */
  lastMarkAt = new Map<string, number>();

  constructor(public cashUsd: number) {}

  mark(mint: string, priceUsd: number, at = Date.now()): void {
    if (priceUsd > 0) {
      this.lastPrice.set(mint, priceUsd);
      this.lastMarkAt.set(mint, at);
    }
  }

  markedAt(mint: string): number | undefined {
    return this.lastMarkAt.get(mint);
  }

  price(mint: string, fallback?: number): number {
    return this.lastPrice.get(mint) ?? fallback ?? 0;
  }

  equity(): number {
    let marked = 0;
    for (const pos of this.positions.values()) {
      const px = this.price(pos.mint, pos.entryPrice);
      marked += pos.qty * px;
    }
    return this.cashUsd + marked;
  }

  get(mint: string): Position | undefined {
    return this.positions.get(mint);
  }
}
