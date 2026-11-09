import type { CandidateToken, RawSighting } from "../types.js";
import { inferOnBondingCurve, pumpReserveAddresses, RESERVE_OWNER_SET } from "./exclusions.js";
import {
  attachTokenOwners,
  parseDexPair,
  parseHolderAccounts,
  parseMintAccount,
  parseRugcheckReport,
  parseTop10Pct,
  type TokenAccountRow
} from "./parsers.js";

export interface EnrichDeps {
  rpcUrl?: string;
  rugcheckUrl?: string;
  fetchImpl?: typeof fetch;
  /** Pages of 1,000 token accounts when the RPC is Helius. 0 keeps the top-20 read. */
  holderPagesMax?: number;
  dasGapMs?: number;
  /** v12.1: batched DexScreener lookup. When absent, one /latest/dex/tokens call per mint. */
  dexLookup?: (mint: string) => Promise<unknown | null>;
  /**
   * Lookup only. Fired when mint authority (and again when Rugcheck) is known,
   * before DexScreener or holder reads finish.
   */
  onChain?: (token: CandidateToken) => void;
}

const DAS_PAGE = 1_000;
let dasNextSlot = 0;

async function dasSlot(gapMs: number): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, dasNextSlot);
  dasNextSlot = at + gapMs;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

export function isHeliusUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host.endsWith("helius-rpc.com") || host.endsWith("helius.xyz");
  } catch {
    return false;
  }
}

const emptySocial = { mentions1h: 0, hasWebsite: false, hasTelegram: false, hasTwitter: false };

