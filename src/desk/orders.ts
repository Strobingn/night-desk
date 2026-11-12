import { pctText } from "../rules.js";
/**
 * v13.11 limit and stop orders on the paper and live books.
 *
 *  - Limit buy:   buy when the price is at or below a target.
 *  - Take profit: sell when the price is at or above a target (paper 25/50/100%, live 100%).
 *  - Stop sell:   sell when the price falls to a level. The −hard stop stays the floor:
 *                 a custom stop can only sit tighter (above it), never looser.
 *
 * The trigger is entered as a price, a market cap, a % from the current price or a % from entry,
 * and is turned into one trigger price when the order is placed. A trigger only fires on a
 * real, fresh price (never 0, never stale) and runs through the desk's normal buy / sell path,
 * so every fail-closed gate still applies. A refusal keeps the order open with the reason and
 * retries; after a few refusals (or a hard kill) it is marked failed. Nothing fills silently.
 */
import { randomUUID } from "node:crypto";

export type OrderBook = "paper" | "live";
export type OrderSide = "limit_buy" | "take_profit" | "stop_sell";
export type OrderBasis = "price" | "mcap" | "pct_now" | "pct_entry";
export type OrderStatus = "open" | "working" | "filled" | "failed" | "canceled";

export interface DeskOrder {
  id: string;
  book: OrderBook;
  side: OrderSide;
  mint: string;
  symbol: string;
  basis: OrderBasis;
  /** What was typed: a price, a market cap in $, or a percent (e.g. −10 or 50). */
  input: number;
  /** The trigger, always a USD price above 0. */
  triggerPrice: number;
  /** The price the % (or market cap) was converted from. */
  refPrice: number;
  /** Market cap at the trigger, when the coin's supply is known. */
  triggerMcapUsd?: number;
  /** Sells: share of the position (paper 0.25 / 0.5 / 1, live 1). */
  fraction?: number;
  /** Limit buys: dollars to spend (paper: the one-tap size; live: capped at the live size). */
  sizeUsd?: number;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
  /** Last refusal / why it is waiting / how it ended, in plain words. */
  note?: string;
  tries: number;
  nextTryAt?: number;
  firedAt?: number;
  fillPrice?: number;
  /** Mark that fired it. */
  firedMark?: number;
}

export interface OrderInput {
  book?: unknown;
  side?: unknown;
  mint?: unknown;
  basis?: unknown;
  value?: unknown;
  fraction?: unknown;
  percent?: unknown;
  sizeUsd?: unknown;
}

export interface OrderContext {
  symbol: string;
  /** Fresh current price, or null when there is none. */
  mark: number | null;
  /** Held position in that book (sells only). */
  held: boolean;
  entryPrice: number | null;
  /** Hard stop price of the held position (entry × (1 − stop)). */
  hardStopPrice: number | null;
  hardStopPct: number;
  /** Market cap ÷ price (token supply), when known. */
  supply: number | null;
  /** Live book: true when the desk is armed. Only used for wording. */
  liveArmed: boolean;
}

export const ORDER_MAX_OPEN = 40;
export const ORDER_MAX_TRIES = 3;
export const ORDER_RETRY_MS = 30_000;
/** A price older than this never fires an order. */
export const ORDER_MARK_MAX_AGE_MS = 30_000;
export const ORDER_KEEP_DONE = 30;

export const SIDE_LABEL: Record<OrderSide, string> = { limit_buy: "Limit buy", take_profit: "Take profit", stop_sell: "Stop" };

const SIDES = new Set<OrderSide>(["limit_buy", "take_profit", "stop_sell"]);
const BASES = new Set<OrderBasis>(["price", "mcap", "pct_now", "pct_entry"]);

function px(n: number): string {
  if (!(n > 0) || !Number.isFinite(n)) return "—";
  if (n >= 1) return `$${n.toFixed(n >= 1000 ? 0 : 4)}`;
  return `$${Number(n.toPrecision(4))}`;
}

export function parseOrderNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw.replace(/[,$%\s]/g, ""));
  return NaN;
}

