/** v13.3 one-tap helpers shared by the web screens (pure, unit-tested). */
import { px, signedPct, signedUsd, usd } from "./format";
import type { DeskSnapshot } from "./types";

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

/**
 * v13.5: on a LIVE desk every one-tap buy is the live per-trade size (default $5), never the
 * phone's paper one-tap amount. The desk enforces the same cut; this keeps the button honest.
 */
export function effectiveTapUsd(mode: string | undefined, tapUsd: number, liveTradeUsd: number | null | undefined): number {
  if (mode !== "live") return tapUsd;
  const live = liveTradeUsd != null && liveTradeUsd > 0 ? liveTradeUsd : 5;
  return live;
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

/** Hard-kill refusals keep the desk's reason and open the existing Buy anyway confirm. */
export function hardKillFollowUp(code: string | undefined, error: string | undefined): { reason: string } | null {
  if (code !== "HARD_KILL") return null;
  const reason = error?.trim() ? error.trim() : "Hard kill.";
  return { reason };
}

export function buyToast(symbol: string, r: BuyReply, roundTripMs: number): string {
  if (!r.ok) {
    const hint = r.code === "HARD_KILL" || r.code === "REVENGE_COOLDOWN" ? " Use Buy… on the card to override." : "";
    return `${symbol}: ${r.error ?? "buy refused"}${r.code ? ` (${r.code})` : ""}${hint}`;
  }
  const clamp = r.clampedFrom != null ? ` (cut from ${usd(r.clampedFrom)} to the cap)` : "";
  const fill = r.fillPriceUsd ? ` @ ${px(r.fillPriceUsd)}` : "";
  const mode = r.mode === "live" ? "LIVE" : r.mode ?? "paper";
  return `Bought ${r.symbol ?? symbol} ${usd(r.sizeUsd ?? 0)}${fill}${clamp} · ${mode} · ${roundTripMs} ms`;
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
  code?: string;
  ms?: number;
}

export function sellToast(symbol: string, r: SellReply, roundTripMs: number): string {
  if (!r.ok) return `${symbol}: ${r.error ?? "sell failed"}${r.code ? ` (${r.code})` : ""}`;
  const pnl = r.pnlUsd != null ? ` ${signedUsd(r.pnlUsd)}${r.pnlPct != null ? ` (${signedPct(r.pnlPct)})` : ""}` : "";
  const fill = r.exitPrice ? ` @ ${px(r.exitPrice)}` : "";
  const gap = r.exitCode === "GAP_RUG" ? " · gap/rug" : "";
  return `Sold ${r.symbol ?? symbol}${r.proceedsUsd != null ? ` for ${usd(r.proceedsUsd)}` : ""}${fill}${pnl}${gap} · ${roundTripMs} ms`;
}

/** v13.9 the live one-tap size: the live book's trade size, else Dirk's saved liveTradeUsd, else $5. */
export function liveTapUsd(snap: Pick<DeskSnapshot, "liveBook" | "prefs"> | null | undefined): number {
  const n = snap?.liveBook?.tradeUsd ?? snap?.prefs?.liveTradeUsd;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 5;
}

/** v13.9 why a LIVE tap does nothing. Null = live book armed, send it. Never a paper fallback. */
export function liveTapBlock(snap: Pick<DeskSnapshot, "liveBook" | "liveNotArmed" | "wallet"> | null | undefined): string | null {
  if (!snap) return "Desk not loaded yet. Nothing was sent.";
  if (snap.liveBook) return null;
  const why = snap.liveNotArmed ?? (snap.wallet && !snap.wallet.keyLoaded ? "Live not armed: wallet key missing." : "Live not armed.");
  return `${why} Nothing was sent.`;
}

/** v13.9 the live position in a coin (live book), if any. */
export function liveHolding(snap: Pick<DeskSnapshot, "liveBook">, mint: string) {
  return snap.liveBook?.positions.find((pos) => pos.mint === mint) ?? null;
}