export async function enrichSighting(raw: RawSighting, deps: EnrichDeps): Promise<CandidateToken> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token: CandidateToken = {
    mint: raw.mint,
    symbol: raw.symbol?.slice(0, 16) || raw.mint.slice(0, 4),
    name: raw.name?.slice(0, 48) || raw.symbol || raw.mint.slice(0, 6),
    source: raw.source,
    discoveredAt: raw.observedAt,
    priceUsd: 0,
    liquidityUsd: 0,
    volume1hUsd: 0,
    ageSeconds: 0,
    mintAuthorityRevoked: null,
    lpLockedOrBurned: null,
    top10HolderPct: null,
    holderCount: null,
    devWallet: raw.devWallet ?? null,
    social: { ...emptySocial }
  };

  // Dex, the mint account, and RugCheck do not depend on each other.
  // Holder accounts still wait on mint supply, then on the largest-account addresses.
  // A thin 1h volume does not skip mint, holders, or rug checks — Filter still needs those kill reasons.
  // Mint authority is published as soon as getAccountInfo returns. Lookup's short chain
  // budget must not throw that away because Dex or the holder reads are still running.
  const rugUrl = deps.rugcheckUrl
    ? `${deps.rugcheckUrl.replace(/\/$/, "")}/tokens/${raw.mint}/report`
    : null;
  const dexTask = deps.dexLookup
    ? deps.dexLookup(raw.mint).catch(() => null)
    : fetchJson(fetchImpl, `https://api.dexscreener.com/latest/dex/tokens/${raw.mint}`);
  const mintTask = deps.rpcUrl
    ? rpc(fetchImpl, deps.rpcUrl, "getAccountInfo", [raw.mint, { encoding: "jsonParsed" }])
    : Promise.resolve(null);
  const rugTask = rugUrl ? fetchJson(fetchImpl, rugUrl) : Promise.resolve(null);
  const publishChain = () => {
    deps.onChain?.({ ...token, social: { ...token.social } });
  };

  const mintInfo = await mintTask;
  const mint = parseMintAccount(mintInfo);
  if (deps.rpcUrl) {
    if (mint.mintAuthorityRevoked != null) token.mintAuthorityRevoked = mint.mintAuthorityRevoked;
    if (mint.decimals != null) token.decimals = mint.decimals;
    if (mint.mintAuthorityRevoked != null || mint.decimals != null) publishChain();
  }

  let riskText = "";
  const dex = await Promise.all([
    dexTask,
    rugTask.then((report) => {
      if (!report) return;
      const rug = parseRugcheckReport(report, raw.mint);
      riskText = rug.riskText;
      if (token.mintAuthorityRevoked == null && rug.mintAuthorityRevoked != null) {
        token.mintAuthorityRevoked = rug.mintAuthorityRevoked;
      }
      if (rug.lpLockedOrBurned != null) token.lpLockedOrBurned = rug.lpLockedOrBurned;
      if (rug.lpLockPct != null) token.lpLockPct = rug.lpLockPct;
      // Believe the more concentrated read. A source that dropped a reserve must not lower the chain figure.
      if (rug.top10HolderPct != null) {
        token.top10HolderPct =
          token.top10HolderPct == null ? rug.top10HolderPct : Math.max(token.top10HolderPct, rug.top10HolderPct);
      }
      if (!token.devWallet && rug.devWallet) token.devWallet = rug.devWallet;
      if (rug.devHoldingPct != null) token.devHoldingPct = rug.devHoldingPct;
      if (rug.devRug) token.devRug = rug.devRug;
      publishChain();
    })
  ]).then(([body]) => body);

  const parsed = dex ? parseDexPair(dex, raw.mint) : null;
  if (parsed && parsed.priceUsd > 0) {
    token.priceUsd = parsed.priceUsd;
    token.liquidityUsd = parsed.liquidityUsd;
    token.volume1hUsd = parsed.volume1hUsd;
    token.volume5mUsd = parsed.volume5mUsd;
    token.priceChange1hPct = parsed.priceChange1hPct;
    token.marketCapUsd = parsed.marketCapUsd;
    token.ageSeconds = parsed.ageSeconds;
    token.pairAddress = parsed.pairAddress;
    token.dex = parsed.dex;
    token.source = parsed.source;
    token.priceFeed = "dexscreener";
    token.social = parsed.social;
    if (parsed.symbol) token.symbol = parsed.symbol.slice(0, 16);
    if (parsed.name) token.name = parsed.name.slice(0, 48);
    if (!(token.volume1hUsd > 0) && (raw.volume1hUsd ?? 0) > 0) token.volume1hUsd = raw.volume1hUsd ?? 0;
    if (!(token.liquidityUsd > 0) && (raw.liquidityUsd ?? 0) > 0) token.liquidityUsd = raw.liquidityUsd ?? 0;
  } else if ((raw.priceUsd ?? 0) > 0 || (raw.volume1hUsd ?? 0) > 0 || (raw.liquidityUsd ?? 0) > 0 || parsed) {
    if (parsed) {
      token.volume1hUsd = parsed.volume1hUsd;
      token.volume5mUsd = parsed.volume5mUsd;
      token.marketCapUsd = parsed.marketCapUsd;
      token.ageSeconds = parsed.ageSeconds;
      token.dex = parsed.dex;
      token.source = parsed.source;
      token.social = parsed.social;
      if (parsed.symbol) token.symbol = parsed.symbol.slice(0, 16);
      if (parsed.name) token.name = parsed.name.slice(0, 48);
    }
    token.volume1hUsd = token.volume1hUsd || raw.volume1hUsd || 0;
    token.priceUsd = (raw.priceUsd ?? 0) > 0 ? raw.priceUsd ?? 0 : 0;
    token.liquidityUsd = (raw.liquidityUsd ?? 0) > 0 ? raw.liquidityUsd ?? 0 : parsed?.liquidityUsd ?? 0;
    if (token.priceUsd > 0) token.priceFeed = raw.priceFeed ?? "listing";
  }

  if (deps.rpcUrl) {
    const reserves = new Set([...pumpReserveAddresses(raw.mint), ...RESERVE_OWNER_SET]);
    const exclude = { addresses: reserves, owners: RESERVE_OWNER_SET };
    const rpcUrl = deps.rpcUrl;
    const readLargest = async () => {
      const largest = await rpc(fetchImpl, rpcUrl, "getTokenLargestAccounts", [raw.mint]);
      const addresses = largestAddresses(largest);
      const multiple =
        addresses.length > 0
          ? await rpc(fetchImpl, rpcUrl, "getMultipleAccounts", [addresses, { encoding: "jsonParsed" }])
          : null;
      return parseTop10Pct(attachTokenOwners(largest, multiple), mint.supplyUi, exclude);
    };

    let holders: { top10HolderPct: number | null; holderCount: number | null } | null = null;
    const pages = deps.holderPagesMax ?? 0;
    if (pages > 0 && isHeliusUrl(rpcUrl)) {
      const full = await readAllHolders(fetchImpl, rpcUrl, raw.mint, pages, deps.dasGapMs ?? 500);
      if (full) {
        const parsedFull = parseHolderAccounts(full.accounts, mint.supplyUi, mint.decimals, exclude, full.truncated);
        if (parsedFull.top10HolderPct != null) {
          if (parsedFull.truncated) {
            const top = await readLargest();
            holders = {
              top10HolderPct: top.top10HolderPct == null ? null : Math.max(parsedFull.top10HolderPct, top.top10HolderPct),
              holderCount: parsedFull.holderCount
            };
          } else {
            holders = parsedFull;
          }
        }
      }
    }
    if (!holders) holders = await readLargest();
    // Rugcheck may already have the higher figure. A later holder read must not lower it.
    if (holders.top10HolderPct != null) {
      token.top10HolderPct =
        token.top10HolderPct == null ? holders.top10HolderPct : Math.max(token.top10HolderPct, holders.top10HolderPct);
    }
    if (holders.holderCount != null) token.holderCount = holders.holderCount;
  }

  token.onBondingCurve = inferOnBondingCurve({ source: token.source, dex: token.dex, riskText });
  return token;
}

async function readAllHolders(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  mint: string,
  maxPages: number,
  gapMs: number
): Promise<{ accounts: TokenAccountRow[]; truncated: boolean } | null> {
  const accounts: TokenAccountRow[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    await dasSlot(gapMs);
    const result = await rpc(fetchImpl, rpcUrl, "getTokenAccounts", { mint, page, limit: DAS_PAGE });
    const rows = (result as { token_accounts?: TokenAccountRow[] } | null)?.token_accounts;
    if (!Array.isArray(rows)) {
      if (page === 1) return null;
      truncated = true;
      break;
    }
    accounts.push(...rows);
    if (rows.length < DAS_PAGE) break;
    if (page === maxPages) truncated = true;
  }
  return { accounts, truncated };
}

function largestAddresses(largest: unknown): string[] {
  const rows = (largest as { value?: Array<{ address?: string }> } | null)?.value;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => row.address).filter((address): address is string => Boolean(address));
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "night-desk/1.0" },
      signal: AbortSignal.timeout(4500)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown): Promise<unknown | null> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "night-desk/1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(4500)
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) return null;
    return body.result ?? null;
  } catch {
    return null;
  }
}
