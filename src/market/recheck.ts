import type { CandidateToken, Rejection } from "../types.js";
import { isHeliusUrl, enrichSighting, type EnrichDeps } from "./enrich.js";

/** One soft-fail recheck lands in this window. */
export const RECHECK_DELAY_MIN_MS = 3 * 60_000;
export const RECHECK_DELAY_MAX_MS = 5 * 60_000;
export const RECHECK_QUEUE_MAX = 300;

/** Gates a young coin can miss because the print is empty, not because it is a rug. */
export const SOFT_RECHECK_CODES = new Set(["VOLUME_TOO_LOW", "LIQUIDITY_TOO_THIN", "HOLDER_COUNT", "HOLDER_CONCENTRATION"]);

/**
 * One later look only when every miss is a soft gate.
 * Mint authority, an active freeze, a dev rug, and an unlocked LP are not retried.
 */
export function recheckEligible(
  token: { freezeAuthorityRevoked?: boolean | null },
  reasons: ReadonlyArray<Pick<Rejection, "code">>
): boolean {
  if (!reasons.length) return false;
  if (token.freezeAuthorityRevoked === false) return false;
  return reasons.every((reason) => SOFT_RECHECK_CODES.has(reason.code));
}

/** Stable delay in [3 min, 5 min] so a burst of births does not retry on the same tick. */
export function recheckDelayMs(mint: string, min = RECHECK_DELAY_MIN_MS, max = RECHECK_DELAY_MAX_MS): number {
  let hash = 2166136261;
  for (let i = 0; i < mint.length; i += 1) {
    hash ^= mint.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const span = Math.max(0, max - min);
  return min + (Math.abs(hash) % (span + 1));
}

interface Pending {
  at: number;
  token: CandidateToken;
}

/**
 * At most one recheck per mint. The queue keeps the oldest 300 by dropping the earliest insert.
 */
export class RecheckQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly once = new Set<string>();
  ran = 0;
  dropped = 0;

  counts(): { pending: number; ran: number; dropped: number } {
    return { pending: this.pending.size, ran: this.ran, dropped: this.dropped };
  }

  offer(token: CandidateToken, reasons: ReadonlyArray<Pick<Rejection, "code">>, now: number): boolean {
    if (this.once.has(token.mint)) return false;
    if (!recheckEligible(token, reasons)) return false;
    this.once.add(token.mint);
    this.evictOldest();
    this.pending.set(token.mint, { at: now + recheckDelayMs(token.mint), token });
    return true;
  }

  /** Put a due coin back after the enrich host asked us to wait. Does not spend the one-shot again. */
  pushBack(token: CandidateToken, at: number): void {
    this.evictOldest();
    this.pending.set(token.mint, { at, token });
  }

  due(now: number): CandidateToken[] {
    const ready: CandidateToken[] = [];
    for (const [mint, item] of this.pending) {
      if (item.at > now) continue;
      this.pending.delete(mint);
      ready.push(item.token);
    }
    return ready;
  }

  msUntilNext(now: number): number | null {
    let next: number | null = null;
    for (const item of this.pending.values()) {
      if (next == null || item.at < next) next = item.at;
    }
    if (next == null) return null;
    return Math.max(0, next - now);
  }

  noteRan(): void {
    this.ran += 1;
  }

  private evictOldest(): void {
    while (this.pending.size >= RECHECK_QUEUE_MAX) {
      const oldest = this.pending.keys().next().value;
      if (!oldest) break;
      this.pending.delete(oldest);
      this.dropped += 1;
    }
  }
}

/**
 * Re-read a soft-failed coin on the enrich RPC only.
 * A Helius URL is dropped, and a fetch that still points at Helius is not sent.
 * Holder pages stay off so this cannot open a Helius DAS lane.
 * Fields the new pass leaves unknown stay at the values already verified.
 * A Helius-only desk, or a mint read that misses, would otherwise hard-kill
 * a coin that only missed volume, liquidity, or holders, and the one-shot is spent.
 */
export async function recheckToken(token: CandidateToken, deps: EnrichDeps): Promise<CandidateToken> {
  const rpcUrl = deps.rpcUrl && !isHeliusUrl(deps.rpcUrl) ? deps.rpcUrl : undefined;
  const inner = deps.fetchImpl;
  const fetchImpl: typeof fetch | undefined = inner
    ? async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (isHeliusUrl(url)) return new Response("", { status: 599, headers: { "x-nd-recheck-helius": "blocked" } });
        return inner(input, init);
      }
    : undefined;
  const next = await enrichSighting(
    {
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      source: token.source === "pumpfun" ? "pumpfun" : "raydium",
      devWallet: token.devWallet ?? undefined,
      observedAt: Date.now(),
      volume1hUsd: token.volume1hUsd,
      priceUsd: token.priceUsd,
      liquidityUsd: token.liquidityUsd
    },
    { ...deps, rpcUrl, fetchImpl, holderPagesMax: 0 }
  );
  return keepVerified(next, token);
}

/** Fill only the safety fields the new enrich did not verify. A fresh read always wins. */
function keepVerified(next: CandidateToken, prior: CandidateToken): CandidateToken {
  if (next.mintAuthorityRevoked == null && prior.mintAuthorityRevoked != null) {
    next.mintAuthorityRevoked = prior.mintAuthorityRevoked;
  }
  if (next.freezeAuthorityRevoked == null && prior.freezeAuthorityRevoked != null) {
    next.freezeAuthorityRevoked = prior.freezeAuthorityRevoked;
  }
  if (next.lpLockedOrBurned == null && prior.lpLockedOrBurned != null) {
    next.lpLockedOrBurned = prior.lpLockedOrBurned;
    if (next.lpLockPct == null && prior.lpLockPct != null) next.lpLockPct = prior.lpLockPct;
  }
  if (next.top10HolderPct == null && prior.top10HolderPct != null) next.top10HolderPct = prior.top10HolderPct;
  if (next.holderCount == null && prior.holderCount != null) {
    next.holderCount = prior.holderCount;
    next.holderCountAtLeast = prior.holderCountAtLeast;
  }
  if (!next.holderSample && prior.holderSample) next.holderSample = prior.holderSample;
  if (!knownDevShare(next) && knownDevShare(prior)) {
    next.devHoldingPct = prior.devHoldingPct;
    next.devHoldingUpperBound = prior.devHoldingUpperBound;
  }
  return next;
}

function knownDevShare(token: CandidateToken): boolean {
  return typeof token.devHoldingPct === "number" && Number.isFinite(token.devHoldingPct);
}
