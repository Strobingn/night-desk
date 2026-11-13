import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { capEquitySeries } from "../desk/equity-series.js";
import type { ClosedTrade, EquityPoint, FeedEvent, Position } from "../types.js";

/** Points the phone chart reads. Snapshot never ships the raw equity table. */
export const EQUITY_CURVE_POINTS = 240;

interface EquityBucket {
  first: EquityPoint;
  last: EquityPoint;
  min: EquityPoint;
  max: EquityPoint;
}

interface EquityCurveCache {
  since: number;
  max: number;
  origin: number;
  bucketMs: number;
  span: number;
  buckets: Map<number, EquityBucket>;
  points: EquityPoint[];
}

function bucketIndex(t: number, origin: number, bucketMs: number, span: number): number {
  if (!(bucketMs > 0)) return 0;
  return Math.max(0, Math.min(span, Math.floor((t - origin) / bucketMs)));
}

function touchEquityBucket(buckets: Map<number, EquityBucket>, index: number, point: EquityPoint): void {
  const current = buckets.get(index);
  if (!current) {
    buckets.set(index, { first: point, last: point, min: point, max: point });
    return;
  }
  if (point.t < current.first.t) current.first = point;
  if (point.t >= current.last.t) current.last = point;
  if (point.equity < current.min.equity) current.min = point;
  if (point.equity > current.max.equity) current.max = point;
}

