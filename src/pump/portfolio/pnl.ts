/**
 * Average-cost PnL over journal fills.
 *
 * Buy fees are part of the lot cost. Sell fees reduce proceeds.
 * Realized on a fully covered sell = quote received − sell fee − FIFO cost of the tokens sold.
 * A sell the imported buys do not cover has realized PnL null and a reason. It is not 0.
 * Unrealized = mark × tokens still held − remaining cost, and only when the basis and the mark are both known.
 */
import type { JournalEntry, JournalRow } from "../journal/journal.js";
import { deriveRows } from "../journal/journal.js";
import type { RawAmount } from "../types.js";

export interface PositionMark {
  mint: string;
  /** Quote lamports per one raw token. */
  priceLamportsPerToken: string;
  marketCapLamports?: RawAmount;
  progressPct?: number;
  venue?: "curve" | "pumpswap";
}

export interface PositionView {
  wallet: string;
  mint: string;
  symbol?: string;
  venues: Array<"curve" | "pumpswap">;
  sources: Array<"desk" | "chain">;
  /** Positive when the wallet still holds tokens. Negative when sells exceed imported buys. */
  tokenAmount: RawAmount;
  avgEntryLamportsPerToken: string | null;
  costLamports: RawAmount | null;
  costBasis: "known" | "unknown";
  costBasisReason?: string;
  realizedPnlLamports: RawAmount | null;
  realizedReason?: string;
  unrealizedPnlLamports: RawAmount | null;
  unrealizedReason?: string;
  marketCapLamports: RawAmount | null;
  progressPct: number | null;
  /** Where the remaining size sits. Flat when the token amount is zero and the basis is known. */
  curvePosition: "bonding_curve" | "pumpswap" | "flat" | "unknown";
}

export interface PnlTotals {
  wallets: string[];
  positions: number;
  realizedPnlLamports: RawAmount | null;
  realizedReason?: string;
  unrealizedPnlLamports: RawAmount | null;
  unrealizedReason?: string;
}

const NO_MARK = "No curve or PumpSwap mark for this mint, so unrealized PnL is withheld.";

