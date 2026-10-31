/** v13.3 one-tap helpers shared by the web screens (pure, unit-tested). */
import { px, signedPct, signedUsd, usd } from "./format";

export const TAP_SIZE_KEY = "night-desk-tap-usd";

export function newIdemKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `tap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The one-tap size: the saved device choice, else the desk's manual default, else the cap. */
export function defaultTapUsd(saved: number | null, defaultBuyUsd: number | null | undefined, capUsd: number): number {
  if (saved != null && Number.isFinite(saved) && saved > 0) return saved;
  if (defaultBuyUsd != null && defaultBuyUsd > 0) return defaultBuyUsd;
  return Math.max(1, Math.floor(capUsd * 100) / 100);
}

export interface BuyReply {
  ok?: boolean;
  symbol?: string;
  sizeUsd?: number;
  fillPriceUsd?: number;
  clampedFrom?: number;
  mode?: string;
  error?: string;
  code?: string;
  ms?: number;
  replayed?: boolean;
}

export function buyToast(symbol: string, r: BuyReply, roundTripMs: number): string {
  if (!r.ok) return `${symbol}: ${r.error ?? "buy refused"}${r.code ? ` (${r.code})` : ""}`;
  const clamp = r.clampedFrom != null ? ` (cut from ${usd(r.clampedFrom)} to the cap)` : "";
  const fill = r.fillPriceUsd ? ` @ ${px(r.fillPriceUsd)}` : "";
  return `Bought ${r.symbol ?? symbol} ${usd(r.sizeUsd ?? 0)}${fill}${clamp} · ${r.mode ?? "paper"} · ${roundTripMs} ms`;
}

export interface SellReply {
  ok?: boolean;
  symbol?: string;
  proceedsUsd?: number;
  pnlUsd?: number;
  pnlPct?: number;
  exitPrice?: number;
  exitCode?: string;
  error?: string;
  ms?: number;
}

export function sellToast(symbol: string, r: SellReply, roundTripMs: number): string {
  if (!r.ok) return `${symbol}: ${r.error ?? "sell failed"}`;
  const pnl = r.pnlUsd != null ? ` ${signedUsd(r.pnlUsd)}${r.pnlPct != null ? ` (${signedPct(r.pnlPct)})` : ""}` : "";
  const fill = r.exitPrice ? ` @ ${px(r.exitPrice)}` : "";
  const gap = r.exitCode === "GAP_RUG" ? " · gap/rug" : "";
  return `Sold ${r.symbol ?? symbol}${r.proceedsUsd != null ? ` for ${usd(r.proceedsUsd)}` : ""}${fill}${pnl}${gap} · ${roundTripMs} ms`;
}
