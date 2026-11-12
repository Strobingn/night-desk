import type { CandidateToken, RawSighting } from "../types.js";
import { holderExclusions, inferOnBondingCurve } from "./exclusions.js";
import { ENRICH_CIRCUIT_MS } from "./net.js";
import {
  attachTokenOwners,
  authorityHints,
  devShareFromLargest,
  dexPairAddresses,
  parseDexPair,
  parseHolderAccounts,
  parseMintAccount,
  parseRugcheckReport,
  parseTop10Pct,
  type AuthorityHints,
  type LargestHolderRow,
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
  /** Lookup already fetched Dex. Skip a second call and reuse this payload (null is a miss). */
  skipDex?: boolean;
  dexPayload?: unknown | null;
  /** Fires when the Dex body arrives, including a miss, so lookup can reuse it. */
  onDex?: (payload: unknown | null) => void;
  /**
   * Wall-clock budget for the whole enrich. When it fires, fields that already landed
   * are returned and the rest stay null. RugCheck and RPC do not wait on each other.
   */
  budgetMs?: number;
  /** Providers that answered, and whether the budget won. Lookup writes this onto the event. */
  note?: EnrichNote;
}

/** Which outside calls returned a body during this enrich. */
export interface EnrichNote {
  providers: string[];
  timedOut: boolean;
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

function noteProvider(note: EnrichNote | undefined, name: string): void {
  if (!note) return;
  if (!note.providers.includes(name)) note.providers.push(name);
}

function cloneToken(token: CandidateToken): CandidateToken {
  return {
    ...token,
    social: { ...token.social },
    ...(token.poolAddresses ? { poolAddresses: [...token.poolAddresses] } : {}),
    ...(token.holderSample
      ? { holderSample: { supplyUi: token.holderSample.supplyUi, rows: token.holderSample.rows.map((row) => ({ ...row })) } }
      : {}),
    ...(token.devRug ? { devRug: { ...token.devRug } } : {})
  };
}

/**
 * Dex, RugCheck, and Alchemy run together. A slow RugCheck cannot stop getAccountInfo,
 * and a timed-out call keeps whatever already landed instead of returning an all-null chain.
 * Tape enrich still omits RugCheck; the filter calls it afterwards.
 */
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
  const budgetCtrl = new AbortController();
  const signal = budgetCtrl.signal;
  let deferred: EnrichDeferred | null = null;
  let riskText = "";
  const catchDeferred = (err: unknown): null => {
    if (err instanceof EnrichDeferred) deferred = err;
    return null;
  };

  const dexTask = (async (): Promise<unknown | null> => {
    const dex = deps.skipDex
      ? (deps.dexPayload ?? null)
      : deps.dexLookup
        ? await deps.dexLookup(raw.mint).catch(() => null)
        : await fetchJson(fetchImpl, `https://api.dexscreener.com/latest/dex/tokens/${raw.mint}`, signal);
    deps.onDex?.(dex);
    if (dex) noteProvider(deps.note, "dex");
    applyDexPayload(token, dex, raw);
    return dex;
  })();

  const rugUrl = deps.rugcheckUrl ? `${deps.rugcheckUrl.replace(/\/$/, "")}/tokens/${raw.mint}/report` : null;
  const rugTask = (async (): Promise<unknown | null> => {
    if (!rugUrl) return null;
    const report = await fetchJson(fetchImpl, rugUrl, signal);
    if (report) noteProvider(deps.note, "rugcheck");
    return report;
  })();

  const mintTask = (async (): Promise<ParsedMint> => {
    const blank: ParsedMint = { mintAuthorityRevoked: null, freezeAuthorityRevoked: null, supplyUi: null, decimals: null };
    if (!urls.length) return blank;
    try {
      const mintInfo = await rpc(fetchImpl, urls, "getAccountInfo", [raw.mint, { encoding: "jsonParsed" }], deps.meter, signal);
      noteProvider(deps.note, "rpc:getAccountInfo");
      return parseMintAccount(mintInfo);
    } catch (err) {
      catchDeferred(err);
      return blank;
    }
  })();

