/**
 * Journal and portfolio routes. PumpCore calls this for paths it does not own.
 * Bodies stay JSON because the desk HTTP server writes JSON for every pump response.
 */
import type { DatabaseSync } from "node:sqlite";
import type { TradeEvent } from "../types.js";
import { journalCsv } from "./csv.js";
import { importReports, reportsFromTrades } from "./import.js";
import { JournalStore, replayFrames, scrubReplay, type TradeReport } from "./journal.js";
import { renderDeskReportPng } from "./png.js";
import { buildDeskReport, deskReportLines } from "./report.js";
import { WalletBook, portfolioOf } from "../portfolio/holdings.js";
import type { PositionMark } from "../portfolio/pnl.js";

export interface JournalHttpContext {
  db: DatabaseSync;
  now: () => number;
}

export interface JournalHttpResult {
  status: number;
  body: unknown;
}

export async function handleJournalPortfolio(ctx: JournalHttpContext, method: string, url: URL, body: Record<string, unknown>): Promise<JournalHttpResult | null> {
  const path = url.pathname.replace(/\/$/, "");
  if (!path.startsWith("/api/pump/journal") && !path.startsWith("/api/pump/portfolio")) return null;
  try {
    return route(ctx, method, path, url, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "journal error";
    return { status: 400, body: { ok: false, error: message, code: "BAD_REQUEST" } };
  }
}

function route(ctx: JournalHttpContext, method: string, path: string, url: URL, body: Record<string, unknown>): JournalHttpResult {
  const journal = new JournalStore(ctx.db);
  if (path === "/api/pump/journal/report" && method === "POST") {
    const result = journal.record(reportFrom(body.trade ?? body));
    return { status: 200, body: { ok: true, logged: result.logged, duplicate: result.duplicate, row: result.row, count: journal.count() } };
  }
  if (path === "/api/pump/journal/csv" && method === "GET") {
    return { status: 200, body: { ok: true, filename: "night-desk-journal.csv", csv: journalCsv(journal.rows()) } };
  }
  if (path === "/api/pump/journal/replay" && method === "GET") {
    const frames = replayFrames(journal.rows(), url.searchParams.get("mint") ?? undefined);
    const index = Number(url.searchParams.get("index") ?? frames.length - 1);
    return { status: 200, body: { ok: true, frames, frame: scrubReplay(frames, Number.isFinite(index) ? index : 0) } };
  }
  if (path === "/api/pump/journal/report.png" && method === "GET") {
    const snap = portfolioOf(ctx.db, readMarks(ctx.db), ctx.now());
    const connected = new Set(snap.wallets.map((wallet) => wallet.pubkey));
    const rows = journal.rows().filter((row) => connected.size === 0 || connected.has(row.wallet));
    const report = buildDeskReport({ rows, totals: snap.totals, score: snap.score, generatedAt: ctx.now() });
    const png = renderDeskReportPng(deskReportLines(report));
    return { status: 200, body: { ok: true, filename: "desk-report.png", contentType: "image/png", pngBase64: png.toString("base64"), lines: deskReportLines(report) } };
  }
  if (path === "/api/pump/journal" && method === "GET") {
    const wallet = url.searchParams.get("wallet");
    const rows = journal.rows().filter((row) => (wallet ? row.wallet === wallet : true));
    return { status: 200, body: { ok: true, rows, count: rows.length } };
  }
  if (path === "/api/pump/portfolio/wallets" && method === "GET") {
    return { status: 200, body: { ok: true, wallets: new WalletBook(ctx.db).list() } };
  }
  if (path === "/api/pump/portfolio/wallets" && method === "POST") {
    const pubkey = str(body.pubkey) || str(body.wallet);
    const wallet = new WalletBook(ctx.db).add(pubkey, ctx.now(), str(body.label) || undefined);
    return { status: 200, body: { ok: true, wallet, wallets: new WalletBook(ctx.db).list() } };
  }
  if ((path === "/api/pump/portfolio/wallets" && method === "DELETE") || (path === "/api/pump/portfolio/wallets/remove" && method === "POST")) {
    const pubkey = str(body.pubkey) || str(body.wallet) || url.searchParams.get("pubkey") || "";
    new WalletBook(ctx.db).remove(pubkey);
    return { status: 200, body: { ok: true, wallets: new WalletBook(ctx.db).list() } };
  }
  if (path === "/api/pump/portfolio/marks" && method === "POST") {
    const marks = marksFrom(body.marks ?? body.mark);
    writeMarks(ctx.db, marks);
    return { status: 200, body: { ok: true, marks: readMarks(ctx.db) } };
  }
  if (path === "/api/pump/portfolio/import" && method === "POST") {
    const wallet = str(body.wallet);
    const fills = Array.isArray(body.fills)
      ? body.fills.map((fill) => {
          const report = reportFrom(fill, wallet);
          const raw = fill && typeof fill === "object" ? (fill as Record<string, unknown>) : {};
          report.source = raw.source === "desk" ? "desk" : "chain";
          return report;
        })
      : [];
    if (body.fromChain === true) fills.push(...chainFills(ctx.db, wallet));
    if (fills.length === 0 && body.fromChain !== true) throw new Error("fills or fromChain is required.");
    const imported = importReports(journal, fills);
    if (body.marks) writeMarks(ctx.db, marksFrom(body.marks));
    const snap = portfolioOf(ctx.db, readMarks(ctx.db), ctx.now());
    return { status: 200, body: { ok: true, imported: { logged: imported.logged, skipped: imported.skipped, duplicates: imported.duplicates }, portfolio: snap } };
  }
  if (path === "/api/pump/portfolio" && method === "GET") {
    const snap = portfolioOf(ctx.db, readMarks(ctx.db), ctx.now(), url.searchParams.get("wallet") ?? undefined);
    return { status: 200, body: { ok: true, portfolio: snap } };
  }
  return { status: 404, body: { ok: false, error: "Unknown pump route.", code: "NOT_FOUND" } };
}

function chainFills(db: DatabaseSync, wallet: string): TradeReport[] {
  let rows: Array<{ payload: string }> = [];
  try {
    rows = db.prepare(`SELECT payload FROM pump_trades ORDER BY ts ASC`).all() as Array<{ payload: string }>;
  } catch {
    return [];
  }
  const events = rows.map((row) => JSON.parse(row.payload) as TradeEvent);
  const supplyByMint: Record<string, string> = {};
  const symbolByMint: Record<string, string> = {};
  try {
    const coins = db.prepare(`SELECT payload FROM pump_coins`).all() as Array<{ payload: string }>;
    for (const coinRow of coins) {
      const coin = JSON.parse(coinRow.payload) as { mint?: string; symbol?: string; curve?: { tokenTotalSupply?: string } | null };
      if (!coin.mint) continue;
      if (coin.symbol) symbolByMint[coin.mint] = coin.symbol;
      if (coin.curve?.tokenTotalSupply) supplyByMint[coin.mint] = coin.curve.tokenTotalSupply;
    }
  } catch {
    /* coins table is optional for a bare journal db */
  }
  return reportsFromTrades(events, { wallet: wallet || undefined, supplyByMint, symbolByMint });
}

function reportFrom(value: unknown, walletFallback = ""): TradeReport {
  const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const side = str(body.side);
  const venue = str(body.venue) || "curve";
  const confirmation = str(body.confirmation);
  if (confirmation === "confirmed" || confirmation === "finalized") {
    if (side !== "buy" && side !== "sell") throw new Error("side must be buy or sell.");
    if (venue !== "curve" && venue !== "pumpswap") throw new Error("venue must be curve or pumpswap.");
  }
  return {
    signature: str(body.signature),
    wallet: str(body.wallet) || walletFallback,
    mint: str(body.mint),
    symbol: str(body.symbol) || undefined,
    side: side === "sell" ? "sell" : "buy",
    venue: venue === "pumpswap" ? "pumpswap" : "curve",
    solLamports: str(body.solLamports),
    tokenAmount: str(body.tokenAmount),
    feeLamports: str(body.feeLamports) || "0",
    marketCapLamports: str(body.marketCapLamports) || "0",
    timestamp: typeof body.timestamp === "number" ? body.timestamp : Number(body.timestamp ?? Date.now()),
    confirmation: confirmation === "processed" || confirmation === "failed" || confirmation === "finalized" || confirmation === "confirmed" ? confirmation : "failed",
    err: typeof body.err === "string" ? body.err : null,
    source: body.source === "chain" ? "chain" : "desk"
  };
}

function marksFrom(value: unknown): PositionMark[] {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return list.flatMap((item) => {
    const mark = item as Record<string, unknown>;
    const mint = str(mark.mint);
    const priceLamportsPerToken = str(mark.priceLamportsPerToken);
    if (!mint || !priceLamportsPerToken) return [];
    const venue = str(mark.venue);
    const next: PositionMark = {
      mint,
      priceLamportsPerToken,
      marketCapLamports: str(mark.marketCapLamports) || undefined,
      progressPct: typeof mark.progressPct === "number" ? mark.progressPct : undefined,
      venue: venue === "pumpswap" ? "pumpswap" : venue === "curve" ? "curve" : undefined
    };
    return [next];
  });
}

function readMarks(db: DatabaseSync): PositionMark[] {
  db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM kv WHERE key = 'pumpPositionMarks'`).get() as { value: string } | undefined;
  if (!row) return [];
  const parsed = JSON.parse(row.value) as unknown;
  return Array.isArray(parsed) ? (parsed as PositionMark[]) : [];
}

function writeMarks(db: DatabaseSync, marks: PositionMark[]): void {
  const merged = new Map(readMarks(db).map((mark) => [mark.mint, mark]));
  for (const mark of marks) merged.set(mark.mint, mark);
  db.prepare(`INSERT INTO kv (key, value) VALUES ('pumpPositionMarks', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify([...merged.values()]));
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
