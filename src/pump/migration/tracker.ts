/**
 * After graduation the coin is viewed on its PumpSwap or Raydium pool.
 * A 30%+ quote drop inside 5 minutes that sells do not explain emits an AlertEvent.
 */
import type { PumpFeatureHost } from "../features/host.js";
import { assessLp, stillLocked, type LpAssessment, type LpHolder, type PoolVenue } from "./lp.js";

export const LIQUIDITY_WINDOW_MS = 5 * 60_000;
export const LIQUIDITY_DROP_PCT = 30;

export const MIGRATION_ROUTES = ["/api/pump/migration"] as const;

export interface MigrationView extends LpAssessment {
  /** Null until a second reading. False when a lock balance fell. */
  stillLocked: boolean | null;
  quoteLamports: string;
  updatedAt: number;
}

interface Sample {
  at: number;
  quote: bigint;
  /** Cumulative sell lamports observed for this mint. */
  sell: bigint;
}

interface Tracked {
  view: MigrationView;
  samples: Sample[];
  /** Peak sample time already paged, so one drop alerts once. */
  alertedPeakAt: number | null;
}

export interface LiquidityInput {
  mint: string;
  quoteLamports: bigint;
  /** Cumulative sells. The delta since the peak is what has to explain the drop. */
  cumulativeSellLamports: bigint;
  at: number;
}

export interface DropDecision {
  alert: boolean;
  dropPct: number;
  quoteBefore: bigint;
  quoteAfter: bigint;
  sellLamports: bigint;
  /** Timestamp of the peak sample. Identifies one drop so it pages once. */
  peakAt: number;
}

/** Peak quote inside the window versus now. Sells since that peak that cover at least half the drop count as matching. */
export function liquidityDrop(samples: Sample[], now: number, quote: bigint, cumulativeSell: bigint): DropDecision {
  const window = samples.filter((sample) => now - sample.at <= LIQUIDITY_WINDOW_MS && now - sample.at >= 0);
  let peak = quote;
  let peakSell = cumulativeSell;
  let peakAt = now;
  for (const sample of window) {
    if (sample.quote > peak) {
      peak = sample.quote;
      peakSell = sample.sell;
      peakAt = sample.at;
    }
  }
  const drop = peak > quote ? peak - quote : 0n;
  const dropPct = peak > 0n ? Number((drop * 10_000n) / peak) / 100 : 0;
  const sells = cumulativeSell > peakSell ? cumulativeSell - peakSell : 0n;
  const big = peak > 0n && drop * 100n >= peak * BigInt(LIQUIDITY_DROP_PCT);
  // Sells match when the SOL that left the pool showed up as sells.
  const unmatched = sells < drop;
  return {
    alert: big && unmatched && peakAt !== now,
    dropPct,
    quoteBefore: peak,
    quoteAfter: quote,
    sellLamports: sells,
    peakAt
  };
}

/** Curve until graduation, then the pool the migration landed on. */
export function displayVenue(input: { complete: boolean; migration: { venue: PoolVenue } | null }): "curve" | "pumpswap" | "raydium" {
  if (input.migration?.venue === "pumpswap" || input.migration?.venue === "raydium") return input.migration.venue;
  if (input.complete) return "pumpswap";
  return "curve";
}

