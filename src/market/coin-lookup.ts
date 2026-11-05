import { isQuoteMint, type ParsedCoinInput } from "./coin-input.js";

type FetchLike = typeof fetch;

/**
 * Turns a parsed Add-coin input into a token mint.
 * A pair address is resolved to its base mint with the DexScreener pairs API.
 * If the base is SOL/USDC/USDT the other side is the coin.
 * "either" falls back to treating the address as a mint when DexScreener has no such pair.
 */
export async function resolveCoinMint(
  parsed: Extract<ParsedCoinInput, { ok: true }>,
  fetchImpl: FetchLike = fetch
): Promise<{ ok: true; mint: string; pairAddress?: string } | { ok: false; error: string }> {
  if (parsed.kind === "mint") return { ok: true, mint: parsed.address };
  let body: unknown = null;
  try {
    const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/pairs/solana/${parsed.address}`, {
      headers: { accept: "application/json", "user-agent": "night-desk/1.0" },
      signal: AbortSignal.timeout(6_000)
    });
    if (res.ok) body = await res.json();
    else if (parsed.kind === "pair") return { ok: false, error: `DexScreener could not resolve that pair (HTTP ${res.status}).` };
  } catch (err) {
    if (parsed.kind === "pair") {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `DexScreener could not resolve that pair (${message}).` };
    }
  }
  const mint = baseMintFromPairs(body, parsed.address);
  if (mint) return { ok: true, mint, pairAddress: parsed.address };
  if (parsed.kind === "pair") return { ok: false, error: "DexScreener has no Solana pair at that address." };
  return { ok: true, mint: parsed.address };
}

export function baseMintFromPairs(body: unknown, pairAddress: string): string | null {
  const record = body as { pairs?: unknown; pair?: unknown } | null;
  const list: unknown[] = Array.isArray(record?.pairs) ? (record!.pairs as unknown[]) : record?.pair ? [record.pair] : [];
  for (const raw of list) {
    const pair = raw as { chainId?: string; pairAddress?: string; baseToken?: { address?: string }; quoteToken?: { address?: string } };
    if (pair?.chainId && pair.chainId !== "solana") continue;
    if (pair?.pairAddress && pair.pairAddress !== pairAddress) continue;
    const base = pair?.baseToken?.address;
    const quote = pair?.quoteToken?.address;
    if (base && !isQuoteMint(base)) return base;
    if (quote && !isQuoteMint(quote)) return quote;
  }
  return null;
}
