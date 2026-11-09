import type { CandidateToken, RawSighting, TokenSource } from "../types.js";

/**
 * v13.27 lightweight Tape. One row per mint, published from the raw sighting
 * before any enrich RPC. Bounded so a few hundred sightings a minute stay a
 * small snapshot instead of a growing event log.
 */
export const RAW_TAPE_CAP = 300;
export const RAW_TAPE_FLUSH_MS = 400;
/** Cards the phone folds into the Tape. The server keeps a slightly wider window. */
export const TAPE_CARD_CAP = 150;

export type RawTapeEnrich = "pending" | "queue_full" | "enriched";

export interface RawTapeRow {
  mint: string;
  symbol: string;
  name: string;
  source: string;
  seenAt: number;
  priceUsd?: number;
  volume1hUsd?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  enrich: RawTapeEnrich;
}

export function unenrichedLabel(enrich: RawTapeEnrich): string | null {
  if (enrich === "queue_full") return "not enriched yet / queue full";
  if (enrich === "pending") return "not enriched yet";
  return null;
}

function pos(value: number | undefined): number | undefined {
  return value != null && value > 0 && Number.isFinite(value) ? value : undefined;
}

function better(next: number | undefined, prev: number | undefined): number | undefined {
  if (next == null) return prev;
  if (prev == null || next > prev) return next;
  return prev;
}

/** Display copy of a raw sighting. No network. */
export function draftFromRaw(raw: RawSighting, enrich: RawTapeEnrich, now = Date.now()): RawTapeRow {
  const mint = raw.mint.trim();
  const symbol = raw.symbol?.trim().slice(0, 16) || mint.slice(0, 4);
  const name = raw.name?.trim().slice(0, 48) || raw.symbol?.trim() || symbol;
  return {
    mint,
    symbol,
    name,
    source: raw.source,
    seenAt: raw.observedAt > 0 && Number.isFinite(raw.observedAt) ? raw.observedAt : now,
    priceUsd: pos(raw.priceUsd),
    volume1hUsd: pos(raw.volume1hUsd),
    liquidityUsd: pos(raw.liquidityUsd),
    marketCapUsd: pos(raw.marketCapUsd),
    enrich
  };
}

/**
 * A tap on a row that has not been enriched still needs a token for the existing
 * quote and gate. Price stays 0 so the buy quotes instead of filling at the hint.
 * Null safety fields fail closed. This token is not published to Filter.
 */
export function rawCandidate(row: RawTapeRow): CandidateToken {
  const source: TokenSource = row.source === "pumpfun" || row.source === "replay" ? row.source : "raydium";
  return {
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    source,
    discoveredAt: row.seenAt,
    priceUsd: 0,
    liquidityUsd: 0,
    volume1hUsd: 0,
    ageSeconds: 0,
    mintAuthorityRevoked: null,
    lpLockedOrBurned: null,
    top10HolderPct: null,
    holderCount: null,
    social: { mentions1h: 0, hasWebsite: false, hasTelegram: false, hasTwitter: false }
  };
}

export class RawTape {
  private readonly rows = new Map<string, RawTapeRow>();
  /** Oldest mint first. */
  private readonly order: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly cap: number;
  private readonly flushMs: number;

  constructor(private readonly opts: { onFlush?: () => void; flushMs?: number; cap?: number } = {}) {
    this.cap = opts.cap ?? RAW_TAPE_CAP;
    this.flushMs = opts.flushMs ?? RAW_TAPE_FLUSH_MS;
  }

  observe(row: RawTapeRow): void {
    const mint = row.mint.trim();
    if (!mint) return;
    const prev = this.rows.get(mint);
    if (!prev) {
      if (row.enrich === "enriched") return;
      this.rows.set(mint, { ...row, mint });
      this.order.push(mint);
      this.evict();
      this.schedule();
      return;
    }
    prev.symbol = row.symbol || prev.symbol;
    prev.name = row.name || prev.name;
    if (row.source) prev.source = row.source;
    prev.priceUsd = better(row.priceUsd, prev.priceUsd);
    prev.volume1hUsd = better(row.volume1hUsd, prev.volume1hUsd);
    prev.liquidityUsd = better(row.liquidityUsd, prev.liquidityUsd);
    prev.marketCapUsd = better(row.marketCapUsd, prev.marketCapUsd);
    if (row.enrich === "enriched") prev.enrich = "enriched";
    else if (prev.enrich !== "enriched") prev.enrich = row.enrich;
    this.schedule();
  }

  /** Enrichment finished. Updates the existing row and does not invent one. */
  markEnriched(token: Pick<CandidateToken, "mint" | "symbol" | "name" | "source" | "priceUsd" | "volume1hUsd" | "liquidityUsd" | "marketCapUsd" | "discoveredAt">): void {
    if (!this.rows.has(token.mint)) return;
    this.observe(
      draftFromRaw(
        {
          mint: token.mint,
          symbol: token.symbol,
          name: token.name,
          source: token.source === "replay" ? "raydium" : token.source,
          observedAt: token.discoveredAt,
          priceUsd: token.priceUsd,
          volume1hUsd: token.volume1hUsd,
          liquidityUsd: token.liquidityUsd,
          marketCapUsd: token.marketCapUsd
        },
        "enriched"
      )
    );
  }

  get(mint: string): RawTapeRow | undefined {
    const row = this.rows.get(mint);
    return row ? { ...row } : undefined;
  }

  /** Newest first. */
  view(): RawTapeRow[] {
    const out: RawTapeRow[] = [];
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const row = this.rows.get(this.order[i]!);
      if (row) out.push({ ...row });
    }
    return out;
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.opts.onFlush?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private evict(): void {
    while (this.order.length > this.cap) {
      const mint = this.order.shift();
      if (mint) this.rows.delete(mint);
    }
  }

  private schedule(): void {
    if (this.flushMs <= 0) {
      this.opts.onFlush?.();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.opts.onFlush?.();
    }, this.flushMs);
    this.timer.unref?.();
  }
}
