import type { ClosedTrade, EquityPoint, FeedEvent, PositionView } from "../types.js";

export interface Recap {
  since: number;
  until: number;
  startingEquity: number;
  endingEquity: number;
  pnlUsd: number;
  pnlPct: number;
  closed: ClosedTrade[];
  wins: ClosedTrade[];
  losses: ClosedTrade[];
  breakeven: ClosedTrade[];
  /** Wins divided by closed trades. Null when nothing closed. Breakeven is neither a win nor a loss. */
  winRate: number | null;
  biggestWin?: ClosedTrade;
  biggestLoss?: ClosedTrade;
  open: PositionView[];
  filterKills: number;
  filterPasses: number;
  killReasons: Record<string, number>;
  analystRejects: number;
  executorSkips: Record<string, number>;
  riskExits: Record<string, number>;
  scouted: number;
}

/** Closed trades shipped with a recap. Counts still cover the whole window. */
export const RECAP_CLOSED_LIMIT = 50;

export interface RecapReport {
  since: number;
  until: number;
  startingEquity: number;
  endingEquity: number;
  pnlUsd: number;
  pnlPct: number;
  closedCount: number;
  closed: ClosedTrade[];
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  winRate: number | null;
  biggestWin?: ClosedTrade;
  biggestLoss?: ClosedTrade;
  open: PositionView[];
  filterKills: number;
  filterPasses: number;
  killReasons: Record<string, number>;
  analystRejects: number;
  executorSkips: Record<string, number>;
  riskExits: Record<string, number>;
  scouted: number;
  text: string;
}

/**
 * Last time the book was stamped down to its starting balance.
 * The known case is the $10,000 paper book jumping to $100.
 * A slow drift onto that number is not a reset.
 */
export function resetAtFromEquity(points: EquityPoint[], startingBalanceUsd = 100): number | null {
  let found: number | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const next = points[i]!;
    if (isBookReset(prev.equity, next.equity, startingBalanceUsd) || isBookReset(prev.cash, next.cash, startingBalanceUsd)) {
      found = next.t;
    }
  }
  return found;
}

function isBookReset(before: number, after: number, starting: number): boolean {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
  const targets = Math.abs(starting - 100) < 0.01 ? [100] : [starting, 100];
  for (const target of targets) {
    const near = Math.abs(after - target) <= Math.max(1, Math.abs(target) * 0.01);
    if (near && before >= 1_000 && before - after >= 500) return true;
  }
  return false;
}

/** Requested window, never earlier than the current book's floor. `reset` is the floor itself. */
export function resolveRecapSince(arg: string | undefined, floorTs: number, now = Date.now()): number {
  const floor = Number.isFinite(floorTs) && floorTs > 0 ? floorTs : 0;
  if (arg === "reset") return floor;
  return Math.max(parseSince(arg, now), floor);
}

/** Summary plus the last 50 closes. Win and loss lists stay as counts so the body stays small. */
export function recapReport(recap: Recap): RecapReport {
  return {
    since: recap.since,
    until: recap.until,
    startingEquity: recap.startingEquity,
    endingEquity: recap.endingEquity,
    pnlUsd: recap.pnlUsd,
    pnlPct: recap.pnlPct,
    closedCount: recap.closed.length,
    closed: recap.closed.slice(-RECAP_CLOSED_LIMIT),
    winCount: recap.wins.length,
    lossCount: recap.losses.length,
    breakevenCount: recap.breakeven.length,
    winRate: recap.winRate,
    biggestWin: recap.biggestWin,
    biggestLoss: recap.biggestLoss,
    open: recap.open,
    filterKills: recap.filterKills,
    filterPasses: recap.filterPasses,
    killReasons: recap.killReasons,
    analystRejects: recap.analystRejects,
    executorSkips: recap.executorSkips,
    riskExits: recap.riskExits,
    scouted: recap.scouted,
    text: formatRecap(recap)
  };
}

