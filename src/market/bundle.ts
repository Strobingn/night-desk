/**
 * v13.23 launch-bundle math. Sums tokens acquired in the creation slot by
 * wallets, after the bonding-curve PDA and pool vaults are removed. A coin
 * is flagged at 20% of supply, or when two same-slot buyers were funded by
 * one parent. The percent on the card is that wallet total, not the PDAs.
 */

import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { bondingCurvePda, canonicalPumpPoolPda } from "../pump/sdk.js";

export const BUNDLE_PCT = 0.2;

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

/** Bonding-curve PDA, canonical pool PDA, and their token vaults. */
export function pumpExcluded(mint: string): Set<string> {
  const m = new PublicKey(mint);
  const curve = bondingCurvePda(m);
  const pool = canonicalPumpPoolPda(m);
  const set = new Set<string>([curve.toBase58(), pool.toBase58()]);
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    for (const owner of [curve, pool]) {
      set.add(getAssociatedTokenAddressSync(m, owner, true, program).toBase58());
      set.add(getAssociatedTokenAddressSync(WSOL, owner, true, program).toBase58());
    }
  }
  return set;
}

const PROGRAM_OWNERS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111"
]);

export interface HolderDelta {
  owner: string;
  /** Token account address. A pool vault is excluded by this, not by its PDA owner alone. */
  account: string;
  /** Raw atoms acquired in the slot (post − pre). Negative is a sell. */
  delta: bigint;
}

export interface BundleResult {
  flagged: boolean;
  /** Whole percent of supply the counted wallets acquired. */
  pct: number;
  /** "Bundled 24%" when flagged. */
  label: string | null;
  acquired: bigint;
}

export function bundleShare(input: {
  supply: bigint;
  deltas: HolderDelta[];
  excluded: ReadonlySet<string>;
  funders?: ReadonlyMap<string, string>;
}): BundleResult {
  const supply = input.supply;
  const acquiredBy = new Map<string, bigint>();
  for (const row of input.deltas) {
    if (row.delta <= 0n) continue;
    if (!row.owner || PROGRAM_OWNERS.has(row.owner)) continue;
    if (input.excluded.has(row.owner) || input.excluded.has(row.account)) continue;
    acquiredBy.set(row.owner, (acquiredBy.get(row.owner) ?? 0n) + row.delta);
  }
  let acquired = 0n;
  for (const n of acquiredBy.values()) acquired += n;
  const pct = supply > 0n ? Number((acquired * 10_000n) / supply) / 100 : 0;
  const parents = new Map<string, number>();
  const funders = input.funders ?? new Map<string, string>();
  for (const owner of acquiredBy.keys()) {
    const parent = funders.get(owner);
    if (!parent || parent === owner || input.excluded.has(parent)) continue;
    parents.set(parent, (parents.get(parent) ?? 0) + 1);
  }
  const commonParent = [...parents.values()].some((n) => n >= 2);
  const share = supply > 0n ? Number(acquired) / Number(supply) : 0;
  const flagged = (supply > 0n && share >= BUNDLE_PCT - 1e-12) || commonParent;
  const shown = Math.round(pct);
  return {
    flagged,
    pct: shown,
    label: flagged ? `Bundled ${shown}%` : null,
    acquired
  };
}

interface TokenBal {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

export interface SlotTransaction {
  meta?: {
    preTokenBalances?: TokenBal[];
    postTokenBalances?: TokenBal[];
    innerInstructions?: Array<{ instructions?: unknown[] }>;
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey?: string }>;
      instructions?: unknown[];
    };
  };
}

/** Token deltas and SOL funders for one mint inside one slot's transactions. */
export function slotActivity(mint: string, transactions: SlotTransaction[]): { deltas: HolderDelta[]; funders: Map<string, string> } {
  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();
  const accountOf = new Map<string, string>();
  const take = (rows: TokenBal[] | undefined, into: Map<string, bigint>, keys: Array<string | { pubkey?: string }>) => {
    for (const row of rows ?? []) {
      if (row.mint !== mint || !row.owner) continue;
      const account = accountAt(keys, row.accountIndex);
      const key = `${row.owner}\n${account}`;
      accountOf.set(key, account);
      const amount = BigInt(row.uiTokenAmount?.amount ?? "0");
      into.set(key, (into.get(key) ?? 0n) + amount);
    }
  };
  const funders = new Map<string, string>();
  for (const tx of transactions) {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    take(tx.meta?.preTokenBalances, pre, keys);
    take(tx.meta?.postTokenBalances, post, keys);
    for (const ix of tx.transaction?.message?.instructions ?? []) noteFunder(ix, funders);
    for (const inner of tx.meta?.innerInstructions ?? []) {
      for (const ix of inner.instructions ?? []) noteFunder(ix, funders);
    }
  }
  const keys = new Set<string>([...pre.keys(), ...post.keys()]);
  const deltas: HolderDelta[] = [];
  for (const key of keys) {
    const [owner] = key.split("\n");
    deltas.push({ owner: owner!, account: accountOf.get(key) ?? "", delta: (post.get(key) ?? 0n) - (pre.get(key) ?? 0n) });
  }
  return { deltas, funders };
}

function accountAt(keys: Array<string | { pubkey?: string }>, index: number | undefined): string {
  if (index == null) return "";
  const key = keys[index];
  if (!key) return "";
  return typeof key === "string" ? key : key.pubkey ?? "";
}

function noteFunder(ix: unknown, funders: Map<string, string>): void {
  const parsed = (ix as { parsed?: { type?: string; info?: { source?: string; destination?: string; lamports?: number } } })?.parsed;
  if (parsed?.type !== "transfer") return;
  const source = parsed.info?.source;
  const destination = parsed.info?.destination;
  const lamports = Number(parsed.info?.lamports ?? 0);
  if (!source || !destination || !(lamports > 0)) return;
  funders.set(destination, source);
}

export function isPumpCoin(token: { source?: string; dex?: string | null; platform?: string | null }): boolean {
  if (token.source === "pumpfun") return true;
  const dex = (token.dex ?? "").toLowerCase();
  if (dex.includes("pump")) return true;
  return (token.platform ?? "").toLowerCase().includes("pump");
}
