/**
 * v13.6 Add coin by ticker or name. Pure matching plus a polite DexScreener search client.
 *
 * Resolve order (the caller feeds the local tiers):
 *   1. open positions (paper + live) and recent trades — one exact hit answers without a network call
 *   2. Tape / Scout sightings, lookups and the watchlist, merged with DexScreener search
 *   3. DexScreener /latest/dex/search (Solana pairs only, ranked by liquidity then 1h volume)
 * A Tape hit does not hide other coins and does not skip the search.
 */
import { isQuoteMint, isSolanaAddress } from "./coin-input.js";

type FetchLike = typeof fetch;

export interface TickerCandidate {
  mint: string;
  symbol: string;
  name: string;
  mintShort: string;
  liquidityUsd: number | null;
  volume1hUsd: number | null;
  held: boolean;
  /** Where it was found: a held/traded coin, the Tape, or DexScreener search. */
  origin: "position" | "trade" | "tape" | "dexscreener";
  /** Exact ticker/name hit (vs a partial DexScreener match). */
  exact: boolean;
}

export interface LocalCoin {
  mint: string;
  symbol: string;
  name?: string;
  liquidityUsd?: number | null;
  volume1hUsd?: number | null;
  held?: boolean;
  origin: TickerCandidate["origin"];
  /** Newer first wins ties inside a tier. */
  at?: number;
}

const TICKER_TEXT = /^\$?[\p{L}\p{N}][\p{L}\p{N} ._\-$]{0,39}$/u;

/** Normalised query for a ticker/name, or null when the text is not one (mints and links take the old path). */
export function tickerQuery(raw: string): string | null {
  const text = (raw ?? "").trim();
  if (!text || isSolanaAddress(text)) return null;
  if (/[/:]/.test(text) || /^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(text)) return null;
  if (!TICKER_TEXT.test(text)) return null;
  const q = text.replace(/^\$+/, "").trim();
  return q ? q : null;
}

export function normTicker(text: string | undefined | null): string {
  return (text ?? "").trim().replace(/^\$+/, "").toLowerCase();
}

export function shortMint(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/** Exact (case-insensitive, $ optional) ticker or name matches, one row per mint, in input order. */
export function matchLocal(query: string, coins: LocalCoin[]): TickerCandidate[] {
  const q = normTicker(query);
  if (!q) return [];
  const out = new Map<string, TickerCandidate>();
  for (const coin of coins) {
    if (!coin.mint || isQuoteMint(coin.mint)) continue;
    const hit = normTicker(coin.symbol) === q || normTicker(coin.name) === q;
    if (!hit) continue;
    const prev = out.get(coin.mint);
    if (prev) {
      prev.held = prev.held || !!coin.held;
      if (prev.liquidityUsd == null && coin.liquidityUsd != null) prev.liquidityUsd = coin.liquidityUsd;
      if (prev.volume1hUsd == null && coin.volume1hUsd != null) prev.volume1hUsd = coin.volume1hUsd;
      continue;
    }
    out.set(coin.mint, {
      mint: coin.mint,
      symbol: coin.symbol || coin.mint.slice(0, 6),
      name: coin.name || coin.symbol || "",
      mintShort: shortMint(coin.mint),
      liquidityUsd: finiteOrNull(coin.liquidityUsd),
      volume1hUsd: finiteOrNull(coin.volume1hUsd),
      held: !!coin.held,
      origin: coin.origin,
      exact: true
    });
  }
  return [...out.values()];
}

/** Tape rows first, then DexScreener mints that are not already listed. Capped at 8. */
export function mergeTickerCandidates(local: TickerCandidate[], remote: TickerCandidate[], limit = 8): TickerCandidate[] {
  const seen = new Set(local.map((row) => row.mint));
  const extra = remote.filter((row) => row.mint && !seen.has(row.mint));
  return [...local, ...extra].slice(0, limit);
}

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  liquidity?: { usd?: number };
  volume?: { h1?: number };
}

/**
 * Solana-only DexScreener search rows folded to one row per base mint (liquidity and
 * 1h volume summed across its pools). Exact ticker/name hits rank first, then by
 * liquidity, then 1h volume. Partial hits only show when no exact one exists.
 */
