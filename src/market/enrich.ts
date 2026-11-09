import type { CandidateToken, RawSighting } from "../types.js";
import { inferOnBondingCurve, pumpReserveAddresses, RESERVE_OWNER_SET } from "./exclusions.js";
import { ENRICH_CIRCUIT_MS } from "./net.js";
import {
  attachTokenOwners,
  authorityHints,
  parseDexPair,
  parseHolderAccounts,
  parseMintAccount,
  parseRugcheckReport,
  parseTop10Pct,
  type AuthorityHints,
  type ParsedMint,
  type TokenAccountRow
} from "./parsers.js";

export interface EnrichDeps {
  rpcUrl?: string;
  rugcheckUrl?: string;
  fetchImpl?: typeof fetch;
  /** Pages of 1,000 token accounts when the enrich RPC is Helius. 0 keeps the top-20 read. */
  holderPagesMax?: number;
  dasGapMs?: number;
  /** v12.1: batched DexScreener lookup. When absent, one /latest/dex/tokens call per mint. */
  dexLookup?: (mint: string) => Promise<unknown | null>;
  /** Counts enrich RPC attempts only. Wallet and mark reads do not touch this. */
  meter?: EnrichMeter;
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

/** Hostname only. The path and query (where API keys live) are dropped. */
export function rpcHostname(url: string | undefined | null): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The enrich RPC is SOLANA_RPC_URL alone. An empty value means no enrich RPC. */
export function enrichRpcUrls(primary?: string | null): string[] {
  const first = primary?.trim() || "";
  return first ? [first] : [];
}

/** The enrich provider is backing off. The sighting stays pending and is not a filter candidate. */
export class EnrichDeferred extends Error {
  readonly retryMs: number;
  constructor(retryMs = 2_000) {
    super("enrich provider paused");
    this.name = "EnrichDeferred";
    this.retryMs = retryMs;
  }
}

export class EnrichMeter {
  private calls: number[] = [];
  count429 = 0;

  note(status: number, local: boolean): void {
    this.calls.push(Date.now());
    if (status === 429 && !local) this.count429 += 1;
    if (this.calls.length > 4000) this.calls.splice(0, this.calls.length - 2000);
  }

  callsPerMin(now = Date.now()): number {
    while (this.calls.length && this.calls[0]! <= now - 60_000) this.calls.shift();
    return this.calls.length;
  }
}

const emptySocial = { mentions1h: 0, hasWebsite: false, hasTelegram: false, hasTwitter: false };
const emptyHints: AuthorityHints = { mintAuthorityRevoked: null, freezeAuthorityRevoked: null, supplyUi: null, decimals: null };

export async function enrichSighting(raw: RawSighting, deps: EnrichDeps): Promise<CandidateToken> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const urls = enrichRpcUrls(deps.rpcUrl);
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

  // Dex and RugCheck do not depend on each other. RugCheck is optional: tape enrich
  // leaves it unset and the filter path calls it later, at about 1 request/second.
  const rugUrl = deps.rugcheckUrl ? `${deps.rugcheckUrl.replace(/\/$/, "")}/tokens/${raw.mint}/report` : null;
  const [dex, report] = await Promise.all([
    deps.dexLookup ? deps.dexLookup(raw.mint).catch(() => null) : fetchJson(fetchImpl, `https://api.dexscreener.com/latest/dex/tokens/${raw.mint}`),
    rugUrl ? fetchJson(fetchImpl, rugUrl) : Promise.resolve(null)
  ]);

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

  const dexHints = dex ? hintsFromDex(dex, raw.mint) : emptyHints;
  const rugHints = report ? authorityHints(report) : emptyHints;
  const knownMint = rugHints.mintAuthorityRevoked ?? dexHints.mintAuthorityRevoked;
  const knownFreeze = rugHints.freezeAuthorityRevoked ?? dexHints.freezeAuthorityRevoked;
  const knownSupply = rugHints.supplyUi ?? dexHints.supplyUi;
  const knownDecimals = rugHints.decimals ?? dexHints.decimals;
  const skipMint = urls.length > 0 && knownMint != null && knownFreeze != null && knownSupply != null && knownSupply > 0;

