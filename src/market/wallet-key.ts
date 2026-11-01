import { existsSync, readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

/**
 * v13.5 desk wallet key. The secret comes from WALLET_PRIVATE_KEY in Austin's .env
 * (base58 as Phantom exports it, or a Solana CLI JSON byte array), or from the
 * WALLET_KEYPAIR_PATH file. It is parsed in memory only. Nothing here logs,
 * returns, or serializes the secret; callers only ever see the public key.
 */
export type WalletKeySource = "env" | "file" | null;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Plain base58 decode (no checksum). Null on any invalid character. */
export function base58Decode(text: string): Uint8Array | null {
  if (!text) return null;
  const bytes: number[] = [0];
  for (const ch of text) {
    const value = B58.indexOf(ch);
    if (value < 0) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** 64-byte secret from base58 or a JSON array. Null when it is not a usable Solana secret key. */
export function parseSecretKey(raw: string | undefined | null): Uint8Array | null {
  const text = (raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (!text) return null;
  let bytes: Uint8Array | null = null;
  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text) as unknown;
      if (!Array.isArray(arr) || arr.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
      bytes = Uint8Array.from(arr as number[]);
    } catch {
      return null;
    }
  } else {
    bytes = base58Decode(text);
  }
  if (!bytes || bytes.length !== 64) return null;
  try {
    Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
  return bytes;
}

export interface WalletKeyInput {
  /** Reads WALLET_PRIVATE_KEY at call time. Never stored on the config object as a string. */
  readEnvSecret?: () => string | undefined;
  keypairPath?: string;
}

/** The signer for a live swap. Env key wins over the file. Null when neither is usable. */
export function loadDeskKeypair(input: WalletKeyInput): { keypair: Keypair; source: Exclude<WalletKeySource, null> } | null {
  const fromEnv = parseSecretKey(input.readEnvSecret?.());
  if (fromEnv) return { keypair: Keypair.fromSecretKey(fromEnv), source: "env" };
  if (input.keypairPath && existsSync(input.keypairPath)) {
    try {
      const fromFile = parseSecretKey(readFileSync(input.keypairPath, "utf8"));
      if (fromFile) return { keypair: Keypair.fromSecretKey(fromFile), source: "file" };
    } catch {
      return null;
    }
  }
  return null;
}

/** True when WALLET_PRIVATE_KEY has any non-blank value (valid or not). */
export function envSecretSet(input: WalletKeyInput): boolean {
  return (input.readEnvSecret?.() ?? "").trim().length > 0;
}
