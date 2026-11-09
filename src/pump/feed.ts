/**
 * Live pump feed. Frames arrive from Scout's existing PumpPortal socket
 * (`onPumpFrame`). Account updates ride the desk's ChainStream (`onAccount`).
 * This module does not open a socket.
 */
import { PublicKey } from "@solana/web3.js";
import { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda } from "./sdk.js";
import { BONDING_CURVE_DISC, curveState, type CurveReserves } from "./curve.js";
import { decodePumpPortalFrame } from "./events.js";
import { decodePoolAccount } from "./pumpswap.js";
import type { CurveState, TradeEvent } from "./types.js";

export interface StreamKeys {
  setExtraKeys(keys: Iterable<string>): void;
}

const WATCH_CAP = 40;

export class PumpFeed {
  private readonly accounts = new Map<string, string>();
  /** Mints with an open position. Scouted coins stay decoded locally but are not subscribed. */
  private held = new Set<string>();
  /** Opened sockets. Stays 0: the feed does not dial PumpPortal or RPC. */
  readonly socketsOpened = 0;

  constructor(
    private readonly opts: {
      stream?: StreamKeys | null;
      onTrade: (event: TradeEvent) => void;
      onCoin: (info: { mint: string; name?: string; symbol?: string; creator?: string; txType: string }) => void;
      onCurve: (state: CurveState) => void;
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
      if (parsed.trade) this.opts.onTrade(parsed.trade);
      return;
    }
    this.watchMint(parsed.event.mint);
    this.opts.onTrade(parsed.event);
  }

  watchMint(mint: string): void {
    if (this.track(mint) === "invalid") return;
    this.trim();
    this.pushStream();
  }

  /** Curve and pool accounts for open positions only. Scout traffic must not fill the socket. */
  setHeldMints(mints: Iterable<string>): void {
    const next = new Set(mints);
    const same = next.size === this.held.size && [...next].every((mint) => this.held.has(mint));
    this.held = next;
    // A hold can be older than the scout cap, or evicted before it was marked held.
    let added = false;
    for (const mint of next) if (this.track(mint) === "added") added = true;
    if (added) this.trim();
    if (!same || added) this.pushStream();
  }

  /** Curve and pool PDAs. "added" when either key was missing (trim may have dropped them). */
  private track(mint: string): "invalid" | "added" | "present" {
    let key: PublicKey;
    try {
      key = new PublicKey(mint);
    } catch {
      return "invalid";
    }
    const curve = bondingCurvePda(key).toBase58();
    const pool = canonicalPumpPoolPda(key).toBase58();
    const present = this.accounts.has(curve) && this.accounts.has(pool);
    this.accounts.set(curve, mint);
    this.accounts.set(pool, mint);
    return present ? "present" : "added";
  }

  private pushStream(): void {
    const keys: string[] = [];
    for (const [key, mint] of this.accounts) if (this.held.has(mint)) keys.push(key);
    this.opts.stream?.setExtraKeys(keys);
  }

  /** ChainStream account notification. Ignored unless the mint was watched. */
  onAccount(account: string, data: Uint8Array): void {
    const mint = this.accounts.get(account);
    if (!mint) return;
    const buf = Buffer.from(data);
    const disc = buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from(BONDING_CURVE_DISC));
    if (disc) try {
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
      /* discriminator matched but the body is not a BondingCurve we can read */
      return;
    }
    try {
      decodePoolAccount(buf);
    } catch {
      /* not a pool either */
    }
  }

  private trim(): void {
    while (this.accounts.size > WATCH_CAP) {
      let victim: string | undefined;
      for (const [key, mint] of this.accounts) {
        if (this.held.has(mint)) continue;
        victim = key;
        break;
      }
      if (!victim) return;
      this.accounts.delete(victim);
    }
  }
}
