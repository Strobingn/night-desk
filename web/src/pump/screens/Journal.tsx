import { useEffect, useState } from "react";
import { api } from "../../api";
import { canvasPng, paintDeskReport, shareDeskReport } from "../report";

const CACHE_KEY = "nightdesk.pump.journal";

interface JournalRow {
  signature: string;
  wallet: string;
  mint: string;
  symbol?: string;
  side: "buy" | "sell";
  venue: string;
  solLamports: string;
  tokenAmount: string;
  feeLamports: string;
  marketCapLamports: string;
  priceLamportsPerToken: string;
  timestamp: number;
  outcome: string;
  realizedPnlLamports: string | null;
  costBasisReason?: string;
}

/** Confirmed desk trades. Failed transactions never become a row. */
export function JournalScreen() {
  const [rows, setRows] = useState<JournalRow[]>(() => readCache());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let gone = false;
    void api<{ rows: JournalRow[] }>("/api/pump/journal").then((res) => {
      if (gone) return;
      if (!res.ok) {
        setError(res.body.error ?? "Journal unavailable.");
        return;
      }
      const next = res.body.rows ?? [];
      setRows(next);
      writeCache(next);
    });
    return () => {
      gone = true;
    };
  }, []);

  async function exportCsv() {
    const res = await api<{ csv?: string; filename?: string }>("/api/pump/journal/csv");
    if (!res.ok || !res.body.csv) {
      setError(res.body.error ?? "CSV export failed.");
      return;
    }
    const blob = new Blob([res.body.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = res.body.filename ?? "night-desk-journal.csv";
    link.click();
    URL.revokeObjectURL(url);
    setNotice("CSV uses America/New_York offsets.");
  }

  async function shareReport() {
    const res = await api<{ lines?: string[]; pngBase64?: string }>("/api/pump/journal/report.png");
    const lines = res.body.lines ?? rows.slice(0, 8).map((row) => `${row.side} ${row.symbol ?? row.mint}`);
    const canvas = document.createElement("canvas");
    paintDeskReport(canvas, lines);
    const drawn = await canvasPng(canvas);
    const bytes = drawn ?? (res.body.pngBase64 ? base64ToBytes(res.body.pngBase64) : null);
    if (!bytes) {
      setError("Could not draw the desk report.");
      return;
    }
    try {
      await shareDeskReport(bytes, { title: "Night Desk report", text: lines.join("\n") });
      setNotice("Desk report handed to the share sheet.");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Share failed.");
    }
  }

  return (
    <section className="card" aria-label="Trade journal">
      <header>
        <h3>Journal</h3>
        <span>{rows.length} confirmed</span>
      </header>
      <p className="fine">Buys and sells land here only after the chain confirms them. A failed transaction is not a row. Times in the CSV are US Eastern with the EST/EDT offset.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
        <button type="button" className="ghost sm" onClick={() => void exportCsv()}>
          Export CSV
        </button>
        <button type="button" className="primary sm" onClick={() => void shareReport()}>
          Share desk report
        </button>
      </div>
      {error ? <p className="warn">{error}</p> : null}
      {notice ? <p className="fine">{notice}</p> : null}
      {rows.length === 0 ? <p className="empty">No confirmed trades yet.</p> : null}
      <ul className="scout-status">
        {rows.map((row) => (
          <li key={row.signature}>
            <strong>
              {row.side} {row.symbol ?? short(row.mint)}
            </strong>
            <em>
              {sol(row.solLamports)} SOL · mcap {sol(row.marketCapLamports)} · fee {sol(row.feeLamports)} · {row.outcome}
              {row.realizedPnlLamports != null ? ` · pnl ${sol(row.realizedPnlLamports)} SOL` : ""}
              {row.costBasisReason ? ` · ${row.costBasisReason}` : ""}
            </em>
          </li>
        ))}
      </ul>
    </section>
  );
}

function short(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function sol(raw: string): string {
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  if (!/^\d+$/.test(body)) return raw;
  const whole = BigInt(body) / 1_000_000_000n;
  const frac = (BigInt(body) % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${text}` : text;
}

function readCache(): JournalRow[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as JournalRow[]) : [];
  } catch {
    return [];
  }
}

function writeCache(rows: JournalRow[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(rows));
  } catch {
    /* private mode keeps the in-memory list */
  }
}

function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
