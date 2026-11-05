import type { DeskSnapshot, FeedEvent } from "./types";

type TapeQuotes = NonNullable<DeskSnapshot["tapeQuotes"]>;

export type Verdict = "open" | "bought" | "trade" | "near" | "killed" | "seen";

export interface CoinRow {
  mint: string;
  symbol: string;
  lastTs: number;
  source?: string;
  mark?: number;
  vol1h?: number;
  /** v13.1: 5m volume and 1h price change (percent) when the Scout line carried them. */
  vol5m?: number;
  change1h?: number;
  /** v13.1: 1-based rank by 1h volume among the coins on the tape. */
  volRank?: number;
  score?: number;
  verdict: Verdict;
  reason?: string;
  codes: string[];
  /** v13.10 short reason a live value is missing ("no pool yet"); where the price came from. */
  why?: string;
  quoteSource?: string;
  /** Internal while folding. */
  changeSeen?: number;
  firstMark?: number;
}

const RANK: Record<Verdict, number> = { seen: 0, killed: 1, near: 2, trade: 3, bought: 4, open: 5 };

/**
 * v13 Tape coin cards: fold the event stream into one card per mint, newest first.
 * Risk lines on open positions do not bump a coin to the top, so fresh pairs stay visible.
 */
const SUB_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

/**
 * v13.10 reads a desk price string: plain ("0.0008014", "1.2e-7") or the v13.8 tiny format with
 * subscript zeros ("0.0₅207" = 0.00000207). Returns undefined for 0, blanks or junk (never a 0 price).
 */
export function parsePxText(raw: string | undefined | null): number | undefined {
  if (!raw) return undefined;
  const sub = /^0\.0([₀-₉]+)(\d+)$/.exec(raw.trim());
  let text = raw.trim();
  if (sub) {
    const zeros = Number([...sub[1]].map((c) => SUB_DIGITS.indexOf(c)).join(""));
    text = `0.${"0".repeat(zeros)}${sub[2]}`;
  }
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function coinCards(events: FeedEvent[], openMints: Set<string>, limit = 60, quotes?: TapeQuotes): CoinRow[] {
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
      const m = /Mark ([0-9.eE₀-₉+-]+), 1h volume \$([0-9,.]+)/.exec(e.message);
      if (m) {
        const mark = parsePxText(m[1]) ?? row.mark;
        // No 1h change from the feed: fall back to the move since the first sighting on this tape.
        if (mark) {
          if (row.firstMark == null) row.firstMark = mark;
          else row.changeSeen = (mark / row.firstMark - 1) * 100;
        }
        row.mark = mark;
        const v = Number(m[2].replace(/,/g, "").replace(/\.$/, ""));
        row.vol1h = Number.isFinite(v) ? v : undefined;
      }
      const v5 = /5m volume \$([0-9,.]+)/.exec(e.message);
      if (v5) {
        const n = Number(v5[1].replace(/,/g, "").replace(/\.$/, ""));
        if (Number.isFinite(n)) row.vol5m = n;
      }
      const ch = /1h change ([+-]?)([0-9.]+)%/.exec(e.message);
      if (ch) {
        const n = Number(ch[2]) * (ch[1] === "-" ? -1 : 1);
        if (Number.isFinite(n)) row.change1h = n;
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
  const rows = [...map.values()]
    .filter((row) => row.lastTs > 0 || row.verdict === "open")
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, limit);
  for (const row of rows) {
    // v13.10: the desk's live Tape quote (batched DexScreener / pump.fun curve / Jupiter) wins over the
    // first-sighting line, which is frozen at the moment the Scout saw the coin.
    const q = quotes?.[row.mint];
    if (q) {
      if (q.priceUsd != null && q.priceUsd > 0 && Number.isFinite(q.priceUsd)) row.mark = q.priceUsd;
      // A live 0 never hides real volume the sighting saw (fresh pump.fun pairs read 0 on DexScreener).
      if (q.vol1hUsd != null && Number.isFinite(q.vol1hUsd) && (q.vol1hUsd > 0 || row.vol1h == null)) row.vol1h = q.vol1hUsd;
      if (q.vol5mUsd != null && Number.isFinite(q.vol5mUsd) && (q.vol5mUsd > 0 || row.vol5m == null)) row.vol5m = q.vol5mUsd;
      if (q.change1hPct != null && Number.isFinite(q.change1hPct)) {
        row.change1h = q.change1hPct;
        delete row.changeSeen;
      }
      if (q.why) row.why = q.why;
      if (q.source) row.quoteSource = q.source;
    }
    if (row.change1h == null && row.changeSeen != null && Number.isFinite(row.changeSeen)) row.change1h = row.changeSeen;
    delete row.changeSeen;
    delete row.firstMark;
  }
  rankByVolume(rows);
  return rows;
}

/** 1-based rank by 1h volume (5m breaks ties). Coins with no volume get no rank. */
export function rankByVolume(rows: CoinRow[]): void {
  const ranked = rows
    .filter((r) => r.vol1h != null && Number.isFinite(r.vol1h) && r.vol1h > 0)
    .sort((a, b) => (b.vol1h ?? 0) - (a.vol1h ?? 0) || (b.vol5m ?? 0) - (a.vol5m ?? 0));
  rows.forEach((r) => delete r.volRank);
  ranked.forEach((r, i) => (r.volRank = i + 1));
}

export type TapeSort = "volume" | "newest" | "score";
export const TAPE_SORTS: { id: TapeSort; label: string }[] = [
  { id: "volume", label: "Volume" },
  { id: "newest", label: "Newest" },
  { id: "score", label: "Score" }
];
export const TAPE_SORT_KEY = "nightdesk.tapeSort";
/** Top this many by 1h volume get the volume badge; the top HOT_RANK also get HOT. */
export const TOP_VOLUME = 10;
export const HOT_RANK = 3;

export function parseTapeSort(raw: string | null | undefined): TapeSort {
  return raw === "newest" || raw === "score" || raw === "volume" ? raw : "volume";
}

/** Volume (default): 1h volume high→low, unknown last. Score: high→low, unknown last. Newest: latest line first. */
export function sortCoins(rows: CoinRow[], mode: TapeSort): CoinRow[] {
  const vol = (r: CoinRow) => (r.vol1h != null && Number.isFinite(r.vol1h) ? r.vol1h : -1);
  const sc = (r: CoinRow) => (r.score != null && Number.isFinite(r.score) ? r.score : -1);
  const copy = [...rows];
  if (mode === "newest") return copy.sort((a, b) => b.lastTs - a.lastTs);
  if (mode === "score") return copy.sort((a, b) => sc(b) - sc(a) || vol(b) - vol(a) || b.lastTs - a.lastTs);
  return copy.sort((a, b) => vol(b) - vol(a) || (b.vol5m ?? 0) - (a.vol5m ?? 0) || b.lastTs - a.lastTs);
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
