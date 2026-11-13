import type { DatabaseSync, StatementSync } from "node:sqlite";

/** One saved quote for a coin the engine was watching or holding. */
export interface RecordedQuote {
  t: number;
  mint: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number | null;
  vol5mUsd: number | null;
  vol1hUsd: number | null;
  change1hPct: number | null;
  buys5m: number | null;
  sells5m: number | null;
  source: string | null;
  /** When volume and trade counts were actually read. Null: the quote's own time. A reading carried over an outage keeps its old time. */
  flowAt?: number | null;
}

/** One saved engine signal, with the numbers that fired it. */
export interface RecordedSignal {
  t: number;
  mint: string;
  symbol: string;
  kind: string;
  priceUsd: number;
  detail: Record<string, unknown>;
}

export interface RecorderStats {
  enabled: boolean;
  days: number;
  quotes: number;
  signals: number;
  oldestAt: number | null;
}

export const RECORDER = {
  /** Kept this many days unless MARKET_RECORD_DAYS says otherwise. 0 turns recording off. */
  defaultDays: 14,
  maxDays: 90,
  /** A coin is saved at most this often. */
  minGapMs: 5_000,
  /** An unchanged price is still saved this often, so volume and depth changes are kept. */
  unchangedGapMs: 30_000,
  /** Buffered rows are written in one transaction at this size, or on flush(). */
  flushRows: 200,
  pruneEveryMs: 3_600_000,
  exportMax: 50_000,
  /** The most quotes one replay reads. */
  replayMax: 250_000,
  replayPage: 4_000
} as const;

export function recordDays(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return RECORDER.defaultDays;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return RECORDER.defaultDays;
  return Math.min(RECORDER.maxDays, Math.floor(n));
}

/**
 * Saves what the market did around the coins the engine watched, so exits and signals can be
 * replayed later against real data. Writes are buffered and committed in one transaction; nothing
 * here makes a network call or touches a trade.
 */
export class MarketRecorder {
  private readonly insertQuote: StatementSync | null = null;
  private readonly insertSignal: StatementSync | null = null;
  private buffer: RecordedQuote[] = [];
  private readonly last = new Map<string, { t: number; priceUsd: number }>();
  private quotes = 0;
  private signals = 0;
  private oldestAt: number | null = null;
  private prunedAt = 0;

  constructor(
    private readonly db: DatabaseSync,
    readonly days: number = RECORDER.defaultDays
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_quotes (
        ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        liq REAL,
        vol5m REAL,
        vol1h REAL,
        chg1h REAL,
        buys5m INTEGER,
        sells5m INTEGER,
        src TEXT,
        flow_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS market_quotes_ts ON market_quotes(ts);
      CREATE INDEX IF NOT EXISTS market_quotes_mint_ts ON market_quotes(mint, ts);
      CREATE TABLE IF NOT EXISTS market_signals (
        ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        price REAL NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS market_signals_ts ON market_signals(ts);
    `);
    if (this.enabled) {
      this.insertQuote = this.db.prepare(
        `INSERT INTO market_quotes (ts, mint, symbol, price, liq, vol5m, vol1h, chg1h, buys5m, sells5m, src, flow_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      this.insertSignal = this.db.prepare(`INSERT INTO market_signals (ts, mint, symbol, kind, price, detail) VALUES (?, ?, ?, ?, ?, ?)`);
    }
    const q = this.db.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS lo FROM market_quotes`).get() as { n: number; lo: number | null };
    const s = this.db.prepare(`SELECT COUNT(*) AS n FROM market_signals`).get() as { n: number };
    this.quotes = Number(q.n) || 0;
    this.oldestAt = q.lo == null ? null : Number(q.lo);
    this.signals = Number(s.n) || 0;
  }

  get enabled(): boolean {
    return this.days > 0;
  }

  /** Buffer one quote. Returns false when it was skipped (off, bad price, or too soon after the last one for this coin). */
  quote(row: RecordedQuote): boolean {
    if (!this.enabled || !(row.priceUsd > 0) || !Number.isFinite(row.priceUsd) || !Number.isFinite(row.t)) return false;
    const prev = this.last.get(row.mint);
    if (prev) {
      const gap = row.t - prev.t;
      if (gap < RECORDER.minGapMs) return false;
      if (row.priceUsd === prev.priceUsd && gap < RECORDER.unchangedGapMs) return false;
    }
    this.last.set(row.mint, { t: row.t, priceUsd: row.priceUsd });
    this.buffer.push(row);
    if (this.buffer.length >= RECORDER.flushRows) this.flush();
    return true;
  }

  signal(row: RecordedSignal): void {
    if (!this.insertSignal) return;
    try {
      this.insertSignal.run(row.t, row.mint, row.symbol, row.kind, row.priceUsd, JSON.stringify(row.detail));
      this.signals += 1;
    } catch (err) {
      console.error("[recorder] signal", err);
    }
  }

  /** Write the buffered quotes in one transaction. A failed write drops that batch; it never throws into trading. */
  flush(): void {
    if (!this.insertQuote || this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    const num = (n: number | null) => (n != null && Number.isFinite(n) ? n : null);
    try {
      this.db.exec("BEGIN");
      for (const r of rows) {
        this.insertQuote.run(r.t, r.mint, r.symbol, r.priceUsd, num(r.liquidityUsd), num(r.vol5mUsd), num(r.vol1hUsd), num(r.change1hPct), num(r.buys5m), num(r.sells5m), r.source, num(r.flowAt ?? null));
      }
      this.db.exec("COMMIT");
      this.quotes += rows.length;
      if (this.oldestAt == null) this.oldestAt = rows[0]!.t;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* no transaction open */
      }
      console.error("[recorder] flush", err);
    }
  }

  /** Forget coins no longer followed, and once an hour delete rows past the retention window. */
  tidy(now: number, keep?: Iterable<string>): void {
    if (keep) {
      const set = new Set(keep);
      for (const mint of [...this.last.keys()]) if (!set.has(mint)) this.last.delete(mint);
    }
    if (!this.enabled || now - this.prunedAt < RECORDER.pruneEveryMs) return;
    this.prunedAt = now;
    const cutoff = now - this.days * 86_400_000;
    try {
      this.db.prepare(`DELETE FROM market_quotes WHERE ts < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM market_signals WHERE ts < ?`).run(cutoff);
      const q = this.db.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS lo FROM market_quotes`).get() as { n: number; lo: number | null };
      const s = this.db.prepare(`SELECT COUNT(*) AS n FROM market_signals`).get() as { n: number };
      this.quotes = Number(q.n) || 0;
      this.oldestAt = q.lo == null ? null : Number(q.lo);
      this.signals = Number(s.n) || 0;
    } catch (err) {
      console.error("[recorder] prune", err);
    }
  }

