import type { FeedEvent } from "./types";

export type Verdict = "open" | "bought" | "trade" | "near" | "killed" | "seen";

export interface CoinRow {
  mint: string;
  symbol: string;
  lastTs: number;
  source?: string;
  mark?: number;
  vol1h?: number;
  score?: number;
  verdict: Verdict;
  reason?: string;
  codes: string[];
}

const RANK: Record<Verdict, number> = { seen: 0, killed: 1, near: 2, trade: 3, bought: 4, open: 5 };

/**
 * v13 Tape coin cards: fold the event stream into one card per mint, newest first.
 * Risk lines on open positions do not bump a coin to the top, so fresh pairs stay visible.
 */
export function coinCards(events: FeedEvent[], openMints: Set<string>, limit = 60): CoinRow[] {
  const map = new Map<string, CoinRow>();
  for (const e of events) {
    if (!e.mint) continue;
    let row = map.get(e.mint);
    if (!row) {
      row = { mint: e.mint, symbol: e.symbol ?? e.mint.slice(0, 4), lastTs: 0, verdict: "seen", codes: [] };
      map.set(e.mint, row);
    }
    if (e.symbol) row.symbol = e.symbol;
    if (e.stage !== "risk" && e.stage !== "system") row.lastTs = Math.max(row.lastTs, e.ts);
    const bump = (v: Verdict) => {
      if (RANK[v] >= RANK[row!.verdict] || row!.verdict === "killed") row!.verdict = v;
    };
    if (e.stage === "scout") {
      const m = /Mark ([0-9.eE-]+), 1h volume \$([0-9,.]+)/.exec(e.message);
      if (m) {
        row.mark = Number(m[1]) || undefined;
        row.vol1h = Number(m[2].replace(/,/g, "").replace(/\.$/, ""));
      }
      if (e.detail) row.source = e.detail;
    } else if (e.stage === "filter" && e.kind === "reject") {
      row.verdict = row.verdict === "open" || row.verdict === "bought" ? row.verdict : "killed";
      row.codes = (e.detail ?? e.code ?? "").split(/,\s*/).filter(Boolean);
      row.reason = e.message.replace(/^Filter killed [^.]*\.\s*/, "");
    } else if (e.stage === "analyst") {
      const n = Number(e.detail);
      if (Number.isFinite(n)) row.score = n;
      if (e.kind === "pass") bump("trade");
      else {
        bump("near");
        row.reason = e.message.replace(/^Analyst scored [^.]*\.[0-9]+\.\s*/, "");
      }
    } else if (e.stage === "executor" && e.kind === "fill") {
      bump("bought");
    }
  }
  for (const row of map.values()) if (openMints.has(row.mint)) row.verdict = "open";
  return [...map.values()]
    .filter((row) => row.lastTs > 0 || row.verdict === "open")
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, limit);
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  open: "Open",
  bought: "Bought",
  trade: "Passed",
  near: "Near miss",
  killed: "Killed",
  seen: "Scouted"
};

/** Equity at the start of today (local), from the equity series; falls back to the book start. */
export function dayBase(points: { t: number; equity: number }[], fallback: number, now = Date.now()): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const cut = midnight.getTime();
  let before: number | null = null;
  for (const p of points) {
    if (p.t < cut) before = p.equity;
    else return before ?? p.equity;
  }
  return before ?? fallback;
}
