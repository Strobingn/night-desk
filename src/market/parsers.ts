import { isReserveHolder, pumpReserveAddresses } from "./exclusions.js";
import { holderEntropy } from "./holder-entropy.js";

export interface ParsedMint {
  mintAuthorityRevoked: boolean | null;
  /** An active freeze authority can freeze any holder's account, so sells fail. */
  freezeAuthorityRevoked: boolean | null;
  supplyUi: number | null;
  decimals: number | null;
}

/** SPL mint account, jsonParsed. */
export function parseMintAccount(result: unknown): ParsedMint {
  const info = (
    result as {
      value?: { data?: { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null; supply?: string; decimals?: number } } } };
    }
  )?.value?.data?.parsed?.info;
  if (!info) return { mintAuthorityRevoked: null, freezeAuthorityRevoked: null, supplyUi: null, decimals: null };
  const decimals = typeof info.decimals === "number" ? info.decimals : null;
  let supplyUi: number | null = null;
  if (info.supply != null && decimals != null) {
    const raw = Number(info.supply);
    supplyUi = Number.isFinite(raw) ? raw / 10 ** decimals : null;
  }
  const revoked = info.mintAuthority == null;
  const freezeRevoked = info.freezeAuthority == null;
  return { mintAuthorityRevoked: revoked, freezeAuthorityRevoked: freezeRevoked, supplyUi, decimals };
}

export interface LargestHolderRow {
  address?: string;
  uiAmount?: number | null;
  amount?: string;
  decimals?: number;
  owner?: string | null;
  tag?: string | null;
  label?: string | null;
}

/**
 * Retail top 10 as a fraction of supply.
 * Rows are largest-first. Bonding-curve, LP vault, burn, and other reserve owners are dropped
 * before the top 10 are summed. No rows at all means the data is missing (null, fail closed).
 * Rows that are entirely reserves mean we did measure holders: retail concentration is 0.
 */
export function parseTop10Pct(
  result: unknown,
  supplyUi: number | null,
  exclude: { addresses?: ReadonlySet<string>; owners?: ReadonlySet<string> } = {}
): HolderRead & { excludedReserves: number } {
  const rows = (result as { value?: LargestHolderRow[] })?.value;
  if (!Array.isArray(rows) || !(supplyUi && supplyUi > 0)) {
    return { ...EMPTY_READ, excludedReserves: 0 };
  }
  if (rows.length === 0) {
    return { ...EMPTY_READ, excludedReserves: 0 };
  }
  const retail = rows.filter((row) => !isReserveRow(row, exclude));
  const excludedReserves = rows.length - retail.length;
  const amounts = retail.slice(0, 10).map(rowAmount);
  const sum = amounts.reduce((a, b) => a + b, 0);
  return {
    top10HolderPct: sum / supplyUi,
    holderCount: retail.length,
    ...entropyOf(retail.map(rowAmount)),
    excludedReserves
  };
}

export interface HolderRead {
  top10HolderPct: number | null;
  holderCount: number | null;
  /** Normalized Shannon entropy over the top 25 retail balances. Null when unmeasured. */
  holderEntropy: number | null;
  /** How many balances the entropy was taken over (at most 25). */
  entropyHolders: number | null;
}

const EMPTY_READ: HolderRead = { top10HolderPct: null, holderCount: null, holderEntropy: null, entropyHolders: null };

function entropyOf(balances: number[]): Pick<HolderRead, "holderEntropy" | "entropyHolders"> {
  const positive = balances.filter((b) => b > 0);
  const h = holderEntropy(positive);
  return { holderEntropy: h, entropyHolders: h == null ? null : Math.min(positive.length, 25) };
}

export interface TokenAccountRow {
  address?: string;
  owner?: string | null;
  /** Raw base units, as returned by Helius DAS getTokenAccounts. */
  amount?: number | string;
}

/**
 * Holder stats from a full token-account list, not just the 20 largest accounts.
 * Accounts are summed per owner. Reserve accounts are dropped first.
 */
export function parseHolderAccounts(
  accounts: TokenAccountRow[],
  supplyUi: number | null,
  decimals: number | null,
  exclude: { addresses?: ReadonlySet<string>; owners?: ReadonlySet<string> } = {},
  truncated = false
): HolderRead & { excludedReserves: number; truncated: boolean } {
  if (!(supplyUi && supplyUi > 0) || decimals == null || accounts.length === 0) {
    return { ...EMPTY_READ, excludedReserves: 0, truncated };
  }
  const scale = 10 ** decimals;
  const byOwner = new Map<string, number>();
  let excludedReserves = 0;
  for (const account of accounts) {
    const raw = Number(account.amount);
    if (!(raw > 0) || !Number.isFinite(raw)) continue;
    if (isReserveRow({ address: account.address, owner: account.owner ?? null }, exclude)) {
      excludedReserves += 1;
      continue;
    }
    const who = account.owner || account.address;
    if (!who) continue;
    byOwner.set(who, (byOwner.get(who) ?? 0) + raw / scale);
  }
  const sorted = [...byOwner.values()].sort((a, b) => b - a);
  const sum = sorted.slice(0, 10).reduce((a, b) => a + b, 0);
  return {
    top10HolderPct: sum / supplyUi,
    holderCount: byOwner.size,
    ...entropyOf(sorted),
    excludedReserves,
    truncated
  };
}

