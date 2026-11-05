import { existsSync, readFileSync } from "node:fs";

/**
 * v13.5 Austin's .env is not loaded by anything else (the keepalive runs `npm run paper:live`
 * with the Windows environment). This reads ONLY the allow-listed wallet keys from .env into
 * process.env when they are not already set. Values are never logged or returned.
 *
 * - WALLET_PRIVATE_KEY / WALLET_KEYPAIR_PATH: the desk wallet key.
 * - LIVE_TRADING: only the exact string "true" arms live (with a valid key). Anything else = paper.
 * - SOLANA_RPC_URL from .env becomes DESK_WALLET_RPC_URL: used for live swaps and the wallet card
 *   only, so the Scout and price loop keep the RPC they use today.
 */
export const DESK_ENV_KEYS = ["WALLET_PRIVATE_KEY", "WALLET_KEYPAIR_PATH", "LIVE_TRADING", "SOLANA_RPC_URL"] as const;

export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out.set(key, value);
  }
  return out;
}

/** Returns the names (never values) it applied. */
export function loadDeskEnv(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(file)) return [];
  let parsed: Map<string, string>;
  try {
    parsed = parseEnvFile(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const applied: string[] = [];
  for (const key of DESK_ENV_KEYS) {
    const value = parsed.get(key);
    if (value == null || value === "") continue;
    const target = key === "SOLANA_RPC_URL" ? "DESK_WALLET_RPC_URL" : key;
    if (env[target] != null && env[target] !== "") continue;
    env[target] = value;
    applied.push(target);
  }
  return applied;
}

/** Exactly LIVE_TRADING=true in the file. Used by the paper:live launcher. */
export function envFileLiveFlag(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    return parseEnvFile(readFileSync(file, "utf8")).get("LIVE_TRADING") === "true";
  } catch {
    return false;
  }
}
