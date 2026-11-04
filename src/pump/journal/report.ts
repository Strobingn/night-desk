/**
 * Share payload for a desk report. The web screen passes this to navigator.share.
 * Android builds the same lines into a PNG and hands it to the system share sheet.
 */
import type { JournalRow } from "./journal.js";
import { lamportsToSol } from "./journal.js";
import type { PnlTotals } from "../portfolio/pnl.js";
import type { DeskScore } from "../portfolio/score.js";

export interface DeskReport {
  title: string;
  generatedAt: number;
  wallets: string[];
  trades: number;
  realizedPnlLamports: string | null;
  realizedReason?: string;
  unrealizedPnlLamports: string | null;
  unrealizedReason?: string;
  score: DeskScore;
}

export interface DeskShareFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface DeskShareRequest {
  title: string;
  text: string;
  files: DeskShareFile[];
}

export function buildDeskReport(input: {
  rows: readonly JournalRow[];
  totals: PnlTotals;
  score: DeskScore;
  generatedAt: number;
}): DeskReport {
  return {
    title: "Night Desk report",
    generatedAt: input.generatedAt,
    wallets: input.totals.wallets,
    trades: input.rows.length,
    realizedPnlLamports: input.totals.realizedPnlLamports,
    realizedReason: input.totals.realizedReason,
    unrealizedPnlLamports: input.totals.unrealizedPnlLamports,
    unrealizedReason: input.totals.unrealizedReason,
    score: input.score
  };
}

export function deskReportLines(report: DeskReport): string[] {
  const realized = report.realizedPnlLamports == null ? report.realizedReason ?? "PnL withheld" : `${signedSol(report.realizedPnlLamports)} SOL`;
  const unrealized = report.unrealizedPnlLamports == null ? report.unrealizedReason ?? "PnL withheld" : `${signedSol(report.unrealizedPnlLamports)} SOL`;
  return [
    "NIGHT DESK",
    "DESK REPORT",
    `WALLETS ${report.wallets.length}`,
    `TRADES ${report.trades}`,
    `REALIZED ${realized}`,
    `UNREALIZED ${unrealized}`,
    `SCORE ${report.score.score}`,
    `VOLUME ${lamportsToSol(report.score.volumeLamports)} SOL`,
    `HOLD FACTOR ${report.score.holdFactor.toFixed(2)}`,
    "SCORE = ROUND 100 * (0.5 * HOLD + 0.5 * VOLUME)"
  ];
}

export function deskShareRequest(bytes: Uint8Array, report: DeskReport): DeskShareRequest {
  return {
    title: report.title,
    text: deskReportLines(report).join("\n"),
    files: [{ name: "desk-report.png", type: "image/png", bytes }]
  };
}

export async function shareDeskReport(request: DeskShareRequest, share: (data: DeskShareRequest) => Promise<void>): Promise<void> {
  if (request.files.length === 0 || request.files[0]?.type !== "image/png") {
    throw new Error("Desk report share requires a PNG.");
  }
  await share(request);
}

function signedSol(raw: string): string {
  const neg = raw.startsWith("-");
  const sol = lamportsToSol(neg ? raw.slice(1) : raw);
  if (sol === "0") return "0";
  return neg ? `-${sol}` : `+${sol}`;
}
