/**
 * Import confirmed pump fills into the journal. The fixture path and the chain path
 * share one recorder, so a signature already logged from the desk is not duplicated.
 */
import type { TradeEvent } from "../types.js";
import { isConfirmed, JournalStore, type JournalRow, type TradeReport } from "./journal.js";

export interface ImportResult {
  logged: number;
  skipped: number;
  duplicates: number;
  rows: JournalRow[];
}

export function importReports(store: JournalStore, reports: readonly TradeReport[]): ImportResult {
  let logged = 0;
  let skipped = 0;
  let duplicates = 0;
  for (const report of reports) {
    if (!isConfirmed(report)) {
      skipped += 1;
      continue;
    }
    const result = store.record({ ...report, source: report.source ?? "chain" });
    if (!result.logged) skipped += 1;
    else if (result.duplicate) duplicates += 1;
    else logged += 1;
  }
  return { logged, skipped, duplicates, rows: store.rows() };
}

export interface ChainFillSource {
  /** Confirmed fills only. The source drops failed transactions before they get here. */
  fills(wallet: string): Promise<TradeReport[]>;
}

export async function importWallet(store: JournalStore, source: ChainFillSource, wallet: string): Promise<ImportResult> {
  const fills = await source.fills(wallet);
  return importReports(
    store,
    fills.map((fill) => ({ ...fill, wallet: fill.wallet || wallet, source: "chain" as const }))
  );
}

/**
 * A decoded pump trade log is already a chain event. Rows without a signature are skipped.
 * Market cap uses `virtualQuote * supply / virtualToken` when the mint supply is known.
 */
export function reportsFromTrades(
  events: readonly TradeEvent[],
  opts: { wallet?: string; venue?: "curve" | "pumpswap"; supplyByMint?: Record<string, string>; symbolByMint?: Record<string, string> } = {}
): TradeReport[] {
  const out: TradeReport[] = [];
  for (const event of events) {
    if (!event.signature) continue;
    if (opts.wallet && event.user !== opts.wallet) continue;
    const supply = opts.supplyByMint?.[event.mint];
    out.push({
      signature: event.signature,
      wallet: event.user,
      mint: event.mint,
      symbol: opts.symbolByMint?.[event.mint],
      side: event.isBuy ? "buy" : "sell",
      venue: opts.venue ?? "curve",
      solLamports: event.solAmountLamports,
      tokenAmount: event.tokenAmount,
      feeLamports: event.feeLamports,
      marketCapLamports: supply ? marketCapFromTrade(event, supply) : "0",
      timestamp: event.timestamp,
      confirmation: "confirmed",
      source: "chain"
    });
  }
  return out;
}

function marketCapFromTrade(event: TradeEvent, supply: string): string {
  if (!/^\d+$/.test(supply) || !/^\d+$/.test(event.virtualTokenReserves) || !/^\d+$/.test(event.virtualQuoteReserves)) return "0";
  const tokens = BigInt(event.virtualTokenReserves);
  if (tokens <= 0n) return "0";
  return ((BigInt(event.virtualQuoteReserves) * BigInt(supply)) / tokens).toString();
}