  // On-chain mint is applied as soon as getAccountInfo returns. It does not wait for RugCheck.
  const mintApply = mintTask.then((mint) => {
    if (mint.mintAuthorityRevoked != null) token.mintAuthorityRevoked = mint.mintAuthorityRevoked;
    if (mint.freezeAuthorityRevoked != null) token.freezeAuthorityRevoked = mint.freezeAuthorityRevoked;
    if (mint.decimals != null) token.decimals = mint.decimals;
  });

  const holdersTask = (async () => {
    if (!urls.length) return;
    const pages = deps.holderPagesMax ?? 0;
    const heliusPrimary = urls[0] && isHeliusUrl(urls[0]) ? urls[0] : "";
    const wantLargestNow = !(pages > 0 && heliusPrimary);
    const largestPromise = wantLargestNow
      ? rpc(fetchImpl, urls, "getTokenLargestAccounts", [raw.mint], deps.meter, signal)
          .then((largest) => {
            noteProvider(deps.note, "rpc:getTokenLargestAccounts");
            return largest;
          })
          .catch(catchDeferred)
      : Promise.resolve(null);
    const pagesPromise =
      pages > 0 && heliusPrimary
        ? readAllHolders(fetchImpl, heliusPrimary, raw.mint, pages, deps.dasGapMs ?? 500, deps.meter, signal).catch(catchDeferred)
        : Promise.resolve(null);

    const largestFirst = await largestPromise;
    let multiple: unknown = null;
    if (wantLargestNow) {
      const addresses = largestAddresses(largestFirst);
      if (addresses.length) {
        multiple = await rpc(fetchImpl, urls, "getMultipleAccounts", [addresses, { encoding: "jsonParsed" }], deps.meter, signal).catch(catchDeferred);
        if (multiple) noteProvider(deps.note, "rpc:getMultipleAccounts");
      }
    }
    const [mint, full] = await Promise.all([mintTask, pagesPromise]);
    await dexTask;
    const pools = token.poolAddresses ?? [];
    const exclude = holderExclusions(raw.mint, pools);
    const readLargest = async (prefetched: unknown) => {
      const largest =
        prefetched ??
        (await rpc(fetchImpl, urls, "getTokenLargestAccounts", [raw.mint], deps.meter, signal).catch(catchDeferred));
      if (largest && prefetched == null) noteProvider(deps.note, "rpc:getTokenLargestAccounts");
      const addresses = largestAddresses(largest);
      const accounts =
        prefetched != null
          ? multiple
          : addresses.length
            ? await rpc(fetchImpl, urls, "getMultipleAccounts", [addresses, { encoding: "jsonParsed" }], deps.meter, signal).catch(catchDeferred)
            : null;
      if (accounts && prefetched == null) noteProvider(deps.note, "rpc:getMultipleAccounts");
      const ownersRead = multipleOwnersRead(accounts);
      const attached = ownersRead ? attachTokenOwners(largest, accounts) : largest;
      if (ownersRead) {
        const rows = (attached as { value?: LargestHolderRow[] })?.value;
        token.holderSample = { supplyUi: mint.supplyUi, rows: Array.isArray(rows) ? rows : [] };
      }
      return parseTop10Pct(attached, mint.supplyUi, exclude);
    };

    let holders: { top10HolderPct: number | null; holderCount: number | null; holderCountAtLeast?: boolean } | null = null;
    if (full) {
      const parsedFull = parseHolderAccounts(full.accounts, mint.supplyUi, mint.decimals, exclude, full.truncated);
      if (parsedFull.top10HolderPct != null || parsedFull.holderCount != null) {
        if (parsedFull.truncated) {
          const top = await readLargest(null);
          holders = {
            top10HolderPct:
              top.top10HolderPct == null
                ? parsedFull.top10HolderPct
                : parsedFull.top10HolderPct == null
                  ? top.top10HolderPct
                  : Math.max(parsedFull.top10HolderPct, top.top10HolderPct),
            holderCount: parsedFull.holderCount,
            holderCountAtLeast: false
          };
        } else {
          holders = parsedFull;
        }
      }
    }
    if (!holders) holders = await readLargest(wantLargestNow ? largestFirst : null);
    if (holders.top10HolderPct != null) {
      const prior = token.top10HolderPct;
      token.top10HolderPct = prior == null ? holders.top10HolderPct : Math.max(prior, holders.top10HolderPct);
    }
    if (holders.holderCount != null) {
      token.holderCount = holders.holderCount;
      token.holderCountAtLeast = holders.holderCountAtLeast === true;
    }
  })().catch(catchDeferred);