function rowAmount(row: LargestHolderRow): number {
  if (typeof row.uiAmount === "number" && Number.isFinite(row.uiAmount)) return row.uiAmount;
  if (row.amount != null && typeof row.decimals === "number") {
    const raw = Number(row.amount);
    return Number.isFinite(raw) ? raw / 10 ** row.decimals : 0;
  }
  return 0;
}

function isReserveRow(row: LargestHolderRow, exclude: { addresses?: ReadonlySet<string>; owners?: ReadonlySet<string> }): boolean {
  if (row.address && exclude.addresses?.has(row.address)) return true;
  if (row.owner && (exclude.owners?.has(row.owner) || exclude.addresses?.has(row.owner))) return true;
  return false;
}

/** Map getMultipleAccounts(jsonParsed) owners back onto largest-account rows, by position. */
export function attachTokenOwners(largest: unknown, multiple: unknown): unknown {
  const rows = (largest as { value?: LargestHolderRow[] })?.value;
  const accounts = (multiple as { value?: Array<{ data?: { parsed?: { info?: { owner?: string } } } } | null> | null })?.value;
  if (!Array.isArray(rows) || !Array.isArray(accounts)) return largest;
  return {
    value: rows.map((row, index) => ({
      ...row,
      owner: accounts[index]?.data?.parsed?.info?.owner ?? row.owner ?? null
    }))
  };
}

export interface ParsedRugcheck {
  mintAuthorityRevoked: boolean | null;
  /** Set to false only when the report says freeze authority is still enabled. */
  freezeAuthorityRevoked: boolean | null;
  lpLockedOrBurned: boolean | null;
  lpLockPct: number | null;
  /** Set only when topHolders could be filtered for reserves. Otherwise null so RPC wins. */
  top10HolderPct: number | null;
  /** True when at least one reported holder was dropped as a curve, vault, or burn account. */
  holdersExcludeReserves: boolean;
  devWallet: string | null;
  devRug: { rugged: boolean; evidence?: string } | null;
  riskText: string;
}

/**
 * Supplemental public RugCheck report. Only positive, explicit fields are trusted.
 * A missing report leaves nulls so Filter can fail closed via on-chain data or rejection.
 */
export function parseRugcheckReport(report: unknown, mint?: string): ParsedRugcheck {
  const data = (report ?? {}) as {
    risks?: Array<{ name?: string; level?: string; description?: string }>;
    markets?: Array<{ lp?: { lpLockedPct?: number }; lpLockedPct?: number }>;
    topHolders?: Array<{
      pct?: number;
      address?: string;
      owner?: string;
      tag?: string;
      label?: string;
      insider?: boolean;
    }>;
    creator?: string;
    creatorAddress?: string;
    rugged?: boolean;
  };
  const risks = Array.isArray(data.risks) ? data.risks : [];
  const names = risks.map((r) => `${r.name ?? ""} ${r.description ?? ""}`.toLowerCase());
  let mintAuthorityRevoked: boolean | null = null;
  // A report that never mentions mint authority says nothing. Null fails closed as still active.
  if (names.some((n) => /mint authority/.test(n) && /enabled|not revoked|still/.test(n))) {
    mintAuthorityRevoked = false;
  }

  let freezeAuthorityRevoked: boolean | null = null;
  if (names.some((n) => /freeze authority/.test(n) && /enabled|not revoked|still/.test(n))) {
    freezeAuthorityRevoked = false;
  }

  // The weakest market decides. One unlocked pool can still be pulled.
  let lpLockPct: number | null = null;
  let lpMissing = false;
  for (const market of data.markets ?? []) {
    const pct = market.lp?.lpLockedPct ?? market.lpLockedPct;
    if (typeof pct === "number" && Number.isFinite(pct)) lpLockPct = lpLockPct == null ? pct : Math.min(lpLockPct, pct);
    else lpMissing = true;
  }
  // A silent market must not be vouched for by the pools we can see. Evidence of an unlock still counts.
  if (lpMissing && lpLockPct != null && lpLockPct >= 95) lpLockPct = null;
  let lpLockedOrBurned: boolean | null = null;
  if (lpLockPct != null) {
    // RugCheck reports a percent (0–100). 1 and 0.96 are about 1%, not a full lock.
    lpLockedOrBurned = lpLockPct >= 95;
  } else if (names.some((n) => /lp/.test(n) && /unlock|not lock|no lock/.test(n))) {
    lpLockedOrBurned = false;
  }

  const holderRead = retailPctFromRugcheck(data.topHolders ?? [], mint ? new Set(pumpReserveAddresses(mint)) : undefined);
  const top10HolderPct = holderRead.top10HolderPct;
  const holdersExcludeReserves = holderRead.excludedReserves;

  const devWallet = data.creator ?? data.creatorAddress ?? null;
  const rugRisk = names.some((n) => /creator|deployer|dev/.test(n) && /rug|scam/.test(n));
  const devRug =
    data.rugged === true || rugRisk
      ? { rugged: true, evidence: data.rugged ? "rugcheck rugged flag" : "rugcheck creator rug risk" }
      : null;

  return {
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    lpLockedOrBurned,
    lpLockPct,
    top10HolderPct,
    holdersExcludeReserves,
    devWallet,
    devRug,
    riskText: names.join("\n")
  };
}

