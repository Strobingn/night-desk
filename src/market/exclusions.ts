import { PublicKey } from "@solana/web3.js";

/**
 * Wallets and programs whose token accounts are protocol reserves, not retail holders.
 * Top-10 concentration ignores these owners. Per-mint Pump bonding-curve PDAs and their
 * associated token accounts are added in `pumpReserveAddresses`.
 *
 * - Pump.fun program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 * - Pump AMM (PumpSwap) program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 * - PumpSwap pool authority PDA ("pool-authority")
 * - Raydium AMM v4 program: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
 * - Raydium AMM v4 vault authority: 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1
 * - Raydium CPMM program: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 * - Raydium CPMM vault authority: GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL
 * - Raydium CLMM program: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
 *   (each CLMM pool owns its vaults; the pool address comes from DexScreener)
 * - Raydium LaunchLab program and its vault / fee authorities
 * - Meteora DLMM, DAMM v2, and DBC programs, plus their pool-authority PDAs
 * - SPL burn incinerator: 1nc1nerator11111111111111111111111111111111
 */
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const METEORA_DAMM_V2 = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const METEORA_DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const RAYDIUM_LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

function authorityPda(program: string, seed: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(program))[0].toBase58();
}

/** Programs and the global PDAs that own pool token vaults. Per-pool addresses are added per mint. */
export const POOL_AUTHORITY_OWNERS = [
  PUMP_AMM,
  authorityPda(PUMP_AMM, "pool-authority"),
  METEORA_DLMM,
  METEORA_DAMM_V2,
  authorityPda(METEORA_DAMM_V2, "pool_authority"),
  METEORA_DBC,
  authorityPda(METEORA_DBC, "pool_authority"),
  RAYDIUM_CLMM,
  RAYDIUM_LAUNCHLAB,
  authorityPda(RAYDIUM_LAUNCHLAB, "vault_auth_seed"),
  authorityPda(RAYDIUM_LAUNCHLAB, "platform_fee_vault_auth_seed"),
  authorityPda(RAYDIUM_LAUNCHLAB, "creator_fee_vault_auth_seed")
] as const;

export const RESERVE_OWNERS = [
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
  "1nc1nerator11111111111111111111111111111111",
  ...POOL_AUTHORITY_OWNERS
] as const;

export const RESERVE_OWNER_SET = new Set<string>(RESERVE_OWNERS);

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const RESERVE_LABEL = /bonding.?curve|liquidity|lp vault|pool vault|amm vault|reserve|raydium vault|pump.?swap/i;

export interface HolderLike {
  address?: string | null;
  owner?: string | null;
  tag?: string | null;
  label?: string | null;
  insider?: boolean;
}

/** Bonding-curve PDA plus the ATAs that actually show up in getTokenLargestAccounts. */
export function pumpReserveAddresses(mint: string): string[] {
  try {
    const mintKey = new PublicKey(mint);
    const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKey.toBuffer()], PUMP_PROGRAM);
    const atas = [TOKEN_PROGRAM, TOKEN_2022].map((program) => {
      const [address] = PublicKey.findProgramAddressSync(
        [curve.toBuffer(), program.toBuffer(), mintKey.toBuffer()],
        ATA_PROGRAM
      );
      return address.toBase58();
    });
    return [curve.toBase58(), ...atas];
  } catch {
    return [];
  }
}

/**
 * Addresses and owners dropped before a holder count or top-10 share.
 * `poolAddresses` is every DexScreener pair for the mint (the pool itself owns the vault,
 * and on PumpSwap the pool account can be the largest token account).
 */
export function holderExclusions(mint: string, poolAddresses: readonly string[] = []): {
  addresses: Set<string>;
  owners: Set<string>;
} {
  const pools = poolAddresses.filter((address) => address.length > 0);
  return {
    addresses: new Set<string>([...pumpReserveAddresses(mint), ...RESERVE_OWNER_SET, ...pools]),
    owners: new Set<string>([...RESERVE_OWNER_SET, ...pools])
  };
}

export function isReserveHolder(holder: HolderLike, extraAddresses?: ReadonlySet<string>): boolean {
  const address = holder.address ?? "";
  const owner = holder.owner ?? "";
  if (address && (RESERVE_OWNER_SET.has(address) || extraAddresses?.has(address))) return true;
  if (owner && (RESERVE_OWNER_SET.has(owner) || extraAddresses?.has(owner))) return true;
  const label = `${holder.tag ?? ""} ${holder.label ?? ""}`;
  return RESERVE_LABEL.test(label);
}

/**
 * Still on a Pump bonding curve, with no AMM pool whose LP we can lock.
 * Graduated Raydium / Orca / Meteora / PumpSwap markets are not on-curve.
 */
export function inferOnBondingCurve(input: { source?: string; dex?: string | null; riskText?: string }): boolean {
  const dex = (input.dex ?? "").toLowerCase();
  if (/raydium|orca|meteora|pumpswap|pump-amm|cpmm|whirlpool/.test(dex)) return false;
  const risks = (input.riskText ?? "").toLowerCase();
  if (/bonding curve/.test(risks) && /not complete|incomplete|still|active|pre-?migration|not migrat/.test(risks)) {
    return true;
  }
  return input.source === "pumpfun" && (dex === "" || /pumpfun|pump\.fun|bonding/.test(dex));
}