export function rankDexSearch(query: string, body: unknown, held: Set<string> = new Set(), limit = 8): TickerCandidate[] {
  const q = normTicker(query);
  const pairs = Array.isArray((body as { pairs?: unknown })?.pairs) ? ((body as { pairs: unknown[] }).pairs as DexPair[]) : [];
  const rows = new Map<string, TickerCandidate & { score: number }>();
  for (const pair of pairs) {
    if (!pair || pair.chainId !== "solana") continue;
    for (const side of [pair.baseToken, pair.quoteToken]) {
      const mint = side?.address ?? "";
      if (!isSolanaAddress(mint) || isQuoteMint(mint)) continue;
      const sym = normTicker(side?.symbol);
      const name = normTicker(side?.name);
      const exact = sym === q || name === q;
      const partial = !exact && q.length >= 2 && (sym.includes(q) || name.includes(q));
      if (!exact && !partial) continue;
      const liq = Number(pair.liquidity?.usd);
      const vol = Number(pair.volume?.h1);
      const prev = rows.get(mint);
      if (prev) {
        if (Number.isFinite(liq)) prev.liquidityUsd = (prev.liquidityUsd ?? 0) + liq;
        if (Number.isFinite(vol)) prev.volume1hUsd = (prev.volume1hUsd ?? 0) + vol;
        continue;
      }
      rows.set(mint, {
        mint,
        symbol: side?.symbol || mint.slice(0, 6),
        name: side?.name || "",
        mintShort: shortMint(mint),
        liquidityUsd: Number.isFinite(liq) ? liq : null,
        volume1hUsd: Number.isFinite(vol) ? vol : null,
        held: held.has(mint),
        origin: "dexscreener",
        exact,
        score: sym === q ? 2 : exact ? 1 : 0
      });
    }
  }
  const all = [...rows.values()];
  const exacts = all.filter((r) => r.exact);
  const pool = exacts.length ? exacts : all;
  pool.sort((a, b) => b.score - a.score || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || (b.volume1hUsd ?? 0) - (a.volume1hUsd ?? 0));
  return pool.slice(0, limit).map(({ score: _score, ...rest }) => rest);
}

export interface DexSearchClock {
  now: () => number;
}

/**
 * DexScreener search with its own spacing, cache and backoff, on top of the shared
 * NetLimiter bucket, so typed tickers never eat Scout's pairs budget.
 * - same query within 60s → cached answer
 * - at most one search every 1.5s; more come back "busy"
 * - a 429 or 5xx backs off 10s → 20s → … capped at 5 minutes
 */
export class DexSearchClient {
  static readonly CACHE_MS = 60_000;
  static readonly MIN_GAP_MS = 1_500;
  static readonly BACKOFF_BASE_MS = 10_000;
  static readonly BACKOFF_CAP_MS = 300_000;
  private cache = new Map<string, { at: number; body: unknown }>();
  private lastAt = 0;
  private pausedUntil = 0;
  private strikes = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly clock: DexSearchClock = { now: () => Date.now() }
  ) {}

  async search(query: string): Promise<{ ok: true; body: unknown; cached: boolean } | { ok: false; error: string; retryInMs?: number }> {
    const key = normTicker(query);
    const now = this.clock.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < DexSearchClient.CACHE_MS) return { ok: true, body: hit.body, cached: true };
    if (now < this.pausedUntil) {
      return { ok: false, error: `DexScreener search is backing off after a rate limit. Try again in ${Math.ceil((this.pausedUntil - now) / 1000)}s, or paste the mint.`, retryInMs: this.pausedUntil - now };
    }
    if (now - this.lastAt < DexSearchClient.MIN_GAP_MS) {
      const wait = DexSearchClient.MIN_GAP_MS - (now - this.lastAt);
      return { ok: false, error: "Searching too fast. Try again in a second.", retryInMs: wait };
    }
    this.lastAt = now;
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json", "user-agent": "night-desk/1.0" },
        signal: AbortSignal.timeout(6_000)
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `DexScreener search failed (${message}). Paste the mint instead.` };
    }
    if (res.status === 429 || res.status >= 500) {
      this.strikes += 1;
      const backoff = Math.min(DexSearchClient.BACKOFF_CAP_MS, DexSearchClient.BACKOFF_BASE_MS * 2 ** (this.strikes - 1));
      this.pausedUntil = this.clock.now() + backoff;
      return { ok: false, error: `DexScreener search is rate limited (HTTP ${res.status}). Backing off ${Math.round(backoff / 1000)}s; paste the mint meanwhile.`, retryInMs: backoff };
    }
    if (!res.ok) return { ok: false, error: `DexScreener search failed (HTTP ${res.status}).` };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: "DexScreener search returned bad JSON." };
    }
    this.strikes = 0;
    this.cache.set(key, { at: this.clock.now(), body });
    if (this.cache.size > 100) {
      const first = this.cache.keys().next().value;
      if (first != null) this.cache.delete(first);
    }
    return { ok: true, body, cached: false };
  }
}

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
