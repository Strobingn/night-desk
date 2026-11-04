/**
 * Ranks new pump.fun coins and, when asked, prepares one core buy intent.
 * The intent is simulate-only unless this process is armed. Nothing here signs
 * or submits. The wallet approves the unsigned transaction.
 * There is no in-tree wallet signer yet, so an unarmed session always stays on simulate.
 */
import { PublicKey } from "@solana/web3.js";
import type { PumpCoin, TradeEvent, TradeIntent } from "../types.js";
import { isTokenProgram } from "../constants.js";
import { rankCoins, type ScanInput, type ScoredCoin } from "./score.js";

const UNKNOWN_WALLET = "11111111111111111111111111111111";

export interface MintAuthorities {
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

export interface AccountBytes {
  data: Buffer;
  owner: string;
}

export const SCAN_INTERVAL_MS = 5_000;
export const SCAN_TOP_N = 20;
export const AUTO_BUY_COOLDOWN_MS = 10 * 60 * 1000;
export const NEW_COIN_MS = 24 * 60 * 60 * 1000;

export interface AutoBuyRequest {
  enabled: boolean;
  /** Core arm session. A restart clears this. */
  armed: boolean;
  /** Caller asked for a live intent. Ignored unless `armed` is true. */
  liveRequested: boolean;
  wallet: string;
  solLamports: bigint;
  now: number;
  lastBuyAt: number | null;
  assertRoom: (lamports: bigint) => void;
  prepare: (input: { wallet: string; mint: string; side: "buy"; solLamports: string; live: boolean; idemKey: string }) => Promise<TradeIntent>;
}

export interface AutoBuyResult {
  intent: TradeIntent | null;
  reason: string;
  lastBuyAt: number | null;
  simulateOnly: boolean;
}

export function rowsFromBook(
  coins: readonly PumpCoin[],
  trades: readonly TradeEvent[],
  growth: ReadonlyMap<string, number>,
  now: number,
  authorities?: ReadonlyMap<string, MintAuthorities>
): ScanInput[] {
  const byMint = new Map<string, TradeEvent[]>();
  for (const trade of trades) {
    const list = byMint.get(trade.mint) ?? [];
    list.push(trade);
    byMint.set(trade.mint, list);
  }
  const rows: ScanInput[] = [];
  for (const coin of coins) {
    if (coin.complete) continue;
    const createdAt = coin.createdAt ?? now;
    if (now - createdAt > NEW_COIN_MS) continue;
    const list = byMint.get(coin.mint) ?? [];
    let volume = 0;
    let buy = 0;
    let sell = 0;
    const buyers = new Set<string>();
    let dumping = false;
    for (const trade of list) {
      const sol = Number(trade.solAmountLamports);
      const size = Number.isFinite(sol) ? sol : 0;
      volume += size;
      if (trade.isBuy) {
        buy += size;
        if (trade.user) buyers.add(trade.user);
      } else {
        sell += size;
        if (coin.creator && trade.user === coin.creator) dumping = true;
      }
    }
    const held = holdingsOf(list, coin.creator, coin.curve?.tokenTotalSupply);
    const auth = authorities?.get(coin.mint);
    rows.push({
      mint: coin.mint,
      symbol: coin.symbol,
      createdAt,
      volumeLamports: volume,
      progressPct: coin.curve?.progressPct ?? 0,
      buyLamports: buy,
      sellLamports: sell,
      uniqueBuyers: buyers.size,
      holderGrowth: growth.get(coin.mint) ?? 0,
      devHoldingPct: held?.devHoldingPct,
      top10HoldingPct: held?.top10HoldingPct,
      mintAuthority: auth ? auth.mintAuthority : undefined,
      freezeAuthority: auth ? auth.freezeAuthority : undefined,
      creatorDumping: dumping
    });
  }
  return rows;
}

/**
 * SPL mint authority words. Option 0 means revoked. A live authority is any other pubkey.
 * Holding concentration is the net tape balance over curve supply, so the 10% and 30% gates
 * see a number instead of "missing".
 */
export function authoritiesFromMint(data: Buffer, owner: string): MintAuthorities | null {
  if (!isTokenProgram(owner) || data.length < 82) return null;
  const mintOption = data.readUInt32LE(0);
  const freezeOption = data.readUInt32LE(46);
  return {
    mintAuthority: mintOption === 0 ? null : new PublicKey(data.subarray(4, 36)).toBase58(),
    freezeAuthority: freezeOption === 0 ? null : new PublicKey(data.subarray(50, 82)).toBase58()
  };
}

export async function readMintAuthorities(
  mints: readonly string[],
  read: (address: string) => Promise<AccountBytes | null>
): Promise<Map<string, MintAuthorities>> {
  const map = new Map<string, MintAuthorities>();
  await Promise.all(
    mints.map(async (mint) => {
      try {
        const raw = await read(mint);
        if (!raw) return;
        const parsed = authoritiesFromMint(raw.data, raw.owner);
        if (parsed) map.set(mint, parsed);
      } catch {
        /* a missing mint leaves the authority fields unset for this pass */
      }
    })
  );
  return map;
}

function holdingsOf(
  trades: readonly TradeEvent[],
  creator: string | undefined,
  supplyRaw: string | undefined
): { devHoldingPct: number; top10HoldingPct: number } | null {
  const supply = Number(supplyRaw);
  if (!Number.isFinite(supply) || supply <= 0) return null;
  const balances = new Map<string, number>();
  for (const trade of trades) {
    if (!trade.user || trade.user === UNKNOWN_WALLET) continue;
    const tokens = Number(trade.tokenAmount);
    if (!Number.isFinite(tokens) || tokens === 0) continue;
    balances.set(trade.user, (balances.get(trade.user) ?? 0) + (trade.isBuy ? tokens : -tokens));
  }
  const devUser = creator && creator !== UNKNOWN_WALLET ? creator : "";
  const dev = devUser ? Math.max(0, balances.get(devUser) ?? 0) : 0;
  const ranked = [...balances.values()].map((value) => Math.max(0, value)).sort((a, b) => b - a);
  let top = 0;
  for (const value of ranked.slice(0, 10)) top += value;
  return { devHoldingPct: dev / supply, top10HoldingPct: top / supply };
}

export class HotScanner {
  private rows: ScanInput[] = [];
  private ranked: ScoredCoin[] = [];
  private lastRankAt = 0;
  private lastBuyAt: number | null = null;
  private readonly growth = new Map<string, { count: number; growth: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  due(at = this.now()): boolean {
    return at - this.lastRankAt >= SCAN_INTERVAL_MS;
  }

  noteHolders(mint: string, count: number): void {
    const prev = this.growth.get(mint);
    const growth = prev ? count - prev.count : 0;
    this.growth.set(mint, { count, growth: Math.max(0, growth) });
  }

  holderGrowth(): ReadonlyMap<string, number> {
    const map = new Map<string, number>();
    for (const [mint, row] of this.growth) map.set(mint, row.growth);
    return map;
  }

  replace(rows: readonly ScanInput[], at = this.now()): ScoredCoin[] {
    this.rows = rows.map((row) => ({ ...row }));
    this.ranked = rankCoins(this.rows, at, SCAN_TOP_N);
    this.lastRankAt = at;
    return this.top();
  }

  top(): ScoredCoin[] {
    return this.ranked.map((row) => ({ ...row }));
  }

  async autoBuy(request: Omit<AutoBuyRequest, "now" | "lastBuyAt"> & { now?: number }): Promise<AutoBuyResult> {
    const now = request.now ?? this.now();
    const result = await autoBuyBest(this.ranked, { ...request, now, lastBuyAt: this.lastBuyAt });
    this.lastBuyAt = result.lastBuyAt;
    return result;
  }

  /** Test and route hook. Does not sign. */
  get lastAutoBuyAt(): number | null {
    return this.lastBuyAt;
  }
}

/**
 * Prepares at most one buy per 10 minutes, inside the core caps.
 * The returned intent is simulate-only unless the session is armed.
 * The unsigned transaction is for the wallet to approve. This function does not submit it.
 */
export async function autoBuyBest(ranked: readonly { mint: string; score: number }[], request: AutoBuyRequest): Promise<AutoBuyResult> {
  const quiet = (reason: string): AutoBuyResult => ({
    intent: null,
    reason,
    lastBuyAt: request.lastBuyAt,
    simulateOnly: !request.armed || !request.liveRequested
  });
  if (!request.enabled) return quiet("off");
  const best = ranked.find((row) => row.score > 0);
  if (!best) return quiet("no candidate");
  if (request.lastBuyAt != null && request.now - request.lastBuyAt < AUTO_BUY_COOLDOWN_MS) return quiet("cooldown");
  if (!request.wallet) return quiet("wallet");
  if (request.solLamports <= 0n) return quiet("amount");
  request.assertRoom(request.solLamports);
  const live = request.armed && request.liveRequested;
  const bucket = Math.floor(request.now / AUTO_BUY_COOLDOWN_MS);
  const intent = await request.prepare({
    wallet: request.wallet,
    mint: best.mint,
    side: "buy",
    solLamports: request.solLamports.toString(),
    live,
    idemKey: `scan:${best.mint}:${bucket}`
  });
  if (!live) {
    intent.mode = "simulate";
    intent.simulateOnly = true;
  }
  return { intent, reason: "prepared", lastBuyAt: request.now, simulateOnly: intent.simulateOnly };
}
