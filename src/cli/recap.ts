import { realizablePnl } from "../agents/execution-math.js";
import { loadConfig } from "../config.js";
import { buildRecap, formatRecap, parseSince } from "../desk/recap.js";
import { DeskStore } from "../store/db.js";

const config = loadConfig();
const eq = process.argv.find((part) => part.startsWith("--since="));
const sinceFlag = process.argv.indexOf("--since");
const arg = eq ? eq.slice("--since=".length) : sinceFlag >= 0 ? process.argv[sinceFlag + 1] : undefined;
const since = parseSince(arg);
const until = Date.now();
const store = new DeskStore(config.dbPath, ":memory:");
const book = store.loadBook();
const events = store.eventsSince(since);
const equity = store.equitySince(since);
const closed = store.closedSince(since);
const marks = new Map(book?.lastPrices ?? []);
const seriesByMint = new Map(book?.markSeries ?? []);
const open = (book?.positions ?? []).map((pos) => {
  const markPrice = marks.get(pos.mint) ?? pos.entryPrice;
  const marketValueUsd = pos.qty * markPrice;
  const pnlUsd = marketValueUsd - pos.costUsd;
  const points = (seriesByMint.get(pos.mint) ?? []).filter(
    (point) => point != null && point.priceUsd > 0 && Number.isFinite(point.t)
  );
  const last = points[points.length - 1];
  const net = realizablePnl({
    markPrice,
    qty: pos.qty,
    costUsd: pos.costUsd,
    liquidityUsd: pos.liquidityUsd,
    markAt: last?.t ?? null,
    now: until
  });
  const markStale = last != null && net == null;
  return {
    mint: pos.mint,
    symbol: pos.symbol,
    name: pos.name,
    qty: pos.qty,
    entryPrice: pos.entryPrice,
    markPrice,
    costUsd: pos.costUsd,
    marketValueUsd,
    pnlUsd,
    pnlPct: pos.entryPrice > 0 ? (markPrice - pos.entryPrice) / pos.entryPrice : 0,
    netPnlUsd: net?.netPnlUsd ?? null,
    netPnlPct: net?.netPnlPct ?? null,
    exitSlippage: net?.exitSlippage ?? null,
    entrySlippage:
      typeof pos.entrySlippage === "number" && Number.isFinite(pos.entrySlippage) ? pos.entrySlippage : null,
    markStale,
    marks: points,
    peakPrice: pos.peakPrice,
    trailArmed: pos.trailArmed,
    stopPrice: pos.entryPrice * (1 - config.rules.stopLossPct),
    trailHintPrice:
      pos.trailArmed && pos.peakPrice > 0 ? pos.peakPrice * (1 - config.rules.trailGapPct) : null,
    score: pos.score,
    source: pos.source,
    openedAt: pos.openedAt,
    freezeAuthorityRevoked: pos.freezeAuthorityRevoked ?? null,
    holderEntropy: pos.holderEntropy ?? null,
    top10HolderPct: pos.top10HolderPct ?? null
  };
});
const recap = buildRecap({
  since,
  until,
  events,
  equity,
  closed,
  open,
  startingBalanceUsd: book?.startingBalanceUsd ?? config.startingBalanceUsd
});
console.log(formatRecap(recap));
store.close();
