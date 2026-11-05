import { readFileSync } from "node:fs";
import type { RugLookup, RugRegistry } from "../types.js";

/** Demo deployer used by the replay tape. Not a real mainnet wallet. */
export const DEMO_RUG_WALLET = "RugDev111111111111111111111111111111111";
export const DEMO_CLEAN_WALLET = "CleanDev1111111111111111111111111111111";

export class StaticRugRegistry implements RugRegistry {
  constructor(private readonly wallets: Map<string, string>) {}

  async lookup(wallet?: string | null): Promise<RugLookup> {
    if (!wallet) return { status: "unknown", evidence: "no wallet" };
    const evidence = this.wallets.get(wallet);
    if (evidence) return { status: "rugged", evidence };
    return { status: "clean" };
  }
}

export function loadRugWalletMap(filePath?: string): Map<string, string> {
  const wallets = new Map<string, string>();
  wallets.set(DEMO_RUG_WALLET, "replay fixture: serial rug deployer");
  if (!filePath) return wallets;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { wallets?: Record<string, string> };
    for (const [address, reason] of Object.entries(parsed.wallets ?? {})) {
      if (address && reason) wallets.set(address, reason);
    }
  } catch (err) {
    console.error(`[rug-registry] could not read ${filePath}`, err);
  }
  return wallets;
}

/**
 * Static list first. An optional HTTP registry may add hits.
 * Transport failures do not fail the check open beyond the static list:
 * the lookup returns clean/unknown and Filter still applies every other hard rule.
 * Set RUGCHECK-style history via `devRug` on the token when a report names the deployer.
 */
export class LayeredRugRegistry implements RugRegistry {
  constructor(
    private readonly local: RugRegistry,
    private readonly remote?: (wallet: string) => Promise<RugLookup>
  ) {}

  async lookup(wallet?: string | null): Promise<RugLookup> {
    const local = await this.local.lookup(wallet);
    if (local.status === "rugged" || !wallet || !this.remote) return local;
    try {
      const remote = await this.remote(wallet);
      if (remote.status === "rugged") return remote;
      return local.status === "clean" ? local : remote;
    } catch {
      return local;
    }
  }
}