  let mint: ParsedMint = { mintAuthorityRevoked: null, freezeAuthorityRevoked: null, supplyUi: null, decimals: null };
  if (urls.length > 0 && !skipMint) {
    const mintInfo = await rpc(fetchImpl, urls, "getAccountInfo", [raw.mint, { encoding: "jsonParsed" }], deps.meter);
    mint = parseMintAccount(mintInfo);
  }
  if (mint.mintAuthorityRevoked == null && knownMint != null) mint.mintAuthorityRevoked = knownMint;
  if (mint.freezeAuthorityRevoked == null && knownFreeze != null) mint.freezeAuthorityRevoked = knownFreeze;
  if (mint.supplyUi == null && knownSupply != null && knownSupply > 0) mint.supplyUi = knownSupply;
  if (mint.decimals == null && knownDecimals != null) mint.decimals = knownDecimals;
  if (mint.mintAuthorityRevoked != null) token.mintAuthorityRevoked = mint.mintAuthorityRevoked;
  if (mint.decimals != null) token.decimals = mint.decimals;

  if (urls.length > 0) {
    const reserves = new Set([...pumpReserveAddresses(raw.mint), ...RESERVE_OWNER_SET]);
    const exclude = { addresses: reserves, owners: RESERVE_OWNER_SET };
    const readLargest = async () => {
      const largest = await rpc(fetchImpl, urls, "getTokenLargestAccounts", [raw.mint], deps.meter);
      const addresses = largestAddresses(largest);
      const multiple =
        addresses.length > 0
          ? await rpc(fetchImpl, urls, "getMultipleAccounts", [addresses, { encoding: "jsonParsed" }], deps.meter)
          : null;
      return parseTop10Pct(attachTokenOwners(largest, multiple), mint.supplyUi, exclude);
    };

    let holders: { top10HolderPct: number | null; holderCount: number | null } | null = null;
    const pages = deps.holderPagesMax ?? 0;
    const heliusPrimary = urls[0] && isHeliusUrl(urls[0]) ? urls[0] : "";
    if (pages > 0 && heliusPrimary) {
      const full = await readAllHolders(fetchImpl, heliusPrimary, raw.mint, pages, deps.dasGapMs ?? 500, deps.meter);
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
    if (holders.top10HolderPct != null) token.top10HolderPct = holders.top10HolderPct;
    if (holders.holderCount != null) token.holderCount = holders.holderCount;
  }

  let riskText = "";
  if (report) {
    riskText = parseRugcheckReport(report, raw.mint).riskText;
    mergeRug(token, report, raw.mint);
  }
  token.onBondingCurve = inferOnBondingCurve({ source: token.source, dex: token.dex, riskText });
  return token;
}

let rugNextAt = 0;

/** About one RugCheck request per second. Tape enrich does not call this. */
async function rugSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, rugNextAt);
  rugNextAt = at + 1_000;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

/** True when a sighting is past the volume floor and still missing a RugCheck field the filter needs. */
export function needsFilterRugcheck(token: CandidateToken, minVolume1hUsd: number): boolean {
  if (!(token.volume1hUsd >= minVolume1hUsd)) return false;
  return token.mintAuthorityRevoked == null || token.lpLockedOrBurned == null || token.top10HolderPct == null;
}

/** One RugCheck report for a coin that reached the filter. Failures leave the token unchanged. */
export async function applyRugcheck(
  token: CandidateToken,
  deps: { rugcheckUrl?: string; fetchImpl?: typeof fetch }
): Promise<CandidateToken> {
  if (!deps.rugcheckUrl) return token;
  await rugSlot();
  const url = `${deps.rugcheckUrl.replace(/\/$/, "")}/tokens/${token.mint}/report`;
  const report = await fetchJson(deps.fetchImpl ?? fetch, url);
  if (!report) return token;
  mergeRug(token, report, token.mint);
  const rug = parseRugcheckReport(report, token.mint);
  token.onBondingCurve = inferOnBondingCurve({ source: token.source, dex: token.dex, riskText: rug.riskText });
  return token;
}

