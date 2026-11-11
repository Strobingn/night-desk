import { isReserveHolder, pumpReserveAddresses } from "./exclusions.js";

/** getTokenLargestAccounts returns at most this many accounts. */
export const LARGEST_HOLDER_CAP = 20;

/** A share above 100% is a bad supply, not a real concentration. Null fails closed. */
function shareOf(sum: number, supplyUi: number): number | null {
  const pct = sum / supplyUi;
  if (!Number.isFinite(pct) || pct < 0) return null;
  if (pct > 1 + 1e-8) return null;
  return Math.min(1, pct);
}

export interface ParsedMint {
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  supplyUi: number | null;
  decimals: number | null;
}

/** SPL mint account, jsonParsed. */
export function parseMintAccount(result: unknown): ParsedMint {
  const info = (
    result as {
      value?: { data?: { parsed?: { info?: { mintAuthority?: string | null; supply?: string; decimals?: number } } } };
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
  const freeze = (info as { freezeAuthority?: string | null }).freezeAuthority;
  return { mintAuthorityRevoked: revoked, freezeAuthorityRevoked: freeze == null, supplyUi, decimals };
}

export interface AuthorityHints {
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  supplyUi: number | null;
  decimals: number | null;
}

/** Explicit mint/freeze fields only. A missing field stays null so Filter still fails closed. */
export function authorityHints(source: unknown): AuthorityHints {
  const empty: AuthorityHints = { mintAuthorityRevoked: null, freezeAuthorityRevoked: null, supplyUi: null, decimals: null };
  if (!source || typeof source !== "object") return empty;
  const root = source as Record<string, unknown>;
  const bags = [root, record(root.token), record(root.tokenMeta), record(root.baseToken), record(root.info), record(root.audit)].filter(
    (bag): bag is Record<string, unknown> => bag != null
  );
  let mint: boolean | null = null;
  let freeze: boolean | null = null;
  let decimals: number | null = null;
  for (const bag of bags) {
    if (mint == null) mint = revokedField(bag, "mintAuthority", "mintAuthorityDisabled");
    if (freeze == null) freeze = revokedField(bag, "freezeAuthority", "freezeAuthorityDisabled");
    if (decimals == null && typeof bag.decimals === "number" && Number.isFinite(bag.decimals)) decimals = bag.decimals;
  }
  let supplyUi: number | null = null;
  for (const bag of bags) {
    if (supplyUi == null) supplyUi = supplyField(bag, decimals);
  }
  return { mintAuthorityRevoked: mint, freezeAuthorityRevoked: freeze, supplyUi, decimals };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function revokedField(bag: Record<string, unknown>, key: string, disabledKey: string): boolean | null {
  if (disabledKey in bag && typeof bag[disabledKey] === "boolean") return bag[disabledKey] === true;
  if (!(key in bag)) return null;
  const value = bag[key];
  if (value == null || value === "") return true;
  if (typeof value === "string") return false;
  return null;
}

function supplyField(bag: Record<string, unknown>, decimals: number | null): number | null {
  const raw = bag.supply;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  if (decimals != null && Number.isInteger(raw)) return raw / 10 ** decimals;
  return raw > 0 ? raw : null;
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
): { top10HolderPct: number | null; holderCount: number | null; excludedReserves: number; holderCountAtLeast: boolean } {
  const empty = { top10HolderPct: null, holderCount: null, excludedReserves: 0, holderCountAtLeast: false };
  const rows = (result as { value?: LargestHolderRow[] })?.value;
  if (!Array.isArray(rows) || !(supplyUi && supplyUi > 0)) return empty;
  if (rows.length === 0) return empty;
  const retail = rows.filter((row) => !isReserveRow(row, exclude));
  const excludedReserves = rows.length - retail.length;
  const amounts = retail.slice(0, 10).map(rowAmount);
  const sum = amounts.reduce((a, b) => a + b, 0);
  // A full page of 20 real holders is the RPC cap, not the whole set. Count it as 20+.
  const holderCountAtLeast = rows.length >= LARGEST_HOLDER_CAP && excludedReserves === 0 && retail.length >= LARGEST_HOLDER_CAP;
  return {
    top10HolderPct: shareOf(sum, supplyUi),
    holderCount: retail.length,
    excludedReserves,
    holderCountAtLeast
  };
}

export interface DevShare {
  /** Fraction of supply. Null when no bound can be computed, including a share above 100%. */
  pct: number | null;
  /** True when the dev was absent from a full top 20 and pct is the 20th account's share. */
  upperBound: boolean;
}

/**
 * Dev share from getTokenLargestAccounts.
 * A matching owner (or the wallet as the account address) is an exact share.
 * Missing from a full top 20 means the dev holds at most the smallest of those balances.
 * Missing from a shorter list means the dev holds none of the supply. No rows, no wallet,
 * or a share above 100% stays null so the dev gate can fail closed.
 */
export function devShareFromLargest(result: unknown, supplyUi: number | null, devWallet: string | null | undefined): DevShare {
  const none: DevShare = { pct: null, upperBound: false };
  if (!devWallet || !(supplyUi && supplyUi > 0)) return none;
  const rows = (result as { value?: LargestHolderRow[] })?.value;
  if (!Array.isArray(rows) || rows.length === 0) return none;
  const owned = rows.filter((row) => row.owner === devWallet || row.address === devWallet);
  let raw: number;
  let upperBound = false;
  if (owned.length > 0) {
    raw = owned.reduce((sum, row) => sum + rowAmount(row), 0);
  } else if (rows.length >= LARGEST_HOLDER_CAP) {
    raw = rows.reduce((min, row) => Math.min(min, rowAmount(row)), Number.POSITIVE_INFINITY);
    upperBound = true;
  } else {
    raw = 0;
  }
  if (!Number.isFinite(raw) || raw < 0) return none;
  const pct = shareOf(raw, supplyUi);
  if (pct == null) return none;
  return { pct, upperBound };
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
): { top10HolderPct: number | null; holderCount: number | null; excludedReserves: number; truncated: boolean } {
  if (!(supplyUi && supplyUi > 0) || decimals == null || accounts.length === 0) {
    return { top10HolderPct: null, holderCount: null, excludedReserves: 0, truncated };
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
  const top10 = [...byOwner.values()].sort((a, b) => b - a).slice(0, 10);
  const sum = top10.reduce((a, b) => a + b, 0);
  return { top10HolderPct: shareOf(sum, supplyUi), holderCount: byOwner.size, excludedReserves, truncated };
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
  lpLockedOrBurned: boolean | null;
  lpLockPct: number | null;
  /** Set only when topHolders could be filtered for reserves. Otherwise null so RPC wins. */
  top10HolderPct: number | null;
  /** True when at least one reported holder was dropped as a curve, vault, or burn account. */
  holdersExcludeReserves: boolean;
  devWallet: string | null;
  devHoldingPct: number | null;
  devRug: { rugged: boolean; evidence?: string } | null;
  riskText: string;
}

/**
 * Supplemental public RugCheck report. Only positive, explicit fields are trusted.
 * A missing report leaves nulls so Filter can fail closed via on-chain data or rejection.
 */
export function parseRugcheckReport(report: unknown, mint?: string, extraAddresses?: readonly string[]): ParsedRugcheck {
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
  const hinted = authorityHints(data);
  let mintAuthorityRevoked: boolean | null = hinted.mintAuthorityRevoked;
  // A report that never mentions mint authority says nothing. Null fails closed as still active.
  if (mintAuthorityRevoked == null && names.some((n) => /mint authority/.test(n) && /enabled|not revoked|still/.test(n))) {
    mintAuthorityRevoked = false;
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

  const reserves = new Set<string>([...(mint ? pumpReserveAddresses(mint) : []), ...(extraAddresses ?? [])]);
  const holderRead = retailPctFromRugcheck(data.topHolders ?? [], reserves);
  const top10HolderPct = holderRead.top10HolderPct;
  const holdersExcludeReserves = holderRead.excludedReserves;

  const devWallet = data.creator ?? data.creatorAddress ?? null;
  let devHoldingPct: number | null = null;
  if (devWallet && Array.isArray(data.topHolders)) {
    const hit = data.topHolders.find((holder) => holder.address === devWallet || holder.owner === devWallet);
    if (hit && typeof hit.pct === "number" && Number.isFinite(hit.pct)) {
      const fraction = hit.pct > 1 ? hit.pct / 100 : hit.pct;
      devHoldingPct = fraction > 1 ? null : fraction;
    }
  }
  const rugRisk = names.some((n) => /creator|deployer|dev/.test(n) && /rug|scam/.test(n));
  const devRug =
    data.rugged === true || rugRisk
      ? { rugged: true, evidence: data.rugged ? "rugcheck rugged flag" : "rugcheck creator rug risk" }
      : null;

  return {
    mintAuthorityRevoked,
    lpLockedOrBurned,
    lpLockPct,
    top10HolderPct,
    holdersExcludeReserves,
    devWallet,
    devHoldingPct,
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
  const fraction = usesPercent ? sum / 100 : sum;
  return { top10HolderPct: fraction > 1 + 1e-8 ? null : Math.min(1, fraction), excludedReserves };
}

/** Every Solana pair address DexScreener returned for this mint. Pool vaults sit on these accounts. */
export function dexPairAddresses(payload: unknown, mint: string): string[] {
  const pairs = (payload as { pairs?: Array<Record<string, unknown>> })?.pairs ?? [];
  const out: string[] = [];
  for (const pair of pairs) {
    const base = pair.baseToken as { address?: string } | undefined;
    if (pair.chainId !== "solana" || base?.address !== mint) continue;
    if (typeof pair.pairAddress === "string" && pair.pairAddress) out.push(pair.pairAddress);
  }
  return out;
}

export function parseDexPair(payload: unknown, mint: string): {
  priceUsd: number;
  liquidityUsd: number;
  volume1hUsd: number;
  volume5mUsd?: number;
  priceChange1hPct?: number;
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
  const volume1hUsd = matching.reduce((max, pair) => Math.max(max, pairHourVolume(pair)), 0);
  const volume5mUsd = matching.reduce((max, pair) => Math.max(max, finite((pair.volume as { m5?: unknown } | undefined)?.m5)), 0);
  const changeRaw = (best.priceChange as { h1?: unknown } | undefined)?.h1;
  const change = typeof changeRaw === "number" || (typeof changeRaw === "string" && changeRaw.trim() !== "") ? Number(changeRaw) : NaN;
  return {
    volume5mUsd: volume5mUsd > 0 ? volume5mUsd : undefined,
    priceChange1hPct: Number.isFinite(change) ? change : undefined,
    priceUsd: Number(best.priceUsd ?? 0) || 0,
    liquidityUsd: Number((best.liquidity as { usd?: number } | undefined)?.usd ?? 0) || 0,
    volume1hUsd,
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

/** Real 1h volume from a DexScreener pair. A pool younger than an hour often only fills h24. */
export function pairHourVolume(pair: Record<string, unknown>, now = Date.now()): number {
  const vol = pair.volume as { h1?: unknown; h24?: unknown } | undefined;
  const h1 = finite(vol?.h1);
  if (h1 > 0) return h1;
  const created = typeof pair.pairCreatedAt === "number" ? pair.pairCreatedAt : 0;
  const ageMs = created > 0 ? now - created : Number.POSITIVE_INFINITY;
  if (ageMs >= 0 && ageMs <= 60 * 60 * 1000) {
    const h24 = finite(vol?.h24);
    if (h24 > 0) return h24;
  }
  return 0;
}

function finite(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}