function flattenEquityBuckets(buckets: Map<number, EquityBucket>): EquityPoint[] {
  const byTime = new Map<number, EquityPoint>();
  for (const index of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(index)!;
    for (const point of [bucket.first, bucket.last, bucket.min, bucket.max]) {
      if (point && Number.isFinite(point.t)) byTime.set(point.t, point);
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** Place one new ledger row. Widen the grid from the points already kept, never from a 240-cap. */
function absorbEquityPoint(cache: EquityCurveCache, point: EquityPoint): void {
  if (cache.buckets.size === 0) cache.origin = point.t;
  const end = cache.origin + cache.bucketMs * cache.span;
  if (point.t > end) {
    const nextMs = Math.max(cache.bucketMs * 1.000001, (point.t - cache.origin) / cache.span);
    const widened = new Map<number, EquityBucket>();
    for (const bucket of cache.buckets.values()) {
      for (const kept of [bucket.first, bucket.last, bucket.min, bucket.max]) {
        touchEquityBucket(widened, bucketIndex(kept.t, cache.origin, nextMs, cache.span), kept);
      }
    }
    cache.buckets = widened;
    cache.bucketMs = nextMs;
  }
  touchEquityBucket(cache.buckets, bucketIndex(point.t, cache.origin, cache.bucketMs, cache.span), point);
  cache.points = capEquitySeries(flattenEquityBuckets(cache.buckets), cache.max);
}

export interface PersistedBook {
  cashUsd: number;
  startingBalanceUsd: number;
  startedAt: number;
  positions: Position[];
  cooldowns: Array<[string, number]>;
  lastPrices?: Array<[string, number]>;
  markSeries?: Array<[string, Array<{ t: number; priceUsd: number }>]>;
}

export class DeskStore {
  readonly db: DatabaseSync;
  /**
   * Time buckets for one `since`. Inserts update the bucket that owns the timestamp
   * and widen the grid when the session grows. The capped `points` array is derived
   * once per insert, not by resampling the previous cap.
   */
  private curveCache: EquityCurveCache | null = null;
  private liveCurve: { since: number; max: number; points: EquityPoint[] } | null = null;
  private liveInsert: import("node:sqlite").StatementSync | null = null;
  private equityInsert: import("node:sqlite").StatementSync | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly jsonlPath: string,
    private readonly logPath = ":memory:"
  ) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    if (jsonlPath !== ":memory:") mkdirSync(path.dirname(jsonlPath), { recursive: true });
    if (logPath !== ":memory:") mkdirSync(path.dirname(logPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.installEquityAggregate();
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
      CREATE INDEX IF NOT EXISTS equity_ts_value ON equity(ts, equity_usd, cash_usd);
      CREATE TABLE IF NOT EXISTS live_equity (
        ts INTEGER NOT NULL,
        equity_usd REAL NOT NULL,
        cash_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS live_equity_ts ON live_equity(ts);
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
    // v13.3 honest stop labels: the stop line and the mark that triggered the exit.
    if (!cols.has("stop_price")) this.db.exec(`ALTER TABLE trades ADD COLUMN stop_price REAL`);
    if (!cols.has("trigger_price")) this.db.exec(`ALTER TABLE trades ADD COLUMN trigger_price REAL`);
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
    // Prepared once: this runs every two seconds for the life of the desk.
    this.equityInsert ??= this.db.prepare(`INSERT INTO equity (ts, equity_usd, cash_usd) VALUES (?, ?, ?)`);
    this.equityInsert.run(point.t, point.equity, point.cash);
    const cache = this.curveCache;
    if (!cache || point.t < cache.since) return;
    if (cache.buckets.size > 0 && point.t < cache.origin) {
      this.curveCache = null;
      return;
    }
    absorbEquityPoint(cache, point);
  }

  /** v13.41 the live book's equity (wallet USDC plus live positions). Saved far less often than the paper curve. */
  insertLiveEquity(point: EquityPoint): void {
    this.liveInsert ??= this.db.prepare(`INSERT INTO live_equity (ts, equity_usd, cash_usd) VALUES (?, ?, ?)`);
    this.liveInsert.run(point.t, point.equity, point.cash);
    this.liveCurve = null;
  }

  /** The live curve since `sinceTs`, at most `max` points, each time bucket keeping its first, last, low and high. Cached until the next insert. */
  liveEquityCurve(sinceTs: number, max = EQUITY_CURVE_POINTS): EquityPoint[] {
    const hit = this.liveCurve;
    if (hit && hit.since === sinceTs && hit.max === max) return hit.points;
    const rows = this.db
      .prepare(`SELECT ts as t, equity_usd as equity, cash_usd as cash FROM live_equity WHERE ts >= ? ORDER BY ts ASC`)
      .all(sinceTs) as unknown as EquityPoint[];
    let points = rows;
    if (rows.length > max) {
      const origin = rows[0]!.t;
      const span = Math.max(1, Math.floor(max / 4));
      const bucketMs = Math.max(1, Math.ceil((rows[rows.length - 1]!.t - origin + 1) / span));
      const buckets = new Map<number, EquityBucket>();
      for (const row of rows) touchEquityBucket(buckets, bucketIndex(row.t, origin, bucketMs, span - 1), row);
      points = flattenEquityBuckets(buckets);
    }
    this.liveCurve = { since: sinceTs, max, points };
    return points;
  }

  /** Full rows. Recap and the paper-reset archive still want the ledger. The poll path uses [equityCurve]. */
  equitySince(sinceTs: number): EquityPoint[] {
    const rows = this.db
      .prepare(`SELECT ts as t, equity_usd as equity, cash_usd as cash FROM equity WHERE ts >= ? ORDER BY ts ASC`)
      .all(sinceTs) as unknown as EquityPoint[];
    return rows;
  }

  /**
   * v13.33 poll curve. One indexed read, bucketed by time, at most `max` points.
   * Each bucket keeps its first, last, minimum and maximum equity so a spike is not averaged away.
   * The result is cached until the next insert for the same `since`.
   */
  equityCurve(sinceTs: number, max = EQUITY_CURVE_POINTS): EquityPoint[] {
    const hit = this.curveCache;
    if (hit && hit.since === sinceTs && hit.max === max) return hit.points;
    const cache = this.loadCurveCache(sinceTs, max);
    this.curveCache = cache;
    return cache.points;
  }

  /** Cold SQL downsample. Tests time this against [equitySince] on a large table. */
  queryEquityCurve(sinceTs: number, max = EQUITY_CURVE_POINTS): EquityPoint[] {
    const limit = Math.max(2, Math.min(2000, Math.floor(max)));
    const span = limit - 1;
    const rows = this.db
      .prepare(
        `WITH bounds AS (
           SELECT MIN(ts) AS lo, MAX(ts) AS hi
           FROM equity
           WHERE ts >= ?
         )
         SELECT nd_equity_bucket(e.ts, e.equity_usd, e.cash_usd) AS packed
         FROM equity e
         CROSS JOIN bounds b
         WHERE e.ts >= ?
         GROUP BY CASE
           WHEN b.hi IS NULL OR b.hi <= b.lo THEN 0
           ELSE MIN(?, CAST((e.ts - b.lo) * ? / (b.hi - b.lo) AS INTEGER))
         END`
      )
      .all(sinceTs, sinceTs, span, span) as Array<{ packed: string }>;
    const byTime = new Map<number, EquityPoint>();
    for (const row of rows) {
      const packed = JSON.parse(row.packed) as EquityPoint[];
      for (const point of packed) {
        if (point && Number.isFinite(point.t)) byTime.set(point.t, point);
      }
    }
    const ordered = [...byTime.values()].sort((a, b) => a.t - b.t);
    return capEquitySeries(ordered, limit);
  }

  /** Cold SQL read stored as time buckets so later inserts do not resample a 240-point cap. */
  private loadCurveCache(sinceTs: number, max: number): EquityCurveCache {
    const limit = Math.max(2, Math.min(2000, Math.floor(max)));
    const span = limit - 1;
    const rows = this.db
      .prepare(
        `WITH bounds AS (
           SELECT MIN(ts) AS lo, MAX(ts) AS hi
           FROM equity
           WHERE ts >= ?
         )
         SELECT nd_equity_bucket(e.ts, e.equity_usd, e.cash_usd) AS packed
         FROM equity e
         CROSS JOIN bounds b
         WHERE e.ts >= ?
         GROUP BY CASE
           WHEN b.hi IS NULL OR b.hi <= b.lo THEN 0
           ELSE MIN(?, CAST((e.ts - b.lo) * ? / (b.hi - b.lo) AS INTEGER))
         END`
      )
      .all(sinceTs, sinceTs, span, span) as Array<{ packed: string }>;
    const buckets = new Map<number, EquityBucket>();
    let origin = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    const seen: EquityPoint[] = [];
    for (const row of rows) {
      const packed = JSON.parse(row.packed) as Array<EquityPoint | null>;
      for (const point of packed) {
        if (!point || !Number.isFinite(point.t)) continue;
        seen.push(point);
        if (point.t < origin) origin = point.t;
        if (point.t > hi) hi = point.t;
      }
    }
    const bucketMs = seen.length === 0 || hi <= origin ? 1 : Math.max(1, (hi - origin) / span);
    if (seen.length) {
      for (const point of seen) touchEquityBucket(buckets, bucketIndex(point.t, origin, bucketMs, span), point);
    }
    const cache: EquityCurveCache = {
      since: sinceTs,
      max: limit,
      origin: seen.length ? origin : sinceTs,
      bucketMs,
      span,
      buckets,
      points: []
    };
    cache.points = capEquitySeries(flattenEquityBuckets(buckets), limit);
    return cache;
  }

  /**
   * One pass per time bucket. Keeps the first and last rows and the min and max equity
   * rows (with their cash). Registered once; SQLite calls start() per group.
   */
  private installEquityAggregate(): void {
    type Acc = { first: EquityPoint | null; last: EquityPoint | null; min: EquityPoint | null; max: EquityPoint | null };
    // node:sqlite types the accumulator as a SQL scalar. The object stays in-process between step calls.
    this.db.aggregate("nd_equity_bucket", {
      start: (): Acc => ({ first: null, last: null, min: null, max: null }),
      step: (ctx: Acc, ts: number, equity: number, cash: number): Acc => {
        const point = { t: Number(ts), equity: Number(equity), cash: Number(cash) };
        if (!ctx.first) ctx.first = point;
        ctx.last = point;
        if (!ctx.min || point.equity < ctx.min.equity) ctx.min = point;
        if (!ctx.max || point.equity > ctx.max.equity) ctx.max = point;
        return ctx;
      },
      result: (ctx: Acc): string => JSON.stringify([ctx.first, ctx.last, ctx.min, ctx.max])
    } as never);
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
         SET closed_at = ?, proceeds_usd = ?, pnl_usd = ?, pnl_pct = ?, exit_code = ?, entry_price = ?, exit_price = ?, stop_price = ?, trigger_price = ?
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
        trade.stopPrice ?? null,
        trade.triggerPrice ?? null,
        trade.id
      );
  }

  recentClosed(limit = 12): ClosedTrade[] {
    const rows = this.db
      .prepare(
        `SELECT id, mint, symbol, opened_at, closed_at, cost_usd, proceeds_usd, pnl_usd, pnl_pct, exit_code, score, mode, entry_price, exit_price, stop_price, trigger_price
         FROM trades WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToClosed).reverse();
  }

  closedSince(sinceTs: number): ClosedTrade[] {
    const rows = this.db
      .prepare(
        `SELECT id, mint, symbol, opened_at, closed_at, cost_usd, proceeds_usd, pnl_usd, pnl_pct, exit_code, score, mode, entry_price, exit_price, stop_price, trigger_price
         FROM trades WHERE closed_at IS NOT NULL AND closed_at >= ? ORDER BY closed_at ASC`
      )
      .all(sinceTs) as Array<Record<string, unknown>>;
    return rows.map(rowToClosed);
  }

  saveBook(book: PersistedBook, key = "book"): void {
    this.db
      .prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, JSON.stringify(book));
  }

  /**
   * v13.3 session archive before a paper reset. The trades and equity tables are never
   * deleted; this adds a JSON snapshot of the session (kv `archive:<name>` and, on disk,
   * data/archive/<name>.json next to the database). Returns the file path when written.
   */
  archiveSession(name: string, payload: unknown): string | null {
    const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    this.writeJson(`archive:${safe}`, payload);
    const index = this.readJson("archives");
    const list = Array.isArray(index) ? (index as string[]) : [];
    if (!list.includes(safe)) list.push(safe);
    this.writeJson("archives", list);
    if (this.dbPath === ":memory:") return null;
    const dir = path.join(path.dirname(this.dbPath), "archive");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safe}.json`);
    writeFileSync(file, JSON.stringify(payload, null, 2));
    return file;
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

  loadBook(key = "book"): PersistedBook | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
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
    ...(row.exit_price != null ? { exitPrice: Number(row.exit_price) } : {}),
    ...(row.stop_price != null ? { stopPrice: Number(row.stop_price) } : {}),
    ...(row.trigger_price != null ? { triggerPrice: Number(row.trigger_price) } : {})
  };
}
