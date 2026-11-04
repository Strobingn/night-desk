import type { DatabaseSync } from "node:sqlite";
import type { AlertEvent, PumpCoin, TradeEvent, TradeIntent } from "./types.js";

export class PumpStore {
  constructor(readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pump_coins (
        mint TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pump_trades (
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pump_trades_ts ON pump_trades(ts);
      CREATE TABLE IF NOT EXISTS pump_intents (
        id TEXT PRIMARY KEY,
        idem_key TEXT,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        sol_lamports TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pump_intents_created ON pump_intents(created_at);
      CREATE TABLE IF NOT EXISTS pump_alerts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        mint TEXT,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  upsertCoin(coin: PumpCoin): void {
    this.db
      .prepare(
        `INSERT INTO pump_coins (mint, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(mint) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(coin.mint, JSON.stringify(coin), coin.updatedAt);
  }

  getCoin(mint: string): PumpCoin | null {
    const row = this.db.prepare(`SELECT payload FROM pump_coins WHERE mint = ?`).get(mint) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as PumpCoin) : null;
  }

  listCoins(limit = 50): PumpCoin[] {
    const rows = this.db.prepare(`SELECT payload FROM pump_coins ORDER BY updated_at DESC LIMIT ?`).all(limit) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as PumpCoin);
  }

  insertTrade(id: string, event: TradeEvent): void {
    this.db
      .prepare(
        `INSERT INTO pump_trades (id, mint, ts, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(id, event.mint, event.timestamp, JSON.stringify(event));
  }

  recentTrades(limit = 50, mint?: string): TradeEvent[] {
    const rows = (
      mint
        ? this.db.prepare(`SELECT payload FROM pump_trades WHERE mint = ? ORDER BY ts DESC LIMIT ?`).all(mint, limit)
        : this.db.prepare(`SELECT payload FROM pump_trades ORDER BY ts DESC LIMIT ?`).all(limit)
    ) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as TradeEvent).reverse();
  }

  findIntentByIdem(idemKey: string): TradeIntent | null {
    const row = this.db.prepare(`SELECT payload FROM pump_intents WHERE idem_key = ?`).get(idemKey) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as TradeIntent) : null;
  }

  /** `reservedLamports` is the SOL this row holds against the day cap. Sells pass "0". */
  insertIntent(intent: TradeIntent, idemKey?: string, reservedLamports?: string): void {
    this.db
      .prepare(
        `INSERT INTO pump_intents (id, idem_key, wallet, mint, sol_lamports, mode, status, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        intent.id,
        idemKey ?? null,
        intent.wallet,
        intent.mint,
        reservedLamports ?? intent.solLamports,
        intent.mode,
        intent.status,
        intent.createdAt,
        JSON.stringify(intent)
      );
  }

  /** Reserved unsigned intents in the window. Rejected rows are not written. */
  reservedSince(sinceMs: number): bigint {
    const rows = this.db
      .prepare(`SELECT sol_lamports FROM pump_intents WHERE created_at >= ? AND status = 'reserved'`)
      .all(sinceMs) as Array<{ sol_lamports: string }>;
    let total = 0n;
    for (const row of rows) total += BigInt(row.sol_lamports);
    return total;
  }

  insertAlert(event: AlertEvent): void {
    this.db
      .prepare(`INSERT INTO pump_alerts (id, kind, mint, at, payload) VALUES (?, ?, ?, ?, ?)`)
      .run(event.id, event.kind, event.mint ?? null, event.at, JSON.stringify(event));
  }

  recentAlerts(limit = 50): AlertEvent[] {
    const rows = this.db.prepare(`SELECT payload FROM pump_alerts ORDER BY at DESC LIMIT ?`).all(limit) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as AlertEvent).reverse();
  }
}
