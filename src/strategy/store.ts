import type { DatabaseSync } from "node:sqlite";
import type { ShadowTrade } from "./shadow-book.js";

/** Closed shadow trades. Open shadow positions are not saved: after a restart they are simply gone and never counted. */
export class ShadowStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_trades (
        id TEXT PRIMARY KEY,
        variant TEXT NOT NULL,
        closed_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shadow_trades_closed ON shadow_trades(closed_at);
    `);
  }

  save(trade: ShadowTrade): void {
    this.db
      .prepare(`INSERT INTO shadow_trades (id, variant, closed_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(trade.id, trade.variant, trade.closedAt, JSON.stringify(trade));
  }

  all(): ShadowTrade[] {
    const rows = this.db.prepare(`SELECT payload FROM shadow_trades ORDER BY closed_at ASC`).all() as Array<{ payload: string }>;
    const out: ShadowTrade[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.payload) as ShadowTrade);
      } catch {
        /* a row that does not parse is skipped, never guessed */
      }
    }
    return out;
  }

  clear(): void {
    this.db.exec(`DELETE FROM shadow_trades`);
  }
}
