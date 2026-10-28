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