function mergeRug(token: CandidateToken, report: unknown, mint: string): void {
  const rug = parseRugcheckReport(report, mint);
  if (token.mintAuthorityRevoked == null && rug.mintAuthorityRevoked != null) {
    token.mintAuthorityRevoked = rug.mintAuthorityRevoked;
  }
  if (rug.lpLockedOrBurned != null) token.lpLockedOrBurned = rug.lpLockedOrBurned;
  if (rug.lpLockPct != null) token.lpLockPct = rug.lpLockPct;
  if (rug.top10HolderPct != null) {
    token.top10HolderPct = token.top10HolderPct == null ? rug.top10HolderPct : Math.max(token.top10HolderPct, rug.top10HolderPct);
  }
  if (!token.devWallet && rug.devWallet) token.devWallet = rug.devWallet;
  if (rug.devHoldingPct != null) token.devHoldingPct = rug.devHoldingPct;
  if (rug.devRug) token.devRug = rug.devRug;
}

function hintsFromDex(payload: unknown, mint: string): AuthorityHints {
  const pairs = (payload as { pairs?: Array<Record<string, unknown>> })?.pairs ?? [];
  const matching = pairs.filter((pair) => {
    const base = pair.baseToken as { address?: string } | undefined;
    return pair.chainId === "solana" && base?.address === mint;
  });
  if (!matching.length) return emptyHints;
  matching.sort((a, b) => {
    const la = (a.liquidity as { usd?: number } | undefined)?.usd ?? 0;
    const lb = (b.liquidity as { usd?: number } | undefined)?.usd ?? 0;
    return lb - la;
  });
  const best = matching[0]!;
  const hinted = authorityHints(best);
  if (!(hinted.supplyUi != null && hinted.supplyUi > 0)) {
    const price = Number(best.priceUsd ?? 0) || 0;
    const cap = Number(best.marketCap ?? 0) || 0;
    if (price > 0 && cap > 0) hinted.supplyUi = cap / price;
  }
  return hinted;
}

async function readAllHolders(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  mint: string,
  maxPages: number,
  gapMs: number,
  meter?: EnrichMeter
): Promise<{ accounts: TokenAccountRow[]; truncated: boolean } | null> {
  const accounts: TokenAccountRow[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    await dasSlot(gapMs);
    const result = await rpc(fetchImpl, [rpcUrl], "getTokenAccounts", { mint, page, limit: DAS_PAGE }, meter);
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

type RpcOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "miss" }
  | { kind: "down"; retryMs: number };

async function rpc(
  fetchImpl: typeof fetch,
  urls: string[],
  method: string,
  params: unknown,
  meter?: EnrichMeter
): Promise<unknown | null> {
  if (!urls.length) return null;
  let down = 0;
  let answered = false;
  let retryMs = 2_000;
  for (const url of urls) {
    const outcome = await rpcOnce(fetchImpl, url, method, params, meter);
    if (outcome.kind === "ok") return outcome.result;
    if (outcome.kind === "down") {
      down += 1;
      retryMs = Math.max(retryMs, outcome.retryMs);
      continue;
    }
    answered = true;
  }
  if (!answered && down > 0) throw new EnrichDeferred(retryMs);
  return null;
}

async function rpcOnce(
  fetchImpl: typeof fetch,
  url: string,
  method: string,
  params: unknown,
  meter?: EnrichMeter
): Promise<RpcOutcome> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "night-desk/1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(4500)
    });
    const local = res.headers.get("x-nd-local") === "1";
    meter?.note(res.status, local);
    if (res.status === 429 || res.status >= 500) {
      const circuit = res.headers.get("x-nd-circuit") === "1";
      return { kind: "down", retryMs: circuit ? ENRICH_CIRCUIT_MS : 2_000 };
    }
    if (!res.ok) return { kind: "miss" };
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) return { kind: "miss" };
    return { kind: "ok", result: body.result ?? null };
  } catch {
    return { kind: "down", retryMs: 2_000 };
  }
}