  // RugCheck merges after Dex so pool vaults are known. The HTTP call itself already started.
  const rugApply = (async () => {
    const [report] = await Promise.all([rugTask, dexTask]);
    if (!report) return;
    const pools = token.poolAddresses ?? [];
    riskText = parseRugcheckReport(report, raw.mint, pools).riskText;
    mergeRug(token, report, raw.mint, pools);
  })().catch(() => undefined);

  // Rug or Dex may name a revoked mint when the account read missed. They never wipe an on-chain answer.
  const hintApply = (async () => {
    const [mint, dex, report] = await Promise.all([mintTask, dexTask, rugTask]);
    const dexHints = dex ? hintsFromDex(dex, raw.mint) : emptyHints;
    const rugHints = report ? authorityHints(report) : emptyHints;
    if (token.mintAuthorityRevoked == null) {
      const known = rugHints.mintAuthorityRevoked ?? dexHints.mintAuthorityRevoked;
      if (known != null) token.mintAuthorityRevoked = known;
    }
    if (token.freezeAuthorityRevoked == null) {
      const known = rugHints.freezeAuthorityRevoked ?? dexHints.freezeAuthorityRevoked;
      if (known != null) token.freezeAuthorityRevoked = known;
    }
    if (token.decimals == null) {
      const known = rugHints.decimals ?? dexHints.decimals ?? mint.decimals;
      if (known != null) token.decimals = known;
    }
  })().catch(() => undefined);

  const tasks = [dexTask, mintApply, holdersTask, rugApply, hintApply];
  let finished = false;
  const all = Promise.all(tasks).then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    }
  );
  if (deps.budgetMs != null && Number.isFinite(deps.budgetMs)) {
    const ms = Math.max(0, deps.budgetMs);
    await Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
    if (!finished) {
      if (deps.note) deps.note.timedOut = true;
      budgetCtrl.abort();
    }
  } else {
    await all;
  }
  const snap = cloneToken(token);
  fillDevShare(snap);
  snap.onBondingCurve = inferOnBondingCurve({ source: snap.source, dex: snap.dex, riskText });
  if (deferred && snap.mintAuthorityRevoked == null && snap.top10HolderPct == null && !deps.note?.timedOut) throw deferred;
  return snap;
}

function applyDexPayload(token: CandidateToken, dex: unknown | null, raw: RawSighting): void {
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
  const pools = dex ? dexPairAddresses(dex, raw.mint) : [];
  if (pools.length) token.poolAddresses = pools;
}

let rugNextAt = 0;

/** About one RugCheck request per second. Tape enrich does not call this. */
async function rugSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, rugNextAt);
  rugNextAt = at + 1_000;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

/**
 * True when a sighting is past the volume floor and still missing a RugCheck field the filter needs.
 * A dev limit with no share (and no top-20 bound) is one of those fields.
 */
