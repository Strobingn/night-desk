/**
 * Desk trade journal. A row exists only after the chain confirms the user's buy or sell.
 * Failed, dropped, and merely processed transactions are not logged. The signature is the
 * primary key, so a second report of the same confirmed transaction does not add a row.
 */
import type { DatabaseSync } from "node:sqlite";
import type { RawAmount } from "../types.js";

export type Confirmation = "processed" | "confirmed" | "finalized" | "failed";
export type JournalSide = "buy" | "sell";
export type JournalVenue = "curve" | "pumpswap";
export type JournalSource = "desk" | "chain";

export interface TradeReport {
  signature: string;
  wallet: string;
  mint: string;
  symbol?: string;
  side: JournalSide;
  venue: JournalVenue;
  solLamports: RawAmount;
  tokenAmount: RawAmount;
  feeLamports: RawAmount;
  marketCapLamports: RawAmount;
  timestamp: number;
  confirmation: Confirmation;
  err?: string | null;
  source?: JournalSource;
}

/** Stored fill. Outcome fields are derived, not written, so a later sell can close an earlier buy. */
export interface JournalEntry {
  signature: string;
  wallet: string;
  mint: string;
  symbol?: string;
  side: JournalSide;
  venue: JournalVenue;
  source: JournalSource;
  solLamports: RawAmount;
  tokenAmount: RawAmount;
  feeLamports: RawAmount;
  marketCapLamports: RawAmount;
  /** Quote lamports per one raw token, at the fill. Fees are not folded into this price. */
  priceLamportsPerToken: string;
  timestamp: number;
}

export type JournalOutcome = "open" | "closed" | "realized" | "unknown_basis";

export interface JournalRow extends JournalEntry {
  outcome: JournalOutcome;
  /** Null when the row has no realized number. Never "0" as a stand-in for an unknown basis. */
  realizedPnlLamports: RawAmount | null;
  costBasisReason?: string;
}

export interface RecordResult {
  logged: boolean;
  duplicate: boolean;
  row: JournalRow | null;
}

export const JOURNAL_CACHE_KEY = "nightdesk.pump.journal";

const UNKNOWN_BASIS =
  "No buy in the imported history covers this sell. Cost basis is unknown, so realized PnL is withheld.";

export function isConfirmed(report: Pick<TradeReport, "confirmation" | "err">): boolean {
  if (report.err) return false;
  return report.confirmation === "confirmed" || report.confirmation === "finalized";
}

export function parseAmount(value: string, name: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer string.`);
  return BigInt(value);
}

/** Quote lamports per one raw token, as a decimal string. */
export function priceLamportsPerToken(solLamports: bigint, tokenAmount: bigint): string {
  if (tokenAmount <= 0n) return "0";
  const scale = 1_000_000_000_000n;
  const scaled = (solLamports * scale) / tokenAmount;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(12, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function lamportsToSol(raw: string | null | undefined): string {
  if (raw == null || raw === "") return "";
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  if (!/^\d+$/.test(body)) return raw;
  const v = BigInt(body);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${text}` : text;
}

function entryFromReport(report: TradeReport): JournalEntry {
  const sol = parseAmount(report.solLamports, "solLamports");
  const tokens = parseAmount(report.tokenAmount, "tokenAmount");
  parseAmount(report.feeLamports, "feeLamports");
  parseAmount(report.marketCapLamports, "marketCapLamports");
  if (!report.signature.trim()) throw new Error("signature is required.");
  if (!report.wallet.trim() || !report.mint.trim()) throw new Error("wallet and mint are required.");
  if (report.side !== "buy" && report.side !== "sell") throw new Error("side must be buy or sell.");
  if (report.venue !== "curve" && report.venue !== "pumpswap") throw new Error("venue must be curve or pumpswap.");
  if (!Number.isFinite(report.timestamp)) throw new Error("timestamp is required.");
  if (tokens <= 0n) throw new Error("tokenAmount must be positive.");
  return {
    signature: report.signature.trim(),
    wallet: report.wallet.trim(),
    mint: report.mint.trim(),
    symbol: report.symbol?.trim() || undefined,
    side: report.side,
    venue: report.venue,
    source: report.source === "chain" ? "chain" : "desk",
    solLamports: sol.toString(),
    tokenAmount: tokens.toString(),
    feeLamports: BigInt(report.feeLamports).toString(),
    marketCapLamports: BigInt(report.marketCapLamports).toString(),
    priceLamportsPerToken: priceLamportsPerToken(sol, tokens),
    timestamp: report.timestamp
  };
}

interface Lot {
  signature: string;
  tokens: bigint;
  cost: bigint;
  ts: number;
}

interface Derived {
  outcome: JournalOutcome;
  realizedPnlLamports: string | null;
  costBasisReason?: string;
}

/**
 * FIFO match per wallet + mint. Buy fees join the lot cost. Sell fees reduce proceeds.
 * A sell larger than the buys on file does not realize 0; the row stays unknown.
 */