  stats(): RecorderStats {
    return { enabled: this.enabled, days: this.days, quotes: this.quotes + this.buffer.length, signals: this.signals, oldestAt: this.oldestAt };
  }

  /** Saved quotes, oldest first. `limit` is capped; `more` says the window held more rows than were returned. */
  quotesBetween(opts: { since?: number; until?: number; mint?: string; limit?: number } = {}): { rows: RecordedQuote[]; more: boolean } {
    this.flush();
    const limit = Math.max(1, Math.min(RECORDER.exportMax, Math.floor(opts.limit ?? 5_000)));
    const since = opts.since ?? 0;
    const until = opts.until ?? Number.MAX_SAFE_INTEGER;
    const sql = `SELECT ts AS t, mint, symbol, price AS priceUsd, liq AS liquidityUsd, vol5m AS vol5mUsd, vol1h AS vol1hUsd, chg1h AS change1hPct, buys5m, sells5m, src AS source, flow_at AS flowAt
                 FROM market_quotes WHERE ts >= ? AND ts <= ?${opts.mint ? " AND mint = ?" : ""} ORDER BY ts ASC LIMIT ?`;
    const args: Array<number | string> = opts.mint ? [since, until, opts.mint, limit + 1] : [since, until, limit + 1];
    const rows = this.db.prepare(sql).all(...args) as unknown as RecordedQuote[];
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  }

  /**
   * The newest `limit` quotes at or after `since`, oldest first, read a page at a time with the
   * event loop handed back between pages: the desk is trading while a replay loads.
   */
  async latestQuotes(since: number, limit: number = RECORDER.replayMax): Promise<RecordedQuote[]> {
    this.flush();
    const cap = Math.max(1, Math.min(RECORDER.replayMax, Math.floor(limit)));
    const page = this.db.prepare(
      `SELECT rowid AS id, ts AS t, mint, symbol, price AS priceUsd, liq AS liquidityUsd, vol5m AS vol5mUsd, vol1h AS vol1hUsd, chg1h AS change1hPct, buys5m, sells5m, src AS source, flow_at AS flowAt
       FROM market_quotes WHERE ts >= ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`
    );
    const out: RecordedQuote[] = [];
    let before = Number.MAX_SAFE_INTEGER;
    while (out.length < cap) {
      const rows = page.all(since, before, Math.min(RECORDER.replayPage, cap - out.length)) as unknown as Array<RecordedQuote & { id: number }>;
      if (rows.length === 0) break;
      for (const row of rows) out.push(row);
      before = rows[rows.length - 1]!.id;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return out.sort((a, b) => a.t - b.t);
  }

  signalsBetween(opts: { since?: number; until?: number; limit?: number } = {}): RecordedSignal[] {
    const limit = Math.max(1, Math.min(RECORDER.exportMax, Math.floor(opts.limit ?? 5_000)));
    const rows = this.db
      .prepare(`SELECT ts AS t, mint, symbol, kind, price AS priceUsd, detail FROM market_signals WHERE ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?`)
      .all(opts.since ?? 0, opts.until ?? Number.MAX_SAFE_INTEGER, limit) as Array<Omit<RecordedSignal, "detail"> & { detail: string }>;
    return rows.map((row) => {
      let detail: Record<string, unknown> = {};
      try {
        detail = JSON.parse(row.detail) as Record<string, unknown>;
      } catch {
        /* an unreadable detail is returned empty */
      }
      return { ...row, detail };
    });
  }
}

const CSV_COLUMNS: Array<keyof RecordedQuote> = ["t", "mint", "symbol", "priceUsd", "liquidityUsd", "vol5mUsd", "vol1hUsd", "change1hPct", "buys5m", "sells5m", "source"];

/** CSV for a spreadsheet or a notebook. Symbols are quoted; a symbol cannot start a formula. */
export function quotesCsv(rows: RecordedQuote[]): string {
  const cell = (value: unknown): string => {
    if (value == null) return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    let text = String(value).replace(/"/g, '""');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text}"`;
  };
  return [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((col) => cell(row[col])).join(","))].join("\n") + "\n";
}
