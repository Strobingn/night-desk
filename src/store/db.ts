import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ClosedTrade, EquityPoint, FeedEvent, Position } from "../types.js";

export interface PersistedBook {
  cashUsd: number;
  startingBalanceUsd: number;
  startedAt: number;
  positions: Position[];
  cooldowns: Array<[string, number]>;
  lastPrices?: Array<[string, number]>;
}

export class DeskStore {
  readonly db: DatabaseSync;

  constructor(
    private readonly dbPath: string,
    private readonly jsonlPath: string,
    private readonly logPath = ":memory:"
  ) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    if (jsonlPath !== ":memory:") mkdirSync(path.dirname(jsonlPath), { recursive: true });
    if (logPath !== ":memory:") mkdirSync(path.dirname(logPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        stage TEXT NOT NULL,
        kind TEXT NOT NULL,
        mint TEXT,
        symbol TEXT,
        code TEXT,
        message TEXT NOT NULL,
        detail TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS equity (
        ts INTEGER NOT NULL,
        equity_usd REAL NOT NULL,
        cash_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS equity_ts ON equity(ts);
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        cost_usd REAL NOT NULL,
        proceeds_usd REAL,
        pnl_usd REAL,
        pnl_pct REAL,
        exit_code TEXT,
        score REAL,
        mode TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(trades)`).all() as Array<{ name: string }>).map((col) => col.name)
    );
    if (!cols.has("entry_price")) this.db.exec(`ALTER TABLE trades ADD COLUMN entry_price REAL`);
    if (!cols.has("exit_price")) this.db.exec(`ALTER TABLE trades ADD COLUMN exit_price REAL`);
  }

  appendEvent(event: FeedEvent, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO events (id, ts, stage, kind, mint, symbol, code, message, detail, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.ts,
        event.stage,
        event.kind,
        event.mint ?? null,
        event.symbol ?? null,
        event.code ?? null,
        event.message,
        event.detail ?? null,
        JSON.stringify(payload ?? null)
      );
    if (this.jsonlPath !== ":memory:") {
      const line = JSON.stringify({ ...event, payload }) + "\n";
      void appendFile(this.jsonlPath, line).catch((err) => {
        console.error("[logger] jsonl append failed", err);
      });
    }
    if (this.logPath !== ":memory:") {
      const stamp = new Date(event.ts).toISOString();
      const line = `${stamp}\t${event.stage}\t${event.kind}\t${event.code ?? ""}\t${event.symbol ?? ""}\t${event.message}\n`;
      try {
        appendFileSync(this.logPath, line);
      } catch (err) {
        console.error("[logger] desk.log append failed", err);
      }
    }
  }

  /** Full history, oldest last in the returned array is newest. Chronological order. */
  queryEvents(filter: { limit?: number; stage?: string; before?: number } = {}): FeedEvent[] {
    const limit = Math.min(2000, Math.max(1, filter.limit ?? 500));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.stage && filter.stage !== "all") {
      where.push("stage = ?");
      params.push(filter.stage);
    }
    if (filter.before != null && Number.isFinite(filter.before)) {
      where.push("ts < ?");
      params.push(filter.before);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT id, ts, stage, kind, mint, symbol, code, message, detail
         FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ts DESC, rowid DESC LIMIT ?`
      )
      .all(...params) as unknown as Array<FeedEvent & { mint: string | null; symbol: string | null; code: string | null; detail: string | null }>;
    return rows
      .map((row) => ({
        id: row.id,
        ts: row.ts,
        stage: row.stage,
        kind: row.kind,
        mint: row.mint ?? undefined,
        symbol: row.symbol ?? undefined,
        code: row.code ?? undefined,
        message: row.message,
        detail: row.detail ?? undefined
      }))
      .reverse();
  }

  recentEvents(limit = 200): FeedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, stage, kind, mint, symbol, code, message, detail
         FROM events ORDER BY ts DESC, rowid DESC LIMIT ?`
      )
      .all(limit) as unknown as Array<FeedEvent & { mint: string | null; symbol: string | null; code: string | null; detail: string | null }>;
    return rows
      .map((row) => ({
        id: row.id,
        ts: row.ts,
        stage: row.stage,
        kind: row.kind,
        mint: row.mint ?? undefined,
        symbol: row.symbol ?? undefined,
        code: row.code ?? undefined,
        message: row.message,
        detail: row.detail ?? undefined
      }))
      .reverse();
  }

  eventsSince(sinceTs: number): Array<FeedEvent & { payload: unknown }> {
    const rows = this.db
      .prepare(
        `SELECT id, ts, stage, kind, mint, symbol, code, message, detail, payload
         FROM events WHERE ts >= ? ORDER BY ts ASC`
      )
      .all(sinceTs) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      ts: Number(row.ts),
      stage: row.stage as FeedEvent["stage"],
      kind: row.kind as FeedEvent["kind"],
      mint: (row.mint as string | null) ?? undefined,
      symbol: (row.symbol as string | null) ?? undefined,
      code: (row.code as string | null) ?? undefined,
      message: String(row.message),
      detail: (row.detail as string | null) ?? undefined,
      payload: JSON.parse(String(row.payload ?? "null"))
    }));
  }

  insertEquity(point: EquityPoint): void {
    this.db.prepare(`INSERT INTO equity (ts, equity_usd, cash_usd) VALUES (?, ?, ?)`).run(point.t, point.equity, point.cash);
  }

  equitySince(sinceTs: number): EquityPoint[] {
    const rows = this.db
      .prepare(`SELECT ts as t, equity_usd as equity, cash_usd as cash FROM equity WHERE ts >= ? ORDER BY ts ASC`)
      .all(sinceTs) as unknown as EquityPoint[];
    return rows;
  }

  openTrade(trade: { id: string; mint: string; symbol: string; openedAt: number; costUsd: number; score: number; mode: "paper" | "live" }): void {
    this.db
      .prepare(
        `INSERT INTO trades (id, mint, symbol, opened_at, cost_usd, score, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(trade.id, trade.mint, trade.symbol, trade.openedAt, trade.costUsd, trade.score, trade.mode);
  }

  closeTrade(trade: ClosedTrade): void {
    this.db
      .prepare(
        `UPDATE trades
         SET closed_at = ?, proceeds_usd = ?, pnl_usd = ?, pnl_pct = ?, exit_code = ?, entry_price = ?, exit_price = ?
         WHERE id = ?`
      )
      .run(
        trade.closedAt,
        trade.proceedsUsd,
        trade.pnlUsd,
        trade.pnlPct,
        trade.exitCode,
        trade.entryPrice ?? null,
        trade.exitPrice ?? null,
        trade.id
      );
  }

  recentClosed(limit = 12): ClosedTrade[] {
    const rows = this.db
      .prepare(
        `SELECT id, mint, symbol, opened_at, closed_at, cost_usd, proceeds_usd, pnl_usd, pnl_pct, exit_code, score, mode, entry_price, exit_price
         FROM trades WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToClosed).reverse();
  }

  closedSince(sinceTs: number): ClosedTrade[] {
    const rows = this.db
      .prepare(
        `SELECT id, mint, symbol, opened_at, closed_at, cost_usd, proceeds_usd, pnl_usd, pnl_pct, exit_code, score, mode, entry_price, exit_price
         FROM trades WHERE closed_at IS NOT NULL AND closed_at >= ? ORDER BY closed_at ASC`
      )
      .all(sinceTs) as Array<Record<string, unknown>>;
    return rows.map(rowToClosed);
  }

  saveBook(book: PersistedBook): void {
    this.db
      .prepare(`INSERT INTO kv (key, value) VALUES ('book', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(book));
  }

  readJson(key: string): unknown | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  }

  writeJson(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, JSON.stringify(value));
  }

  loadBook(): PersistedBook | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = 'book'`).get() as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as PersistedBook;
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}

function rowToClosed(row: Record<string, unknown>): ClosedTrade {
  return {
    id: String(row.id),
    mint: String(row.mint),
    symbol: String(row.symbol),
    openedAt: Number(row.opened_at),
    closedAt: Number(row.closed_at),
    costUsd: Number(row.cost_usd),
    proceedsUsd: Number(row.proceeds_usd),
    pnlUsd: Number(row.pnl_usd),
    pnlPct: Number(row.pnl_pct),
    exitCode: row.exit_code as ClosedTrade["exitCode"],
    score: Number(row.score),
    mode: row.mode as ClosedTrade["mode"],
    ...(row.entry_price != null ? { entryPrice: Number(row.entry_price) } : {}),
    ...(row.exit_price != null ? { exitPrice: Number(row.exit_price) } : {})
  };
}
