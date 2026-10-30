/**
 * Add-coin input. Accepts a bare Solana mint or a link from one of the platforms
 * Dirk finds coins on. Parsing is pure and never calls the network. A pair address
 * (DexScreener, Photon) still has to be resolved to its base mint by the caller.
 */

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ANY = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

export type CoinPlatform =
  | "Mint"
  | "DexScreener"
  | "pump.fun"
  | "Birdeye"
  | "GMGN"
  | "Jupiter"
  | "Raydium"
  | "Photon"
  | "BullX"
  | "Solscan";

/**
 * kind:
 *   mint   — the address is a token mint.
 *   pair   — the address is a pool/pair; resolve it to the base mint.
 *   either — could be a pair or a mint (DexScreener links use both); try pair first.
 */
export type ParsedCoinInput =
  | { ok: true; platform: CoinPlatform; address: string; kind: "mint" | "pair" | "either" }
  | { ok: false; error: string };

export function isSolanaAddress(text: string): boolean {
  return BASE58.test(text);
}

export function isQuoteMint(mint: string): boolean {
  return QUOTE_MINTS.has(mint);
}

const HOSTS: Array<{ test: RegExp; platform: Exclude<CoinPlatform, "Mint"> }> = [
  { test: /(^|\.)dexscreener\.com$/i, platform: "DexScreener" },
  { test: /(^|\.)pump\.fun$/i, platform: "pump.fun" },
  { test: /(^|\.)birdeye\.so$/i, platform: "Birdeye" },
  { test: /(^|\.)gmgn\.ai$/i, platform: "GMGN" },
  { test: /(^|\.)jup\.ag$/i, platform: "Jupiter" },
  { test: /(^|\.)raydium\.io$/i, platform: "Raydium" },
  { test: /(^|\.)(photon-sol\.tinyastro\.io|photon\.tinyastro\.io)$/i, platform: "Photon" },
  { test: /(^|\.)bullx\.io$/i, platform: "BullX" },
  { test: /(^|\.)solscan\.io$/i, platform: "Solscan" }
];

/** Query keys that name the coin, most specific first. */
const QUERY_KEYS = ["outputMint", "outputCurrency", "buy", "address", "token", "tokenAddress", "mint", "ca", "q"];

export function parseCoinInput(raw: string): ParsedCoinInput {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, error: "Paste a Solana mint or a coin link." };
  if (text.length > 600) return { ok: false, error: "That input is too long to be a mint or a coin link." };
  if (isSolanaAddress(text)) {
    if (isQuoteMint(text)) return { ok: false, error: "That is SOL/USDC/USDT, not a coin to trade." };
    return { ok: true, platform: "Mint", address: text, kind: "mint" };
  }
  const url = toUrl(text);
  if (!url) {
    return { ok: false, error: "Not a Solana mint or a supported link (DexScreener, pump.fun, Birdeye, GMGN, Jupiter, Raydium, Photon, BullX, Solscan)." };
  }
  const host = HOSTS.find((entry) => entry.test.test(url.hostname));
  if (!host) {
    return { ok: false, error: `Links from ${url.hostname} are not supported. Use DexScreener, pump.fun, Birdeye, GMGN, Jupiter, Raydium, Photon, BullX or Solscan, or paste the mint.` };
  }
  const segments = url.pathname.split("/").filter(Boolean).map((part) => safeDecode(part));
  const lower = segments.map((part) => part.toLowerCase());
  const platform = host.platform;

  // Non-Solana chains on multi-chain sites are refused up front.
  if (platform === "DexScreener" && lower[0] && lower[0] !== "solana") {
    return { ok: false, error: `That DexScreener link is on ${segments[0]}. Only Solana coins can be added.` };
  }
  if (platform === "GMGN" && lower[0] && !["sol", "solana"].includes(lower[0])) {
    return { ok: false, error: `That GMGN link is on ${segments[0]}. Only Solana coins can be added.` };
  }
  const chain = (url.searchParams.get("chain") ?? "").toLowerCase();
  if (platform === "Birdeye" && chain && chain !== "solana") {
    return { ok: false, error: `That Birdeye link is on ${chain}. Only Solana coins can be added.` };
  }

  const fromQuery = firstAddress(QUERY_KEYS.map((key) => url.searchParams.get(key) ?? ""));
  const fromPath = lastAddress(segments);

  switch (platform) {
    case "DexScreener": {
      // /solana/<pairOrMint>
      const address = fromPath;
      return address ? { ok: true, platform, address, kind: "either" } : missing(platform);
    }
    case "Photon": {
      // /en/lp/<pair> or /lp/<pair>; /en/token/<mint>
      const address = fromPath ?? fromQuery;
      if (!address) return missing(platform);
      return { ok: true, platform, address, kind: lower.includes("lp") ? "pair" : "either" };
    }
    case "Jupiter": {
      // /swap/SOL-<mint>, /swap?sell=..&buy=<mint>, /tokens/<mint>
      const pairPart = segments.find((part) => part.includes("-"));
      const fromSwap = pairPart ? lastAddress(pairPart.split("-")) : null;
      const address = fromQuery ?? fromSwap ?? fromPath;
      return address ? { ok: true, platform, address, kind: "mint" } : missing(platform);
    }
    case "Raydium": {
      // /swap/?inputMint=sol&outputMint=<mint>
      const address = fromQuery ?? firstAddress([url.searchParams.get("inputMint") ?? ""]) ?? fromPath;
      return address ? { ok: true, platform, address, kind: "mint" } : missing(platform);
    }
    case "GMGN": {
      // /sol/token/<mint> or /sol/token/<ref>_<mint>
      const tail = segments[segments.length - 1] ?? "";
      const fromTail = lastAddress(tail.split("_"));
      const address = fromTail ?? fromPath ?? fromQuery;
      return address ? { ok: true, platform, address, kind: "mint" } : missing(platform);
    }
    case "Solscan": {
      // /token/<mint>; /account/<address> can be a pair or a mint
      const address = fromPath ?? fromQuery;
      if (!address) return missing(platform);
      return { ok: true, platform, address, kind: lower.includes("token") ? "mint" : "either" };
    }
    default: {
      // pump.fun /coin/<mint> or /<mint>; Birdeye /token/<mint> or /solana/token/<mint>; BullX ?address=<mint>
      const address = fromQuery ?? fromPath;
      return address ? { ok: true, platform, address, kind: "mint" } : missing(platform);
    }
  }
}

/** Short platform label for the position tag. */
export function positionTag(platform: string): string {
  return platform && platform !== "Mint" ? `manual · ${platform}` : "manual";
}

export function dexscreenerUrl(mintOrPair: string): string {
  return `https://dexscreener.com/solana/${mintOrPair}`;
}

function missing(platform: CoinPlatform): ParsedCoinInput {
  return { ok: false, error: `Could not find a Solana coin address in that ${platform} link.` };
}

function toUrl(text: string): URL | null {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : /^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(text) ? `https://${text}` : "";
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function firstAddress(values: string[]): string | null {
  for (const value of values) {
    for (const match of value.match(BASE58_ANY) ?? []) {
      if (isSolanaAddress(match) && !isQuoteMint(match)) return match;
    }
  }
  return null;
}

function lastAddress(values: string[]): string | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i] ?? "";
    if (isSolanaAddress(value) && !isQuoteMint(value)) return value;
  }
  return null;
}
