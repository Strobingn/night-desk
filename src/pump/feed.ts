/**
 * Live pump feed. Frames arrive from Scout's existing PumpPortal socket
 * (`onPumpFrame`). Account updates ride the desk's ChainStream (`onAccount`).
 * This module does not open a socket.
 */
import { PublicKey } from "@solana/web3.js";
import { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, type Pool } from "./sdk.js";
import { curveState, type CurveReserves } from "./curve.js";
import { decodePumpPortalFrame } from "./events.js";
import { decodePoolAccount, poolStateFromParts } from "./pumpswap.js";
import type { CurveState, PoolState, TradeEvent } from "./types.js";

export interface StreamKeys {
  setExtraKeys(keys: Iterable<string>): void;
}

const WATCH_CAP = 40;

interface CachedPool {
  address: string;
  pool: Pool;
  base?: bigint;
  quote?: bigint;
}

export class PumpFeed {
  private readonly accounts = new Map<string, string>();
  /** Pool vault address → which side, so a token-account notice can fill `coin.pool`. */
  private readonly vaultSide = new Map<string, "base" | "quote">();
  private readonly pools = new Map<string, CachedPool>();
  /** Opened sockets. Stays 0: the feed does not dial PumpPortal or RPC. */
  readonly socketsOpened = 0;

  constructor(
    private readonly opts: {
      stream?: StreamKeys | null;
      /** Watched mints. Scout subscribes these on the PumpPortal socket (`subscribeTokenTrade`). */
      subscribeTrades?: (mints: readonly string[]) => void;
      onTrade: (event: TradeEvent) => void;
      onCoin: (info: { mint: string; name?: string; symbol?: string; creator?: string; txType: string }) => void;
      onCurve: (state: CurveState) => void;
      onPool?: (mint: string, pool: PoolState) => void;
      now?: () => number;
    }
  ) {}

  /** Scout calls this with every frame from the one PumpPortal socket. */
  onPumpFrame(text: string): void {
    const parsed = decodePumpPortalFrame(text, this.opts.now?.() ?? Date.now());
    if (!parsed) return;
    if (parsed.kind === "coin") {
      this.watchMint(parsed.mint);
      this.opts.onCoin(parsed);
      return;
    }
    this.watchMint(parsed.event.mint);
    this.opts.onTrade(parsed.event);
  }

  watchMint(mint: string): void {
    let key: PublicKey;
    try {
      key = new PublicKey(mint);
    } catch {
      return;
    }
    this.accounts.set(bondingCurvePda(key).toBase58(), mint);
    this.accounts.set(canonicalPumpPoolPda(key).toBase58(), mint);
    this.publishWatch();
  }

  /** ChainStream account notification. Ignored unless the mint was watched. */
  onAccount(account: string, data: Uint8Array): void {
    const mint = this.accounts.get(account);
    if (!mint) return;
    const buf = Buffer.from(data);
    try {
      const curve = PUMP_SDK.decodeBondingCurve({
        data: buf,
        executable: false,
        lamports: 0,
        owner: PublicKey.default
      });
      const reserves: CurveReserves = {
        virtualTokenReserves: BigInt(curve.virtualTokenReserves.toString(10)),
        virtualQuoteReserves: BigInt(curve.virtualQuoteReserves.toString(10)),
        realTokenReserves: BigInt(curve.realTokenReserves.toString(10)),
        realQuoteReserves: BigInt(curve.realQuoteReserves.toString(10)),
        tokenTotalSupply: BigInt(curve.tokenTotalSupply.toString(10)),
        complete: curve.complete,
        creator: curve.creator.toBase58(),
        isMayhemMode: curve.isMayhemMode,
        quoteMint: curve.quoteMint.equals(PublicKey.default) ? null : curve.quoteMint.toBase58()
      };
      this.opts.onCurve(curveState(mint, reserves));
      return;
    } catch {
      /* not a bonding curve */
    }
    try {
      const pool = decodePoolAccount(buf);
      this.rememberPool(mint, account, pool);
      return;
    } catch {
      /* not a pool either */
    }
    this.rememberVault(account, buf);
  }

  private publishWatch(): void {
    this.trim();
    this.opts.stream?.setExtraKeys(this.accounts.keys());
    this.opts.subscribeTrades?.([...new Set(this.accounts.values())]);
  }

  private rememberPool(mint: string, address: string, pool: Pool): void {
    const prev = this.pools.get(mint);
    this.pools.set(mint, { address, pool, base: prev?.base, quote: prev?.quote });
    this.trackVault(pool.poolBaseTokenAccount.toBase58(), mint, "base");
    this.trackVault(pool.poolQuoteTokenAccount.toBase58(), mint, "quote");
    this.emitPool(mint);
  }

  private trackVault(address: string, mint: string, side: "base" | "quote"): void {
    this.vaultSide.set(address, side);
    if (this.accounts.get(address) === mint) return;
    this.accounts.set(address, mint);
    this.publishWatch();
  }

  private rememberVault(account: string, data: Buffer): void {
    const side = this.vaultSide.get(account);
    if (!side || data.length < 72) return;
    const mint = this.accounts.get(account);
    if (!mint) return;
    const entry = this.pools.get(mint);
    if (!entry) return;
    const amount = data.readBigUInt64LE(64);
    if (side === "base") entry.base = amount;
    else entry.quote = amount;
    this.emitPool(mint);
  }

  private emitPool(mint: string): void {
    const entry = this.pools.get(mint);
    if (!entry || !this.opts.onPool) return;
    const virtual = BigInt(entry.pool.virtualQuoteReserves.toString(10));
    const base = entry.base;
    const quote = entry.quote;
    if (base != null && base > 0n && quote != null && quote + virtual > 0n) {
      try {
        this.opts.onPool(
          mint,
          poolStateFromParts({
            address: entry.address,
            pool: entry.pool,
            baseReserve: base,
            quoteReserve: quote,
            baseSupply: 1_000_000_000_000_000n
          })
        );
        return;
      } catch {
        /* reserves are not a price yet; still publish the pool so the route is not 404 */
      }
    }
    this.opts.onPool(mint, poolSkeleton(entry, virtual));
  }

  private trim(): void {
    while (this.accounts.size > WATCH_CAP) {
      const first = this.accounts.keys().next().value;
      if (!first) return;
      this.accounts.delete(first);
      this.vaultSide.delete(first);
    }
  }
}

function poolSkeleton(entry: CachedPool, virtual: bigint): PoolState {
  const quote = entry.quote;
  return {
    address: entry.address,
    baseMint: entry.pool.baseMint.toBase58(),
    quoteMint: entry.pool.quoteMint.toBase58(),
    baseVault: entry.pool.poolBaseTokenAccount.toBase58(),
    quoteVault: entry.pool.poolQuoteTokenAccount.toBase58(),
    baseReserve: (entry.base ?? 0n).toString(),
    quoteReserve: (quote ?? 0n).toString(),
    virtualQuoteReserves: virtual.toString(),
    effectiveQuoteReserve: quote == null ? "0" : (quote + virtual).toString(),
    lpSupply: entry.pool.lpSupply.toString(10),
    coinCreator: entry.pool.coinCreator.toBase58(),
    isMayhemMode: entry.pool.isMayhemMode,
    isCashbackCoin: entry.pool.isCashbackCoin,
    creatorFeeBps: entry.pool.creatorFeeBps.toString(10),
    priceQuotePerBase: "0",
    marketCapLamports: "0"
  };
}
