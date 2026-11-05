/**
 * PumpSwap pool decoder. Layout comes from the SDK coder (pool_bump, index,
 * creator, mints, vaults, lp_supply, coin_creator, flags, signed
 * virtual_quote_reserves at the IDL offset). Price is
 * `quote vault balance + virtual_quote_reserves`.
 */
import { AccountInfo, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { PUMP_AMM_SDK, poolMarketCap, type Pool } from "./sdk.js";
import { PUMP_SWAP_PROGRAM } from "./constants.js";
import type { PoolState, RawAmount } from "./types.js";

export function decodePoolAccount(data: Buffer): Pool {
  const info = {
    data,
    executable: false,
    lamports: 0,
    owner: PUMP_SWAP_PROGRAM
  } as AccountInfo<Buffer>;
  return PUMP_AMM_SDK.decodePool(info);
}

export function effectiveQuote(quoteVaultBalance: bigint, virtualQuoteReserves: bigint): bigint {
  return quoteVaultBalance + virtualQuoteReserves;
}

function raw(n: bigint): RawAmount {
  return n.toString();
}

function bnToBigint(n: BN): bigint {
  return BigInt(n.toString(10));
}

export function poolStateFromParts(args: {
  address: string;
  pool: Pool;
  baseReserve: bigint;
  quoteReserve: bigint;
  /** Mint supply, raw. Pump coins are 1e15. */
  baseSupply: bigint;
}): PoolState {
  const virtual = bnToBigint(args.pool.virtualQuoteReserves);
  const effective = effectiveQuote(args.quoteReserve, virtual);
  if (args.baseReserve <= 0n) throw new Error("pool base vault is empty");
  if (effective <= 0n) throw new Error("effective quote reserves are not positive");
  const marketCap = poolMarketCap({
    baseMintSupply: new BN(args.baseSupply.toString(10)),
    baseReserve: new BN(args.baseReserve.toString(10)),
    quoteReserve: new BN(effective.toString(10)),
    isMayhemMode: args.pool.isMayhemMode
  });
  return {
    address: args.address,
    baseMint: args.pool.baseMint.toBase58(),
    quoteMint: args.pool.quoteMint.toBase58(),
    baseVault: args.pool.poolBaseTokenAccount.toBase58(),
    quoteVault: args.pool.poolQuoteTokenAccount.toBase58(),
    baseReserve: raw(args.baseReserve),
    quoteReserve: raw(args.quoteReserve),
    virtualQuoteReserves: raw(virtual),
    effectiveQuoteReserve: raw(effective),
    lpSupply: args.pool.lpSupply.toString(10),
    coinCreator: args.pool.coinCreator.toBase58(),
    isMayhemMode: args.pool.isMayhemMode,
    isCashbackCoin: args.pool.isCashbackCoin,
    creatorFeeBps: args.pool.creatorFeeBps.toString(10),
    priceQuotePerBase: ratio(effective, args.baseReserve),
    marketCapLamports: marketCap.toString(10)
  };
}

/** Decimal quote-per-base with up to 12 places, no float. */
function ratio(quote: bigint, base: bigint): string {
  const scale = 1_000_000_000_000n;
  const scaled = (quote * scale) / base;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(12, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function emptyOwner(): PublicKey {
  return PublicKey.default;
}
