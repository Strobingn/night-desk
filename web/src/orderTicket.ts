/** v13.11 order ticket helpers (pure; shared by the web UI and its tests). */
import type { DeskSnapshot } from "./types";

export type TicketSide = "limit_buy" | "take_profit" | "stop_sell";
export type TicketBasis = "price" | "mcap" | "pct_now" | "pct_entry";
export type DeskOrderView = NonNullable<DeskSnapshot["orders"]>[number];

export const BASIS_LABEL: Record<TicketBasis, string> = { pct_entry: "% entry", pct_now: "% now", price: "Price", mcap: "MCap" };
export const SIDE_SHORT: Record<TicketSide, string> = { limit_buy: "Limit buy", take_profit: "Take profit", stop_sell: "Stop" };

/** Bases a ticket offers: % from entry only on a held coin. */
export function basesFor(side: TicketSide): TicketBasis[] {
  return side === "limit_buy" ? ["pct_now", "price", "mcap"] : ["pct_entry", "pct_now", "price", "mcap"];
}

/** Default number in the box for a fresh ticket. */
export function defaultValue(side: TicketSide, basis: TicketBasis): string {
  if (basis === "price" || basis === "mcap") return "";
  return side === "limit_buy" ? "-10" : side === "take_profit" ? "50" : "-2";
}

/** Client-side preview of the trigger price. Null when the desk has to work it out (market cap) or it is not a real price. */
export function previewTrigger(basis: TicketBasis, value: number, ctx: { mark: number | null; entry: number | null }): number | null {
  if (!Number.isFinite(value)) return null;
  let p: number | null = null;
  if (basis === "price") p = value;
  else if (basis === "pct_now" && ctx.mark != null && ctx.mark > 0) p = ctx.mark * (1 + value / 100);
  else if (basis === "pct_entry" && ctx.entry != null && ctx.entry > 0) p = ctx.entry * (1 + value / 100);
  return p != null && p > 0 && Number.isFinite(p) ? p : null;
}

/** Short status for an order row. */
export function orderStatusText(o: Pick<DeskOrderView, "status" | "waiting" | "note" | "distancePct">): string {
  if (o.status === "open") {
    if (o.waiting) return o.waiting;
    if (o.note?.startsWith("Refused")) return o.note;
    return o.distancePct != null ? `${o.distancePct > 0 ? "+" : ""}${(o.distancePct * 100).toFixed(1)}% away` : "watching";
  }
  if (o.status === "working") return "firing…";
  return o.note ?? o.status;
}

/** Open orders on one coin and book. */
export function ordersFor(snap: DeskSnapshot | undefined, mint: string, book?: "paper" | "live"): DeskOrderView[] {
  return (snap?.orders ?? []).filter((o) => o.mint === mint && (book == null || o.book === book) && (o.status === "open" || o.status === "working"));
}