export function buildRecap(input: {
  since: number;
  until: number;
  events: Array<FeedEvent & { payload?: unknown }>;
  equity: EquityPoint[];
  closed: ClosedTrade[];
  open: PositionView[];
  startingBalanceUsd: number;
}): Recap {
  const killReasons: Record<string, number> = {};
  const executorSkips: Record<string, number> = {};
  const riskExits: Record<string, number> = {};
  let filterKills = 0;
  let filterPasses = 0;
  let analystRejects = 0;
  let scouted = 0;

  for (const event of input.events) {
    if (event.stage === "scout" && event.kind === "info") scouted += 1;
    if (event.stage === "filter" && event.kind === "reject") {
      filterKills += 1;
      const reasons = reasonsFrom(event);
      if (!reasons.length && event.code) reasons.push(event.code);
      for (const code of reasons) killReasons[code] = (killReasons[code] ?? 0) + 1;
    }
    if (event.stage === "filter" && event.kind === "pass") filterPasses += 1;
    if (event.stage === "analyst" && event.kind === "reject") analystRejects += 1;
    if (event.stage === "executor" && event.kind === "reject" && event.code) {
      executorSkips[event.code] = (executorSkips[event.code] ?? 0) + 1;
    }
    if (event.stage === "risk" && event.kind === "exit" && event.code) {
      riskExits[event.code] = (riskExits[event.code] ?? 0) + 1;
    }
  }

  const wins = input.closed.filter((t) => t.pnlUsd > 0);
  const breakeven = input.closed.filter((t) => t.pnlUsd === 0);
  const losses = input.closed.filter((t) => t.pnlUsd < 0);
  const winRate = input.closed.length ? wins.length / input.closed.length : null;
  const biggestWin = [...wins].sort((a, b) => b.pnlUsd - a.pnlUsd)[0];
  const biggestLoss = [...losses].sort((a, b) => a.pnlUsd - b.pnlUsd)[0];
  const startingEquity = input.equity[0]?.equity ?? input.startingBalanceUsd;
  const endingEquity = input.equity[input.equity.length - 1]?.equity ?? startingEquity;
  const pnlUsd = endingEquity - startingEquity;
  const pnlPct = startingEquity > 0 ? pnlUsd / startingEquity : 0;

  return {
    since: input.since,
    until: input.until,
    startingEquity,
    endingEquity,
    pnlUsd,
    pnlPct,
    closed: input.closed,
    wins,
    losses,
    breakeven,
    winRate,
    biggestWin,
    biggestLoss,
    open: input.open,
    filterKills,
    filterPasses,
    killReasons,
    analystRejects,
    executorSkips,
    riskExits,
    scouted
  };
}

function reasonsFrom(event: FeedEvent & { payload?: unknown }): string[] {
  const payload = event.payload as { reasons?: Array<{ code?: string }> } | null;
  if (!payload?.reasons) return [];
  return payload.reasons.map((r) => r.code).filter((c): c is string => Boolean(c));
}

export function formatRecap(recap: Recap): string {
  const lines: string[] = [];
  lines.push("Night Desk recap");
  lines.push(`Window: ${new Date(recap.since).toISOString()} → ${new Date(recap.until).toISOString()}`);
  lines.push(`Starting equity: ${usd(recap.startingEquity)}`);
  lines.push(`Ending equity:   ${usd(recap.endingEquity)}`);
  lines.push(`P&L:             ${signedUsd(recap.pnlUsd)} (${signedPct(recap.pnlPct)})`);
  lines.push("");
  lines.push(
    `Trades closed: ${recap.closed.length}    Wins: ${recap.wins.length}    Losses: ${recap.losses.length}` +
      (recap.breakeven.length ? `    Breakeven: ${recap.breakeven.length}` : "") +
      (recap.winRate != null ? `    Win rate: ${(recap.winRate * 100).toFixed(0)}%` : "")
  );
  lines.push(
    recap.biggestWin
      ? `Biggest win:  ${recap.biggestWin.symbol} ${signedUsd(recap.biggestWin.pnlUsd)} (${signedPct(recap.biggestWin.pnlPct)})`
      : "Biggest win:  —"
  );
  lines.push(
    recap.biggestLoss
      ? `Biggest loss: ${recap.biggestLoss.symbol} ${signedUsd(recap.biggestLoss.pnlUsd)} (${signedPct(recap.biggestLoss.pnlPct)})`
      : "Biggest loss: —"
  );
  lines.push("");
  lines.push(`Open positions: ${recap.open.length}`);
  for (const pos of recap.open) {
    lines.push(
      `  ${pos.symbol.padEnd(10)} score ${pos.score.toFixed(2)}  uPnL ${signedUsd(pos.pnlUsd)} (${signedPct(pos.pnlPct)})`
    );
  }
  lines.push("");
  const seen = recap.filterKills + recap.filterPasses;
  const survival = seen ? recap.filterPasses / seen : 0;
  lines.push(
    `Filter: ${recap.scouted} scouted, ${recap.filterPasses} passed, ${recap.filterKills} killed (${(survival * 100).toFixed(1)}% of decided names survived)`
  );
  lines.push("Kills by reason:");
  lines.push(...table(recap.killReasons));
  lines.push("");
  lines.push(`Analyst rejects: ${recap.analystRejects}`);
  lines.push("Executor skips:");
  lines.push(...table(recap.executorSkips));
  lines.push("Risk exits:");
  lines.push(...table(recap.riskExits));
  const recent = recap.closed.slice(-RECAP_CLOSED_LIMIT);
  if (recent.length) {
    lines.push("");
    lines.push(
      recap.closed.length > recent.length
        ? `Recent closes: last ${recent.length} of ${recap.closed.length}`
        : "Recent closes:"
    );
    for (const trade of recent.slice().reverse()) {
      lines.push(`  ${trade.symbol.padEnd(10)} ${signedUsd(trade.pnlUsd)}  ${trade.exitCode}`);
    }
  }
  return lines.join("\n");
}

function table(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return ["  —"];
  return entries.map(([code, n]) => `  ${code.padEnd(24)} ${n}`);
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedUsd(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${Math.abs(n * 100).toFixed(2)}%`;
}

export function parseSince(arg: string | undefined, now = Date.now()): number {
  if (!arg || arg === "all") return 0;
  const match = /^(\d+)(m|h|d)$/.exec(arg);
  if (!match) return now - 12 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = match[2];
  const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
  return now - ms;
}