/**
 * RugCheck is preferred only when its holder list identifies reserves (address, owner, or label)
 * so they can be removed. A bare list of percents is not trusted over an excluded on-chain read.
 */
export function retailPctFromRugcheck(
  holders: Array<{ pct?: number; address?: string; owner?: string; tag?: string; label?: string; insider?: boolean }>,
  extraAddresses?: ReadonlySet<string>
): { top10HolderPct: number | null; excludedReserves: boolean } {
  if (!holders.length) return { top10HolderPct: null, excludedReserves: false };
  const identifiable = holders.some((holder) => holder.address || holder.owner || holder.tag || holder.label);
  if (!identifiable) return { top10HolderPct: null, excludedReserves: false };
  const retail = holders.filter((holder) => !isReserveHolder(holder, extraAddresses));
  const excludedReserves = retail.length !== holders.length;
  const slice = retail.slice(0, 10);
  const usesPercent = slice.some((holder) => (holder.pct ?? 0) > 1) || holders.some((holder) => (holder.pct ?? 0) > 1);
  const sum = slice.reduce((total, holder) => total + (typeof holder.pct === "number" ? holder.pct : 0), 0);
  return { top10HolderPct: usesPercent ? sum / 100 : sum, excludedReserves };
}

export function parseDexPair(payload: unknown, mint: string): {
  priceUsd: number;
  liquidityUsd: number;
  volume1hUsd: number;
  marketCapUsd?: number;
  ageSeconds: number;
  pairAddress?: string;
  dex?: string;
  source: "pumpfun" | "raydium";
  social: { mentions1h: number; hasWebsite: boolean; hasTelegram: boolean; hasTwitter: boolean };
  symbol?: string;
  name?: string;
} | null {
  const pairs = (payload as { pairs?: Array<Record<string, unknown>> })?.pairs ?? [];
  const matching = pairs.filter((p) => {
    const base = p.baseToken as { address?: string } | undefined;
    return p.chainId === "solana" && base?.address === mint;
  });
  if (!matching.length) return null;
  matching.sort((a, b) => {
    const la = (a.liquidity as { usd?: number } | undefined)?.usd ?? 0;
    const lb = (b.liquidity as { usd?: number } | undefined)?.usd ?? 0;
    return lb - la;
  });
  const best = matching[0];
  const info = best.info as { websites?: unknown[]; socials?: Array<{ type?: string }> } | undefined;
  const socials = info?.socials ?? [];
  const types = new Set(socials.map((s) => (s.type ?? "").toLowerCase()));
  const created = typeof best.pairCreatedAt === "number" ? best.pairCreatedAt : Date.now();
  const dexId = String(best.dexId ?? "");
  const base = best.baseToken as { symbol?: string; name?: string };
  return {
    priceUsd: Number(best.priceUsd ?? 0) || 0,
    liquidityUsd: Number((best.liquidity as { usd?: number } | undefined)?.usd ?? 0) || 0,
    volume1hUsd: Number((best.volume as { h1?: number } | undefined)?.h1 ?? 0) || 0,
    marketCapUsd: Number(best.marketCap ?? 0) || undefined,
    ageSeconds: Math.max(0, (Date.now() - created) / 1000),
    pairAddress: typeof best.pairAddress === "string" ? best.pairAddress : undefined,
    dex: dexId || undefined,
    source: /pump/i.test(dexId) ? "pumpfun" : "raydium",
    social: {
      mentions1h: 0,
      hasWebsite: Array.isArray(info?.websites) && info.websites.length > 0,
      hasTelegram: types.has("telegram"),
      hasTwitter: types.has("twitter") || types.has("x")
    },
    symbol: base?.symbol,
    name: base?.name
  };
}
