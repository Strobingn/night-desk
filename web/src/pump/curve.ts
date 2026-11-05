/**
 * Client curve helpers. Reverse quotes call the core `solToReachMarketCap`
 * so a target-mcap pre-fill matches the server quote.
 */
import { reservesOf, solToReachMarketCap } from "../../../src/pump/curve";
import type { CurveState, ReverseQuote, TradeEvent } from "../../../src/pump/types";

export const STALE_AFTER_MS = 5_000;
const LAMPORTS = 1_000_000_000n;

export function prefillForTarget(curve: CurveState, targetMarketCapLamports: bigint): ReverseQuote {
  return solToReachMarketCap(reservesOf(curve), targetMarketCapLamports);
}

export function solToLamports(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole) * LAMPORTS + BigInt(frac.padEnd(9, "0"));
}

export function formatSol(lamports: string | bigint): string {
  const n = typeof lamports === "bigint" ? lamports : BigInt(lamports);
  const neg = n < 0n;
  const v = neg ? -n : n;
  const whole = v / LAMPORTS;
  const frac = (v % LAMPORTS).toString().padStart(9, "0").replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${text}` : text;
}

export function isFeedStale(lastTickAt: number | null, now: number, windowMs = STALE_AFTER_MS): boolean {
  if (lastTickAt == null) return false;
  return now - lastTickAt >= windowMs;
}

export interface TapePrint {
  id: string;
  at: number;
  isBuy: boolean;
  solAmountLamports: string;
  user: string;
}

export interface ChartPoint {
  t: number;
  marketCapLamports: string;
}

export interface FeedState {
  curve: CurveState | null;
  ticks: ChartPoint[];
  tape: TapePrint[];
  lastTickAt: number | null;
}

export const EMPTY_FEED: FeedState = { curve: null, ticks: [], tape: [], lastTickAt: null };

const MAX_TICKS = 240;
const MAX_TAPE = 40;

function isCurve(data: unknown): data is CurveState {
  if (!data || typeof data !== "object") return false;
  const row = data as Partial<CurveState>;
  return typeof row.marketCapLamports === "string" && typeof row.virtualTokenReserves === "string" && typeof row.progressPct === "number" && !("isBuy" in row);
}

function isTrade(data: unknown): data is TradeEvent {
  if (!data || typeof data !== "object") return false;
  const row = data as Partial<TradeEvent>;
  return typeof row.isBuy === "boolean" && typeof row.solAmountLamports === "string" && typeof row.mint === "string";
}

function pushTick(ticks: ChartPoint[], point: ChartPoint): ChartPoint[] {
  const next = ticks.length > 0 && ticks[ticks.length - 1]?.t === point.t ? ticks.slice(0, -1) : ticks.slice();
  next.push(point);
  return next.length > MAX_TICKS ? next.slice(next.length - MAX_TICKS) : next;
}

/** Applies one `/ws` pump frame or a polled curve/trade. `now` is the receive time. */
export function reducePumpFrame(state: FeedState, data: unknown, now: number): FeedState {
  if (isCurve(data)) {
    return {
      curve: data,
      ticks: pushTick(state.ticks, { t: now, marketCapLamports: data.marketCapLamports }),
      tape: state.tape,
      lastTickAt: now
    };
  }
  if (!isTrade(data)) return state;
  const id = data.signature || `${data.timestamp}:${data.user}:${data.solAmountLamports}:${data.isBuy ? "b" : "s"}`;
  const tape = state.tape.some((row) => row.id === id)
    ? state.tape
    : [{ id, at: data.timestamp || now, isBuy: data.isBuy, solAmountLamports: data.solAmountLamports, user: data.user }, ...state.tape].slice(0, MAX_TAPE);
  let ticks = state.ticks;
  const supply = state.curve?.tokenTotalSupply;
  if (supply && data.virtualTokenReserves && data.virtualQuoteReserves) {
    try {
      const token = BigInt(data.virtualTokenReserves);
      if (token > 0n) {
        const mcap = (BigInt(data.virtualQuoteReserves) * BigInt(supply)) / token;
        ticks = pushTick(ticks, { t: data.timestamp || now, marketCapLamports: mcap.toString() });
      }
    } catch {
      /* ignore a bad reserve string */
    }
  }
  return { curve: state.curve, ticks, tape, lastTickAt: now };
}
