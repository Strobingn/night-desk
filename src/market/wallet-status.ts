import { loadDeskKeypair, envSecretSet, type WalletKeyInput, type WalletKeySource } from "./wallet-key.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Lamports kept for fees. A live buy is refused below this. */
export const MIN_FEE_SOL = 0.005;

export interface DeskWalletStatus {
  /** A usable key is loaded (WALLET_PRIVATE_KEY or the keypair file). The secret is not returned. */
  keypairPresent: boolean;
  /** Base58 public address for display. Null when no usable key is loaded. */
  walletPublicKey: string | null;
  /** v13.5 where the key came from: "env" (WALLET_PRIVATE_KEY), "file" (WALLET_KEYPAIR_PATH), or null. */
  keySource: WalletKeySource;
  /** v13.5 WALLET_PRIVATE_KEY has a value that is not a Solana secret key. */
  keyInvalid: boolean;
}

/**
 * Derive the public address from the desk key. Night Desk has no wallet vault;
 * the secret stays in Austin's .env (or the keypair file) and never leaves the process.
 */
export function inspectDeskWallet(input: WalletKeyInput): DeskWalletStatus {
  const loaded = loadDeskKeypair(input);
  const keyInvalid = envSecretSet(input) && loaded?.source !== "env";
  if (!loaded) return { keypairPresent: false, walletPublicKey: null, keySource: null, keyInvalid };
  return { keypairPresent: true, walletPublicKey: loaded.keypair.publicKey.toBase58(), keySource: loaded.source, keyInvalid };
}

/** v13.2 name kept for callers and tests: file-only inspection. */
export function inspectDeskKeypair(keypairPath?: string): { keypairPresent: boolean; walletPublicKey: string | null } {
  const status = inspectDeskWallet({ keypairPath });
  return { keypairPresent: status.keypairPresent, walletPublicKey: status.walletPublicKey };
}

export interface WalletBalances {
  sol: number | null;
  usdc: number | null;
  at: number;
  error: string | null;
}

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${body.error.message ?? "error"}`);
  return body.result;
}

/** Read-only SOL and USDC balance for a public address. Never signs anything. */
export async function fetchWalletBalances(fetchImpl: typeof fetch, rpcUrl: string, owner: string): Promise<WalletBalances> {
  const at = Date.now();
  try {
    const bal = (await rpc(fetchImpl, rpcUrl, "getBalance", [owner, { commitment: "confirmed" }])) as { value?: number };
    const sol = typeof bal?.value === "number" && Number.isFinite(bal.value) ? bal.value / 1e9 : null;
    const accounts = (await rpc(fetchImpl, rpcUrl, "getTokenAccountsByOwner", [
      owner,
      { mint: USDC_MINT },
      { encoding: "jsonParsed", commitment: "confirmed" }
    ])) as { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } } }> };
    let usdc = 0;
    for (const row of accounts?.value ?? []) {
      const ui = row.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof ui === "number" && Number.isFinite(ui)) usdc += ui;
    }
    if (sol == null) return { sol: null, usdc: null, at, error: "RPC returned no SOL balance" };
    return { sol, usdc: Math.floor(usdc * 1e6) / 1e6, at, error: null };
  } catch (err) {
    return { sol: null, usdc: null, at, error: err instanceof Error ? err.message : String(err) };
  }
}

/** True when the RPC URL is the free public Solana endpoint (rate limited). */
export function isPublicRpc(rpcUrl: string): boolean {
  return /api\.mainnet-beta\.solana\.com/i.test(rpcUrl);
}
