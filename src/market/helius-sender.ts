/**
 * v13.23 Helius Sender for live swaps only. SWQOS-only, minimum tip
 * 0.000005 SOL, plus a compute-unit price. Sender is not a Helius credit
 * RPC (sender.helius-rpc.com is outside the 18/min lanes). A definite
 * Sender error falls back to the existing send once. A timeout does not:
 * the transaction may already be in flight. The same idempotency key never
 * broadcasts twice.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount
} from "@solana/web3.js";
import { LiveSubmitError, isAmbiguousSendError, unconfirmedSend } from "./live-submit.js";

/** https://www.helius.dev/docs/sending-transactions/sender-swqos-only */
export const SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or"
] as const;

export const SENDER_URL = "https://sender.helius-rpc.com/fast?swqos_only=true";
export const MIN_TIP_LAMPORTS = 5_000;
export const DEFAULT_SENDER_TIP_SOL = 0.000005;
/** Official SWQOS example. Added only when the swap did not already set one. */
const PRIORITY_MICRO_LAMPORTS = 200_000;
const SET_COMPUTE_UNIT_PRICE = 3;

const inflight = new Map<string, Promise<string>>();

export function tipLamports(sol: number | undefined): number {
  const n = Number(sol);
  if (!Number.isFinite(n) || n <= 0) return MIN_TIP_LAMPORTS;
  return Math.max(MIN_TIP_LAMPORTS, Math.round(n * 1_000_000_000));
}

export function tipAccount(seed = 0): PublicKey {
  const i = Math.abs(seed) % SENDER_TIP_ACCOUNTS.length;
  return new PublicKey(SENDER_TIP_ACCOUNTS[i]!);
}

function hasPrice(ixs: Array<{ programId: PublicKey; data: Uint8Array }>): boolean {
  return ixs.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === SET_COMPUTE_UNIT_PRICE);
}

function tipInstruction(payer: PublicKey, lamports: number, seed: number) {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: tipAccount(seed),
    lamports: Math.max(MIN_TIP_LAMPORTS, lamports)
  });
}

/** Adds the priority fee (if missing) and the tip. Call before signing. */
export function addTipToLegacy(tx: Transaction, payer: PublicKey, tip: number): void {
  if (!hasPrice(tx.instructions)) {
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }));
  }
  tx.add(tipInstruction(payer, tip, tip));
}

export async function versionedWithTip(
  tx: VersionedTransaction,
  payer: PublicKey,
  tip: number,
  lookup?: (address: PublicKey) => Promise<AddressLookupTableAccount | null>
): Promise<VersionedTransaction> {
  const tables: AddressLookupTableAccount[] = [];
  for (const row of tx.message.addressTableLookups) {
    if (!lookup) return tx;
    const table = await lookup(row.accountKey);
    if (!table) return tx;
    tables.push(table);
  }
  const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  if (!hasPrice(msg.instructions)) {
    msg.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }));
  }
  msg.instructions.push(tipInstruction(payer, tip, tip));
  return new VersionedTransaction(msg.compileToV0Message(tables));
}

export function senderEndpoint(): string {
  const fromEnv = process.env.HELIUS_SENDER_URL?.trim();
  return fromEnv || SENDER_URL;
}

/**
 * One broadcast per idempotency key: Sender, or the fallback when Sender
 * returns a definite error. Never both.
 */
export function sendLiveTransaction(opts: {
  idemKey: string;
  raw: Uint8Array;
  side?: "buy" | "sell";
  fetchImpl?: typeof fetch;
  endpoint?: string;
  fallback: () => Promise<string>;
}): Promise<string> {
  const existing = inflight.get(opts.idemKey);
  if (existing) return existing;
  const job = broadcast(opts).then(
    (sig) => sig,
    (err) => {
      const submitted = err instanceof LiveSubmitError && (err.signature != null || err.submitState === "submitted_unknown");
      if (!submitted) inflight.delete(opts.idemKey);
      throw err;
    }
  );
  inflight.set(opts.idemKey, job);
  return job;
}

async function broadcast(opts: {
  raw: Uint8Array;
  side?: "buy" | "sell";
  fetchImpl?: typeof fetch;
  endpoint?: string;
  fallback: () => Promise<string>;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? senderEndpoint();
  const side = opts.side ?? "buy";
  let rejected = false;
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "sendTransaction",
        params: [Buffer.from(opts.raw).toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 0 }]
      })
    });
    const json = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (res.ok && typeof json?.result === "string" && json.result) return json.result;
    rejected = true;
    if (!res.ok && !json) rejected = true;
  } catch (err) {
    if (isAmbiguousSendError(err)) throw unconfirmedSend(null, side);
    rejected = true;
  }
  if (!rejected) throw unconfirmedSend(null, side);
  try {
    return await opts.fallback();
  } catch (err) {
    if (err instanceof LiveSubmitError) throw err;
    if (isAmbiguousSendError(err)) throw unconfirmedSend(null, side);
    const message = err instanceof Error ? err.message : String(err);
    throw new LiveSubmitError(`LIVE_SWAP_FAILED: ${message}. Nothing was sent.`, "not_submitted", null);
  }
}

/** Test hook. Production keys are unique per attempt. */
export function clearSenderIdem(): void {
  inflight.clear();
}