export class MigrationTracker {
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly host: PumpFeatureHost | null = null) {}

  view(mint: string): MigrationView | null {
    return this.tracked.get(mint)?.view ?? null;
  }

  /** Switch the coin onto this pool and refresh LP numbers. */
  observeLp(input: {
    mint: string;
    pool: string;
    ownerProgram: string;
    lpSupply: bigint;
    lpMintSupply?: bigint | null;
    holders?: LpHolder[];
    quoteLamports?: bigint;
    at?: number;
  }): MigrationView {
    const assessed = assessLp(input);
    const prev = this.tracked.get(input.mint)?.view ?? null;
    const at = input.at ?? this.host?.now() ?? Date.now();
    const view: MigrationView = {
      ...assessed,
      stillLocked: stillLocked(prev, assessed),
      quoteLamports: (input.quoteLamports ?? (prev ? BigInt(prev.quoteLamports) : 0n)).toString(),
      updatedAt: at
    };
    const row = this.tracked.get(input.mint);
    this.tracked.set(input.mint, { view, samples: row?.samples ?? [], alertedPeakAt: row?.alertedPeakAt ?? null });
    return view;
  }

  /**
   * Quote reserve sample. Emits one core alert when liquidity falls 30%+
   * inside 5 minutes and sells since the peak do not cover the drop.
   */
  noteLiquidity(input: LiquidityInput): { view: MigrationView | null; alerted: boolean } {
    const row: Tracked = this.tracked.get(input.mint) ?? {
      view: this.placeholder(input.mint, input.at),
      samples: [],
      alertedPeakAt: null
    };
    const decision = liquidityDrop(row.samples, input.at, input.quoteLamports, input.cumulativeSellLamports);
    row.samples = row.samples.filter((sample) => input.at - sample.at <= LIQUIDITY_WINDOW_MS);
    row.samples.push({ at: input.at, quote: input.quoteLamports, sell: input.cumulativeSellLamports });
    let alerted = false;
    if (decision.alert && row.alertedPeakAt !== decision.peakAt) {
      row.alertedPeakAt = decision.peakAt;
      alerted = true;
      this.host?.emitAlert({
        kind: "custom",
        mint: input.mint,
        message: `Liquidity in ${input.mint} fell ${decision.dropPct.toFixed(1)}% within 5 min without matching sells`,
        data: {
          type: "liquidity-drop",
          dropPct: decision.dropPct,
          quoteBefore: decision.quoteBefore.toString(),
          quoteAfter: decision.quoteAfter.toString(),
          sellLamports: decision.sellLamports.toString(),
          windowMs: LIQUIDITY_WINDOW_MS
        }
      });
    }
    row.view = { ...row.view, quoteLamports: input.quoteLamports.toString(), updatedAt: input.at };
    this.tracked.set(input.mint, row);
    return { view: row.view, alerted };
  }

  /** A quote-only sample before any LP reading. Venue stays unknown until observeLp. */
  private placeholder(mint: string, at: number): MigrationView {
    return {
      mint,
      pool: "",
      venue: "other",
      canonical: false,
      poolClass: "non-canonical",
      lpSupply: "0",
      lpBurnedPct: 0,
      owners: [],
      locked: false,
      lockedAmount: "0",
      lockers: [],
      stillLocked: null,
      quoteLamports: "0",
      updatedAt: at
    };
  }
}

const trackers = new WeakMap<PumpFeatureHost, MigrationTracker>();

export function attachTracker(host: PumpFeatureHost): MigrationTracker {
  let tracker = trackers.get(host);
  if (!tracker) {
    tracker = new MigrationTracker(host);
    trackers.set(host, tracker);
  }
  return tracker;
}

export function trackerFor(host: PumpFeatureHost): MigrationTracker {
  return attachTracker(host);
}

export async function handleMigration(host: PumpFeatureHost, method: string, url: URL, body: Record<string, unknown>): Promise<{ status: number; body: unknown } | null> {
  const path = url.pathname.replace(/\/$/, "");
  if (path !== "/api/pump/migration") return null;
  const tracker = trackerFor(host);
  if (method === "GET") {
    const mint = url.searchParams.get("mint") ?? "";
    const view = mint ? tracker.view(mint) : null;
    if (!view) return { status: 404, body: { ok: false, error: "No migration view for that mint.", code: "NOT_FOUND" } };
    return { status: 200, body: { ok: true, migration: view, venue: displayVenue({ complete: true, migration: view }) } };
  }
  if (method !== "POST") return { status: 405, body: { ok: false, error: "POST the observation.", code: "BAD_REQUEST" } };
  const mint = str(body.mint);
  const pool = str(body.pool);
  const ownerProgram = str(body.ownerProgram);
  if (!mint || !pool || !ownerProgram) {
    return { status: 400, body: { ok: false, error: "mint, pool, and ownerProgram are required", code: "BAD_REQUEST" } };
  }
  const at = typeof body.at === "number" ? body.at : host.now();
  const view = tracker.observeLp({
    mint,
    pool,
    ownerProgram,
    lpSupply: big(body.lpSupply),
    lpMintSupply: body.lpMintSupply == null || body.lpMintSupply === "" ? null : big(body.lpMintSupply),
    holders: holdersOf(body.holders),
    quoteLamports: big(body.quoteLamports),
    at
  });
  const noted = tracker.noteLiquidity({
    mint,
    quoteLamports: big(body.quoteLamports),
    cumulativeSellLamports: big(body.sellLamports),
    at
  });
  return {
    status: 200,
    body: { ok: true, migration: tracker.view(mint) ?? view, venue: displayVenue({ complete: true, migration: view }), alerted: noted.alerted }
  };
}

function holdersOf(value: unknown): LpHolder[] {
  if (!Array.isArray(value)) return [];
  const out: LpHolder[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const owner = str((row as { owner?: unknown }).owner);
    const amount = (row as { amount?: unknown }).amount;
    if (!owner) continue;
    out.push({ owner, amount: big(amount).toString() });
  }
  return out;
}

function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