/** Turns a ticket into an order, or a plain refusal. Pure: the desk supplies the prices. */
export function resolveOrder(
  input: OrderInput,
  ctx: OrderContext,
  now = Date.now()
): { ok: true; order: DeskOrder } | { ok: false; error: string } {
  const side = input.side as OrderSide;
  if (!SIDES.has(side)) return { ok: false, error: "Order type must be limit_buy, take_profit or stop_sell." };
  const basis = (input.basis ?? "price") as OrderBasis;
  if (!BASES.has(basis)) return { ok: false, error: "Trigger must be a price, a market cap, a % from now or a % from entry." };
  const book: OrderBook = input.book === "live" ? "live" : "paper";
  const mint = typeof input.mint === "string" ? input.mint.trim() : "";
  if (!mint) return { ok: false, error: "Mint is required." };
  const value = parseOrderNumber(input.value);
  if (!Number.isFinite(value)) return { ok: false, error: "Enter a number for the trigger." };
  const sell = side !== "limit_buy";
  const where = book === "live" ? "live" : "paper";
  if (sell && !ctx.held) {
    return { ok: false, error: `No open ${where} position in ${ctx.symbol}. Stops and take-profits sit on a coin you hold in that book.` };
  }
  const mark = ctx.mark != null && ctx.mark > 0 && Number.isFinite(ctx.mark) ? ctx.mark : null;
  if (mark == null) return { ok: false, error: `No fresh price for ${ctx.symbol} right now, so the order can't be checked. Try again in a few seconds.` };
  let trigger: number;
  let ref = mark;
  switch (basis) {
    case "price":
      if (!(value > 0)) return { ok: false, error: "A trigger price has to be above 0." };
      trigger = value;
      break;
    case "mcap":
      if (!(value > 0)) return { ok: false, error: "A market cap has to be above $0." };
      if (!(ctx.supply != null && ctx.supply > 0 && Number.isFinite(ctx.supply))) {
        return { ok: false, error: `No market cap known for ${ctx.symbol}. Enter a price or a % instead.` };
      }
      trigger = value / ctx.supply;
      break;
    case "pct_now":
      if (!(value > -100)) return { ok: false, error: "A % from now has to be above −100%." };
      trigger = mark * (1 + value / 100);
      break;
    case "pct_entry":
      if (!(ctx.entryPrice != null && ctx.entryPrice > 0)) return { ok: false, error: "% from entry needs an open position. Use % from now or a price." };
      if (!(value > -100)) return { ok: false, error: "A % from entry has to be above −100%." };
      ref = ctx.entryPrice;
      trigger = ctx.entryPrice * (1 + value / 100);
      break;
  }
  if (!(trigger > 0) || !Number.isFinite(trigger)) return { ok: false, error: "That trigger works out to no real price. Order refused." };
  if (side === "limit_buy" && !(trigger < mark)) {
    return { ok: false, error: `${ctx.symbol} is already at ${px(mark)}, at or below ${px(trigger)}. Use Buy now, or set a lower limit.` };
  }
  if (side === "take_profit" && !(trigger > mark)) {
    return { ok: false, error: `${ctx.symbol} is already at ${px(mark)}, at or above ${px(trigger)}. Use Sell now, or set a higher target.` };
  }
  if (side === "stop_sell") {
    if (!(trigger < mark)) return { ok: false, error: `${ctx.symbol} is at ${px(mark)}, already at or below ${px(trigger)}. Use Sell now, or set a lower stop.` };
    const floor = ctx.hardStopPrice;
    if (floor != null && floor > 0 && trigger < floor * (1 - 1e-9)) {
      return {
        ok: false,
        error: `Your −${pctText(ctx.hardStopPct)} hard stop at ${px(floor)} sells first. A custom stop can only be tighter: set it above ${px(floor)}.`
      };
    }
  }
  let fraction: number | undefined;
  if (sell) {
    const rawPct = input.percent != null ? parseOrderNumber(input.percent) / 100 : input.fraction != null ? parseOrderNumber(input.fraction) : 1;
    const f = Math.round(rawPct * 100) / 100;
    if (![0.25, 0.5, 1].includes(f)) return { ok: false, error: "Sell amount must be 25%, 50% or 100%." };
    if (book === "live" && f !== 1) return { ok: false, error: "Live sells close 100% (partial live sells are not supported)." };
    fraction = f;
  }
  let sizeUsd: number | undefined;
  if (!sell && input.sizeUsd != null && input.sizeUsd !== "") {
    const s = parseOrderNumber(input.sizeUsd);
    if (!(s > 0) || !Number.isFinite(s)) return { ok: false, error: "Buy size has to be above $0." };
    sizeUsd = Math.round(s * 100) / 100;
  }
  const order: DeskOrder = {
    id: randomUUID(),
    book,
    side,
    mint,
    symbol: ctx.symbol,
    basis,
    input: value,
    triggerPrice: trigger,
    refPrice: ref,
    ...(ctx.supply != null && ctx.supply > 0 ? { triggerMcapUsd: Math.round(trigger * ctx.supply) } : {}),
    ...(fraction != null ? { fraction } : {}),
    ...(sizeUsd != null ? { sizeUsd } : {}),
    status: "open",
    createdAt: now,
    updatedAt: now,
    tries: 0,
    ...(book === "live" && !ctx.liveArmed ? { note: "waiting: live not armed" } : {})
  };
  return { ok: true, order };
}

