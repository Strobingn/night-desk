import { loadConfig } from "../config.js";
import { buildRecap, formatRecap, resetAtFromEquity, resolveRecapSince } from "../desk/recap.js";
import { DeskStore } from "../store/db.js";

const config = loadConfig();
const eq = process.argv.find((part) => part.startsWith("--since="));
const sinceFlag = process.argv.indexOf("--since");
const arg = eq ? eq.slice("--since=".length) : sinceFlag >= 0 ? process.argv[sinceFlag + 1] : undefined;
const until = Date.now();
const store = new DeskStore(config.dbPath, ":memory:");
const book = store.loadBook();
const savedFloor = store.readJson("resetAt");
const storedFloor = typeof savedFloor === "number" && Number.isFinite(savedFloor) ? savedFloor : null;
const jump =
  storedFloor == null
    ? resetAtFromEquity(store.equitySince(0), book?.startingBalanceUsd ?? config.startingBalanceUsd)
    : null;
let floor = storedFloor ?? jump ?? book?.startedAt ?? 0;
if ((book?.startedAt ?? 0) > floor) floor = book?.startedAt ?? floor;
if (storedFloor !== floor) store.writeJson("resetAt", floor);
const since = resolveRecapSince(arg, floor);
const events = store.eventsSince(since);
const equity = store.equitySince(since);
const closed = store.closedSince(since);
const marks = new Map(book?.lastPrices ?? []);
const open = (book?.positions ?? []).map((pos) => {
  const markPrice = marks.get(pos.mint) ?? pos.entryPrice;
  const marketValueUsd = pos.qty * markPrice;
  const pnlUsd = marketValueUsd - pos.costUsd;
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
    peakPrice: pos.peakPrice,
    trailArmed: pos.trailArmed,
    stopPrice: pos.entryPrice * (1 - config.rules.stopLossPct),
    trailHintPrice:
      pos.trailArmed && pos.peakPrice > 0 ? pos.peakPrice * (1 - config.rules.trailGapPct) : null,
    score: pos.score,
    source: pos.source,
    entry: pos.entry,
    lpUnlocked: pos.lpUnlocked === true,
    markAgeMs: 0,
    openedAt: pos.openedAt
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