export function deriveRows(entries: readonly JournalEntry[]): JournalRow[] {
  const sorted = [...entries].sort(byTime);
  const books = new Map<string, Lot[]>();
  const derived = new Map<string, Derived>();
  const consumed = new Map<string, bigint>();

  for (const entry of sorted) {
    const key = `${entry.wallet}\u0000${entry.mint}`;
    const lots = books.get(key) ?? [];
    books.set(key, lots);
    if (entry.side === "buy") {
      lots.push({
        signature: entry.signature,
        tokens: BigInt(entry.tokenAmount),
        cost: BigInt(entry.solLamports) + BigInt(entry.feeLamports),
        ts: entry.timestamp
      });
      consumed.set(entry.signature, 0n);
      derived.set(entry.signature, { outcome: "open", realizedPnlLamports: null });
      continue;
    }
    let need = BigInt(entry.tokenAmount);
    let cost = 0n;
    while (need > 0n && lots.length > 0) {
      const lot = lots[0]!;
      const take = need < lot.tokens ? need : lot.tokens;
      const takeCost = (lot.cost * take) / lot.tokens;
      lot.cost -= takeCost;
      lot.tokens -= take;
      need -= take;
      cost += takeCost;
      consumed.set(lot.signature, (consumed.get(lot.signature) ?? 0n) + take);
      if (lot.tokens === 0n) lots.shift();
    }
    if (need > 0n) {
      derived.set(entry.signature, {
        outcome: "unknown_basis",
        realizedPnlLamports: null,
        costBasisReason: UNKNOWN_BASIS
      });
    } else {
      const pnl = BigInt(entry.solLamports) - BigInt(entry.feeLamports) - cost;
      derived.set(entry.signature, { outcome: "realized", realizedPnlLamports: pnl.toString() });
    }
  }

  for (const entry of sorted) {
    if (entry.side !== "buy") continue;
    const original = BigInt(entry.tokenAmount);
    const used = consumed.get(entry.signature) ?? 0n;
    const row = derived.get(entry.signature);
    if (row && used >= original && original > 0n) row.outcome = "closed";
  }

  return sorted.map((entry) => {
    const extra = derived.get(entry.signature) ?? { outcome: "open" as const, realizedPnlLamports: null };
    return { ...entry, ...extra };
  });
}

function byTime(a: JournalEntry, b: JournalEntry): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
}

export interface ReplayFrame {
  index: number;
  at: number;
  signature: string;
  mint: string;
  symbol?: string;
  side: JournalSide;
  venue: JournalVenue;
  marketCapLamports: RawAmount;
  solLamports: RawAmount;
  tokenAmount: RawAmount;
  priceLamportsPerToken: string;
}

/** Curve-chart points in journal order. The scrub index clamps to the series. */
export function replayFrames(rows: readonly JournalRow[], mint?: string): ReplayFrame[] {
  const picked = (mint ? rows.filter((row) => row.mint === mint) : [...rows]).slice().sort(byTime);
  return picked.map((row, index) => ({
    index,
    at: row.timestamp,
    signature: row.signature,
    mint: row.mint,
    symbol: row.symbol,
    side: row.side,
    venue: row.venue,
    marketCapLamports: row.marketCapLamports,
    solLamports: row.solLamports,
    tokenAmount: row.tokenAmount,
    priceLamportsPerToken: row.priceLamportsPerToken
  }));
}

export function scrubReplay(frames: readonly ReplayFrame[], index: number): ReplayFrame | null {
  if (frames.length === 0) return null;
  const at = Math.min(frames.length - 1, Math.max(0, Math.trunc(index)));
  return frames[at] ?? null;
}

export interface CacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function writeJournalCache(storage: CacheStorage, rows: readonly JournalRow[]): void {
  storage.setItem(JOURNAL_CACHE_KEY, JSON.stringify(rows));
}

export function readJournalCache(storage: Pick<CacheStorage, "getItem">): JournalRow[] | null {
  const raw = storage.getItem(JOURNAL_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as JournalRow[]) : null;
  } catch {
    return null;
  }
}

export class JournalStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pump_journal (
        signature TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pump_journal_wallet ON pump_journal(wallet, ts);
    `);
  }

  /**
   * Confirmed reports become one row. Anything else, including a failed transaction
   * that still has a signature, is ignored. Repeating a confirmed signature is a no-op.
   */
  record(report: TradeReport): RecordResult {
    if (!isConfirmed(report)) return { logged: false, duplicate: false, row: null };
    const entry = entryFromReport(report);
    const existing = this.read(entry.signature);
    if (!existing) {
      this.db
        .prepare(`INSERT INTO pump_journal (signature, wallet, mint, ts, payload) VALUES (?, ?, ?, ?, ?)`)
        .run(entry.signature, entry.wallet, entry.mint, entry.timestamp, JSON.stringify(entry));
    }
    const row = this.rows().find((item) => item.signature === entry.signature) ?? null;
    return { logged: true, duplicate: existing != null, row };
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM pump_journal`).get() as { n: number };
    return Number(row.n);
  }

  entries(): JournalEntry[] {
    const rows = this.db.prepare(`SELECT payload FROM pump_journal ORDER BY ts ASC, signature ASC`).all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as JournalEntry);
  }

  rows(): JournalRow[] {
    return deriveRows(this.entries());
  }

  private read(signature: string): JournalEntry | null {
    const row = this.db.prepare(`SELECT payload FROM pump_journal WHERE signature = ?`).get(signature) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as JournalEntry) : null;
  }
}
