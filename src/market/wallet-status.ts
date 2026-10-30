import { existsSync, readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

export interface DeskWalletStatus {
  /** Path is set and the file is a Solana CLI JSON keypair. The secret is not returned. */
  keypairPresent: boolean;
  /** Base58 public address for display. Null when the file is missing or unreadable. */
  walletPublicKey: string | null;
}

/**
 * Read the desk-host keypair only to derive a public address.
 * Night Desk has no wallet vault. The secret stays in WALLET_KEYPAIR_PATH on Austin.
 */
export function inspectDeskKeypair(keypairPath?: string): DeskWalletStatus {
  if (!keypairPath) return { keypairPresent: false, walletPublicKey: null };
  if (!existsSync(keypairPath)) return { keypairPresent: false, walletPublicKey: null };
  try {
    const secret = JSON.parse(readFileSync(keypairPath, "utf8")) as unknown;
    if (!Array.isArray(secret) || secret.length < 64) return { keypairPresent: false, walletPublicKey: null };
    const bytes = Uint8Array.from(secret);
    if (bytes.length < 64 || bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return { keypairPresent: false, walletPublicKey: null };
    }
    const key = Keypair.fromSecretKey(bytes);
    return { keypairPresent: true, walletPublicKey: key.publicKey.toBase58() };
  } catch {
    return { keypairPresent: false, walletPublicKey: null };
  }
}