/** True when a real price crosses the order's trigger. Never on 0 or junk. */
export function crosses(order: Pick<DeskOrder, "side" | "triggerPrice">, mark: number): boolean {
  if (!(mark > 0) || !Number.isFinite(mark)) return false;
  return order.side === "take_profit" ? mark >= order.triggerPrice : mark <= order.triggerPrice;
}

/** Distance from the mark to the trigger, as a fraction of the mark (+ = price must rise). */
export function distance(order: Pick<DeskOrder, "triggerPrice">, mark: number | null): number | null {
  if (mark == null || !(mark > 0)) return null;
  return order.triggerPrice / mark - 1;
}

/** Plain words for one order, for the log and the lists. */
export function describeOrder(o: DeskOrder): string {
  const what = SIDE_LABEL[o.side];
  const amt = o.side === "limit_buy" ? (o.sizeUsd ? ` $${o.sizeUsd}` : "") : ` ${Math.round((o.fraction ?? 1) * 100)}%`;
  const basis =
    o.basis === "pct_now" ? ` (${o.input > 0 ? "+" : ""}${o.input}% from ${px(o.refPrice)})` : o.basis === "pct_entry" ? ` (${o.input > 0 ? "+" : ""}${o.input}% from entry ${px(o.refPrice)})` : o.basis === "mcap" ? ` (mcap $${Math.round(o.input).toLocaleString("en-US")})` : "";
  return `${o.book === "live" ? "LIVE " : ""}${what}${amt} ${o.symbol} at ${px(o.triggerPrice)}${basis}`;
}

/** Refusals that will not get better by waiting. */
export const PERMANENT_REFUSALS = new Set(["HARD_KILL", "LIVE_DAILY_CAP", "SIZE_TOO_SMALL"]);

/** The open orders and the last few finished ones. Plain data, saved through the desk store. */
export class OrderList {
  private rows: DeskOrder[] = [];

  constructor(saved?: unknown) {
    if (Array.isArray(saved)) {
      for (const raw of saved) {
        const o = raw as DeskOrder;
        if (!o || typeof o !== "object" || typeof o.id !== "string" || !SIDES.has(o.side) || !(o.triggerPrice > 0) || typeof o.mint !== "string") continue;
        // An order mid-fire when the desk stopped goes back to open: the book says whether it filled.
        this.rows.push({ ...o, status: o.status === "working" ? "open" : o.status, book: o.book === "live" ? "live" : "paper" });
      }
    }
  }

  all(): DeskOrder[] {
    return this.rows;
  }

  open(): DeskOrder[] {
    return this.rows.filter((o) => o.status === "open" || o.status === "working");
  }

  get(id: string): DeskOrder | undefined {
    return this.rows.find((o) => o.id === id);
  }

  add(order: DeskOrder): { ok: true } | { ok: false; error: string } {
    if (this.open().length >= ORDER_MAX_OPEN) return { ok: false, error: `Already ${ORDER_MAX_OPEN} open orders. Cancel one first.` };
    this.rows.push(order);
    return { ok: true };
  }

  finish(o: DeskOrder, status: "filled" | "failed" | "canceled", note: string, now = Date.now()): void {
    o.status = status;
    o.note = note;
    o.updatedAt = now;
    delete o.nextTryAt;
    this.trim();
  }

  private trim(): void {
    const done = this.rows.filter((o) => o.status !== "open" && o.status !== "working").sort((a, b) => b.updatedAt - a.updatedAt);
    const drop = new Set(done.slice(ORDER_KEEP_DONE).map((o) => o.id));
    if (drop.size) this.rows = this.rows.filter((o) => !drop.has(o.id));
  }

  toJSON(): DeskOrder[] {
    return this.rows.map((o) => ({ ...o }));
  }
}
