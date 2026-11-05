import { PublicKey } from "@solana/web3.js";

/**
 * Wallets and programs whose token accounts are protocol reserves, not retail holders.
 * Top-10 concentration ignores these owners. Per-mint Pump bonding-curve PDAs and their
 * associated token accounts are added in `pumpReserveAddresses`.
 *
 * - Pump.fun program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 * - Pump AMM (PumpSwap) program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 * - Raydium AMM v4 program: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
 * - Raydium AMM v4 vault authority: 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1
 * - Raydium CPMM program: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 * - Raydium CPMM vault authority: GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL
 * - SPL burn incinerator: 1nc1nerator11111111111111111111111111111111
 */
export const RESERVE_OWNERS = [
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
  "1nc1nerator11111111111111111111111111111111"
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