export function positionsOf(entries: readonly JournalEntry[], marks: readonly PositionMark[] = []): PositionView[] {
  const rows = deriveRows(entries);
  const groups = new Map<string, JournalRow[]>();
  for (const row of rows) {
    const key = `${row.wallet}\u0000${row.mint}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const markByMint = new Map(marks.map((mark) => [mark.mint, mark]));
  const views: PositionView[] = [];
  for (const list of groups.values()) {
    views.push(positionFrom(list, markByMint.get(list[0]!.mint)));
  }
  views.sort((a, b) => (a.wallet === b.wallet ? a.mint.localeCompare(b.mint) : a.wallet.localeCompare(b.wallet)));
  return views;
}

function positionFrom(rows: JournalRow[], mark: PositionMark | undefined): PositionView {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  let tokens = 0n;
  let cost = 0n;
  let realized = 0n;
  let unknown = false;
  let reason: string | undefined;
  for (const row of rows) {
    const size = BigInt(row.tokenAmount);
    if (row.side === "buy") {
      tokens += size;
      cost += BigInt(row.solLamports) + BigInt(row.feeLamports);
    } else {
      tokens -= size;
      if (row.outcome === "unknown_basis" || row.realizedPnlLamports == null) {
        unknown = true;
        reason = row.costBasisReason ?? "Cost basis is unknown, so PnL is withheld.";
      } else {
        const pnl = BigInt(row.realizedPnlLamports);
        realized += pnl;
        const proceeds = BigInt(row.solLamports) - BigInt(row.feeLamports);
        const soldCost = proceeds - pnl;
        cost -= soldCost;
      }
    }
  }
  const venues = unique(rows.map((row) => row.venue));
  const sources = unique(rows.map((row) => row.source));
  const symbol = [...rows].reverse().find((row) => row.symbol)?.symbol;
  if (unknown) {
    return {
      wallet: first.wallet,
      mint: first.mint,
      symbol,
      venues,
      sources,
      tokenAmount: tokens.toString(),
      avgEntryLamportsPerToken: null,
      costLamports: null,
      costBasis: "unknown",
      costBasisReason: reason,
      realizedPnlLamports: null,
      realizedReason: reason,
      unrealizedPnlLamports: null,
      unrealizedReason: reason,
      marketCapLamports: mark?.marketCapLamports ?? last.marketCapLamports,
      progressPct: mark?.progressPct ?? null,
      curvePosition: "unknown"
    };
  }
  if (cost < 0n) cost = 0n;
  const avg = tokens > 0n ? divDecimal(cost, tokens) : null;
  let unrealized: string | null = "0";
  let unrealizedReason: string | undefined;
  if (tokens > 0n) {
    if (!mark) {
      unrealized = null;
      unrealizedReason = NO_MARK;
    } else {
      unrealized = (markValue(tokens, mark.priceLamportsPerToken) - cost).toString();
    }
  } else if (tokens < 0n) {
    unrealized = null;
    unrealizedReason = reason ?? "Token balance is short versus the imported fills.";
  }
  const venueNow = mark?.venue ?? last.venue;
  const curvePosition = tokens === 0n ? "flat" : venueNow === "pumpswap" ? "pumpswap" : "bonding_curve";
  return {
    wallet: first.wallet,
    mint: first.mint,
    symbol,
    venues,
    sources,
    tokenAmount: tokens.toString(),
    avgEntryLamportsPerToken: avg,
    costLamports: tokens > 0n ? cost.toString() : "0",
    costBasis: "known",
    realizedPnlLamports: realized.toString(),
    unrealizedPnlLamports: unrealized,
    unrealizedReason,
    marketCapLamports: mark?.marketCapLamports ?? (tokens > 0n ? last.marketCapLamports : null),
    progressPct: curvePosition === "bonding_curve" ? (mark?.progressPct ?? null) : null,
    curvePosition
  };
}

export function aggregatePnl(positions: readonly PositionView[]): PnlTotals {
  const wallets = unique(positions.map((position) => position.wallet));
  return {
    wallets,
    positions: positions.length,
    realizedPnlLamports: sumField(positions, "realizedPnlLamports", "realizedReason"),
    realizedReason: reasonOf(positions, "realizedPnlLamports", "realizedReason"),
    unrealizedPnlLamports: sumField(positions, "unrealizedPnlLamports", "unrealizedReason"),
    unrealizedReason: reasonOf(positions, "unrealizedPnlLamports", "unrealizedReason")
  };
}

function sumField(
  positions: readonly PositionView[],
  field: "realizedPnlLamports" | "unrealizedPnlLamports",
  reasonField: "realizedReason" | "unrealizedReason"
): string | null {
  if (positions.some((position) => position[field] == null)) return null;
  let total = 0n;
  for (const position of positions) total += BigInt(position[field] ?? "0");
  if (positions.length === 0) return "0";
  void reasonField;
  return total.toString();
}

function reasonOf(
  positions: readonly PositionView[],
  field: "realizedPnlLamports" | "unrealizedPnlLamports",
  reasonField: "realizedReason" | "unrealizedReason"
): string | undefined {
  const reasons = positions.filter((position) => position[field] == null).map((position) => position[reasonField]).filter((reason): reason is string => !!reason);
  if (reasons.length === 0) return undefined;
  return [...new Set(reasons)].join(" ");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function divDecimal(numer: bigint, denom: bigint): string {
  const scale = 1_000_000_000_000n;
  const scaled = (numer * scale) / denom;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(12, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** `price` is quote lamports per raw token, integer or decimal. */
export function markValue(tokens: bigint, price: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(price)) throw new Error("Mark price must be a decimal lamports-per-token string.");
  const [whole, frac = ""] = price.split(".");
  const scale = 10n ** BigInt(frac.length);
  return (tokens * BigInt(whole + frac)) / scale;
}
