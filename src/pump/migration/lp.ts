/**
 * LP supply, burn, ownership, and lock status for a graduated pool.
 * Lockers are the programs that custody LP. A canonical PumpSwap migration
 * burns the LP mint (supply goes to 0); that is 100% burned and stays locked.
 */
import { PublicKey } from "@solana/web3.js";
import { PUMPSWAP_PROGRAM, RAYDIUM_AMM_V4, RAYDIUM_CPMM } from "../../market/chain-marks.js";
import { canonicalPumpPoolPda } from "../sdk.js";

export interface LpLocker {
  id: string;
  name: string;
}

/** Programs that hold locked LP. Matched against the token-account owner. */
export const LP_LOCKERS: readonly LpLocker[] = [
  { id: "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE", name: "Raydium LP lock" },
  { id: "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo", name: "UNCX AMMv4" },
  { id: "UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN", name: "UNCX AMMv4 Smart" },
  { id: "UNCXdvMRxvz91g3HqFmpZ5NgmL77UH4QRM4NfeL4mQB", name: "UNCX CPMM" },
  { id: "UNCXrB8cZXnmtYM1aSo1Wx3pQaeSZYuF2jCTesXvECs", name: "UNCX CLMM" },
  { id: "unCXpWPXnYnP9i6E8JeVy7nkv4B9PW9uvudakMLLzdQ", name: "UNCX PumpSwap" },
  { id: "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m", name: "Streamflow" }
];

/** SPL burn incinerator and the system program (a common dead address). */
export const LP_BURN_OWNERS = ["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"] as const;

const LOCKER_IDS = new Set(LP_LOCKERS.map((locker) => locker.id));
const BURN_IDS = new Set<string>(LP_BURN_OWNERS);

export type PoolVenue = "pumpswap" | "raydium" | "other";

export interface LpHolder {
  owner: string;
  amount: string;
}

export interface LpOwnerRow {
  owner: string;
  amount: string;
  pct: number;
  label: string;
}

export interface LpAssessment {
  mint: string;
  pool: string;
  venue: PoolVenue;
  canonical: boolean;
  /** "canonical" or "non-canonical". Non-canonical pools are never sniped. */
  poolClass: "canonical" | "non-canonical";
  lpSupply: string;
  lpBurnedPct: number;
  owners: LpOwnerRow[];
  locked: boolean;
  /** Amount still sitting in known lockers, plus burned LP counted as locked. */
  lockedAmount: string;
  lockers: Array<{ program: string; name: string; amount: string }>;
}

export function lockerName(owner: string): string | null {
  return LP_LOCKERS.find((locker) => locker.id === owner)?.name ?? null;
}

export function isCanonicalPumpPool(mint: string, pool: string, ownerProgram: string): boolean {
  if (ownerProgram !== PUMPSWAP_PROGRAM) return false;
  try {
    return canonicalPumpPoolPda(new PublicKey(mint)).toBase58() === pool;
  } catch {
    return false;
  }
}

export function venueFor(ownerProgram: string): PoolVenue {
  if (ownerProgram === PUMPSWAP_PROGRAM) return "pumpswap";
  if (ownerProgram === RAYDIUM_AMM_V4 || ownerProgram === RAYDIUM_CPMM) return "raydium";
  return "other";
}

export function assessLp(input: {
  mint: string;
  pool: string;
  ownerProgram: string;
  /** Pool account `lp_supply` (the LP minted at migration). */
  lpSupply: bigint;
  /** Current LP mint supply. Burned tokens reduce this. Null if the mint was not read. */
  lpMintSupply?: bigint | null;
  holders?: LpHolder[];
}): LpAssessment {
  const canonical = isCanonicalPumpPool(input.mint, input.pool, input.ownerProgram);
  const venue = venueFor(input.ownerProgram);
  const holders = input.holders ?? [];
  const supply = input.lpSupply < 0n ? 0n : input.lpSupply;
  let burned = 0n;
  for (const holder of holders) {
    if (!BURN_IDS.has(holder.owner)) continue;
    const amount = parseAmount(holder.amount);
    if (amount > 0n) burned += amount;
  }
  if (input.lpMintSupply != null && supply > input.lpMintSupply) burned += supply - input.lpMintSupply;
  if (burned > supply && supply > 0n) burned = supply;
  const burnedPct = supply === 0n ? 100 : Number((burned * 10_000n) / supply) / 100;

  const owners: LpOwnerRow[] = holders.map((holder) => {
    const amount = parseAmount(holder.amount);
    const name = lockerName(holder.owner);
    const label = name ?? (BURN_IDS.has(holder.owner) ? "burned" : "wallet");
    return {
      owner: holder.owner,
      amount: amount.toString(),
      pct: supply === 0n ? 0 : Number((amount * 10_000n) / supply) / 100,
      label
    };
  });

  const lockers: LpAssessment["lockers"] = [];
  let lockedAmount = burned;
  const byLocker = new Map<string, bigint>();
  for (const holder of holders) {
    if (!LOCKER_IDS.has(holder.owner)) continue;
    const amount = parseAmount(holder.amount);
    byLocker.set(holder.owner, (byLocker.get(holder.owner) ?? 0n) + amount);
    lockedAmount += amount;
  }
  for (const [program, amount] of byLocker) {
    if (amount <= 0n) continue;
    lockers.push({ program, name: lockerName(program) ?? program, amount: amount.toString() });
  }

  const locked = lockedAmount > 0n || burnedPct >= 100;
  return {
    mint: input.mint,
    pool: input.pool,
    venue,
    canonical,
    poolClass: canonical ? "canonical" : "non-canonical",
    lpSupply: supply.toString(),
    lpBurnedPct: burnedPct,
    owners,
    locked,
    lockedAmount: lockedAmount.toString(),
    lockers
  };
}

/**
 * A lock that is still in place: burned LP did not come back, and locker
 * balances did not fall. A first reading has no "still" — it reports whether it is locked now.
 */
export function stillLocked(previous: Pick<LpAssessment, "locked" | "lockedAmount" | "lpBurnedPct"> | null, current: LpAssessment): boolean | null {
  if (!previous) return current.locked ? true : null;
  if (!previous.locked) return current.locked ? true : false;
  try {
    if (BigInt(current.lockedAmount) < BigInt(previous.lockedAmount)) return false;
  } catch {
    return false;
  }
  if (current.lpBurnedPct + 0.001 < previous.lpBurnedPct) return false;
  return current.locked;
}

function parseAmount(raw: string): bigint {
  try {
    const n = BigInt(raw);
    return n > 0n ? n : 0n;
  } catch {
    return 0n;
  }
}
