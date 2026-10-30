import type { RawSighting } from "../types.js";

/** Wrapped SOL, USDC, and USDT. Listing feeds name these as the quote side of a new pool. */
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function sourceFor(mint: string, label: string | undefined): RawSighting["source"] {
  if (/pump/i.test(label ?? "") || mint.endsWith("pump")) return "pumpfun";
  return "raydium";
}

/** DexScreener profiles, boosts, and community takeovers share this shape. */
export function parseDexListings(payload: unknown, now = Date.now()): RawSighting[] {
  if (!Array.isArray(payload)) return [];
  const out: RawSighting[] = [];
  for (const row of payload) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { chainId?: unknown; tokenAddress?: unknown; description?: unknown };
    const mint = text(rec.tokenAddress);
    if (rec.chainId !== "solana" || !mint || QUOTE_MINTS.has(mint)) continue;
    out.push({
      mint,
      name: text(rec.description)?.slice(0, 48),
      source: sourceFor(mint, undefined),
      observedAt: now
    });
  }
  return out;
}

/** GeckoTerminal new_pools and trending_pools. The mint is the base token id after `solana_`. */
export function parseGeckoPools(payload: unknown, now = Date.now()): RawSighting[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const out: RawSighting[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as {
      attributes?: Record<string, unknown>;
      relationships?: { base_token?: { data?: { id?: unknown } }; dex?: { data?: { id?: unknown } } };
    };
    const id = text(rec.relationships?.base_token?.data?.id);
    const mint = id?.startsWith("solana_") ? id.slice("solana_".length) : undefined;
    if (!mint || QUOTE_MINTS.has(mint)) continue;
    const attrs = rec.attributes ?? {};
    const name = text(attrs.name);
    const symbol = name?.split("/")[0]?.trim();
    const volume = num((attrs.volume_usd as { h1?: unknown } | undefined)?.h1);
    const price = num(attrs.base_token_price_usd);
    const liquidity = num(attrs.reserve_in_usd);
    const dex = text(rec.relationships?.dex?.data?.id);
    out.push({
      mint,
      symbol: symbol?.slice(0, 16),
      name: name?.slice(0, 48),
      source: sourceFor(mint, dex),
      observedAt: now,
      volume1hUsd: volume > 0 ? volume : undefined,
      priceUsd: price > 0 ? price : undefined,
      liquidityUsd: liquidity > 0 ? liquidity : undefined,
      priceFeed: price > 0 ? "gecko" : undefined
    });
  }
  return out;
}

/** Jupiter lite `tokens/v2/recent`. No API key. `stats1h` is buy plus sell notional when present. */
export function parseJupiterRecent(payload: unknown, now = Date.now()): RawSighting[] {
  if (!Array.isArray(payload)) return [];
  const out: RawSighting[] = [];
  for (const row of payload) {
    if (!row || typeof row !== "object") continue;
    const rec = row as {
      id?: unknown;
      symbol?: unknown;
      name?: unknown;
      dev?: unknown;
      launchpad?: unknown;
      usdPrice?: unknown;
      liquidity?: unknown;
      stats1h?: { buyVolume?: unknown; sellVolume?: unknown };
    };
    const mint = text(rec.id);
    if (!mint || QUOTE_MINTS.has(mint)) continue;
    const volume = num(rec.stats1h?.buyVolume) + num(rec.stats1h?.sellVolume);
    const price = num(rec.usdPrice);
    const liquidity = num(rec.liquidity);
    out.push({
      mint,
      symbol: text(rec.symbol)?.slice(0, 16),
      name: text(rec.name)?.slice(0, 48),
      source: sourceFor(mint, text(rec.launchpad)),
      devWallet: text(rec.dev),
      observedAt: now,
      volume1hUsd: volume > 0 ? volume : undefined,
      priceUsd: price > 0 ? price : undefined,
      liquidityUsd: liquidity > 0 ? liquidity : undefined,
      priceFeed: price > 0 ? "jupiter" : undefined
    });
  }
  return out;
}

/** DexPaprika pool list. The non-quote token is the candidate. A quiet body is an empty list. */
export function parseDexPaprika(payload: unknown, now = Date.now()): RawSighting[] {
  const root = payload && typeof payload === "object" ? (payload as { pools?: unknown; data?: unknown }) : null;
  const pools = Array.isArray(payload) ? payload : Array.isArray(root?.pools) ? root.pools : Array.isArray(root?.data) ? root.data : [];
  const out: RawSighting[] = [];
  for (const pool of pools) {
    if (!pool || typeof pool !== "object") continue;
    const rec = pool as {
      dex_name?: unknown;
      dexName?: unknown;
      tokens?: unknown;
      price_usd?: unknown;
      volume_usd?: unknown;
    };
    const tokens = Array.isArray(rec.tokens) ? rec.tokens : [];
    const base = tokens
      .map((token) => (token && typeof token === "object" ? (token as { id?: unknown; symbol?: unknown; name?: unknown }) : null))
      .find((token) => {
        const mint = text(token?.id);
        return Boolean(mint && !QUOTE_MINTS.has(mint));
      });
    const mint = text(base?.id);
    if (!mint) continue;
    const dex = text(rec.dex_name) ?? text(rec.dexName);
    out.push({
      mint,
      symbol: text(base?.symbol)?.slice(0, 16),
      name: text(base?.name)?.slice(0, 48),
      source: sourceFor(mint, dex),
      observedAt: now,
      priceUsd: num(rec.price_usd) > 0 ? num(rec.price_usd) : undefined,
      volume1hUsd: num(rec.volume_usd) > 0 ? num(rec.volume_usd) : undefined
    });
  }
  return out;
}
