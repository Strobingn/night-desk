/**
 * Journal CSV. Timestamps are America/New_York wall time with the numeric offset
 * (EST -05:00, EDT -04:00), including the DST transitions.
 */
import type { JournalRow } from "./journal.js";

export const CSV_HEADER =
  "timestamp_et,signature,wallet,mint,symbol,side,venue,size_lamports,token_amount,price_lamports_per_token,market_cap_lamports,fee_lamports,realized_pnl_lamports,outcome,cost_basis_reason";

export function formatTimestampEt(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZoneName: "longOffset"
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const offset = get("timeZoneName").replace(/^GMT/, "");
  const frac = get("fractionalSecond").padEnd(3, "0");
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}.${frac}${offset}`;
}

export function journalCsv(rows: readonly JournalRow[]): string {
  const lines = [CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        formatTimestampEt(row.timestamp),
        row.signature,
        row.wallet,
        row.mint,
        row.symbol ?? "",
        row.side,
        row.venue,
        row.solLamports,
        row.tokenAmount,
        row.priceLamportsPerToken,
        row.marketCapLamports,
        row.feeLamports,
        row.realizedPnlLamports ?? "",
        row.outcome,
        row.costBasisReason ?? ""
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