export function needsFilterRugcheck(token: CandidateToken, minVolume1hUsd: number, maxDevHoldingPct = 0): boolean {
  if (!(token.volume1hUsd >= minVolume1hUsd)) return false;
  const devMissing = maxDevHoldingPct > 0 && !(typeof token.devHoldingPct === "number" && Number.isFinite(token.devHoldingPct));
  return token.mintAuthorityRevoked == null || token.lpLockedOrBurned == null || token.top10HolderPct == null || devMissing;
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
  mergeRug(token, report, token.mint, token.poolAddresses);
  fillDevShare(token);
  const rug = parseRugcheckReport(report, token.mint, token.poolAddresses);
  token.onBondingCurve = inferOnBondingCurve({ source: token.source, dex: token.dex, riskText: rug.riskText });
  return token;
}

/** True when getMultipleAccounts returned at least one token-account owner. */
function multipleOwnersRead(multiple: unknown): boolean {
  const value = (multiple as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const owner = (entry as { data?: { parsed?: { info?: { owner?: unknown } } } } | null)?.data?.parsed?.info?.owner;
    return typeof owner === "string" && owner.length > 0;
  });
}

function fillDevShare(token: CandidateToken): void {
  if (typeof token.devHoldingPct === "number" && Number.isFinite(token.devHoldingPct)) return;
  if (!token.devWallet || !token.holderSample) return;
  const share = devShareFromLargest({ value: token.holderSample.rows }, token.holderSample.supplyUi, token.devWallet);
  if (share.pct == null) return;
  token.devHoldingPct = share.pct;
  token.devHoldingUpperBound = share.upperBound;
}

function mergeRug(token: CandidateToken, report: unknown, mint: string, pools?: readonly string[]): void {
  const rug = parseRugcheckReport(report, mint, pools);
  if (token.mintAuthorityRevoked == null && rug.mintAuthorityRevoked != null) {
    token.mintAuthorityRevoked = rug.mintAuthorityRevoked;
  }
  if (rug.lpLockedOrBurned != null) token.lpLockedOrBurned = rug.lpLockedOrBurned;
  if (rug.lpLockPct != null) token.lpLockPct = rug.lpLockPct;
  if (rug.lpPool) token.lpLockPool = rug.lpPool;
  if (rug.top10HolderPct != null) {
    token.top10HolderPct = token.top10HolderPct == null ? rug.top10HolderPct : Math.max(token.top10HolderPct, rug.top10HolderPct);
  }
  if (!token.devWallet && rug.devWallet) token.devWallet = rug.devWallet;
  if (rug.devHoldingPct != null) {
    token.devHoldingPct = rug.devHoldingPct;
    token.devHoldingUpperBound = false;
  }
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
  // Market cap / price is not a mint supply. It has produced shares above 100%.
  // On-chain getAccountInfo supply is used instead, and only an explicit supply field is a fallback.
  return authorityHints(best);
}

async function readAllHolders(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  mint: string,
  maxPages: number,
  gapMs: number,
  meter?: EnrichMeter,
  signal?: AbortSignal
): Promise<{ accounts: TokenAccountRow[]; truncated: boolean } | null> {
  const accounts: TokenAccountRow[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    await dasSlot(gapMs);
    const result = await rpc(fetchImpl, [rpcUrl], "getTokenAccounts", { mint, page, limit: DAS_PAGE }, meter, signal);
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

async function fetchJson(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<unknown | null> {
  try {
    const timeout = AbortSignal.timeout(4500);
    const res = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "night-desk/1.0" },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout
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
  meter?: EnrichMeter,
  signal?: AbortSignal
): Promise<unknown | null> {
  if (!urls.length) return null;
  let down = 0;
  let answered = false;
  let retryMs = 2_000;
  for (const url of urls) {
    const outcome = await rpcOnce(fetchImpl, url, method, params, meter, signal);
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
  meter?: EnrichMeter,
  signal?: AbortSignal
): Promise<RpcOutcome> {
  try {
    const timeout = AbortSignal.timeout(4500);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "night-desk/1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout
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
