/** v13.5 wallet card text (pure, unit-tested). Never shows a secret. */
import type { DeskSnapshot, WalletView } from "./types";

/** v13.5 short address: first 4 … last 4. */
export function shortAddress(address: string | null | undefined): string {
  if (!address) return "—";
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** v13.5 the wallet card's status lines (pure, unit-tested). Never shows a secret. */
export function walletLines(w: WalletView | undefined, mode: DeskSnapshot["mode"]): { badge: string; tone: "live" | "armed" | "off"; lines: string[] } {
  if (!w) return { badge: mode === "live" ? "LIVE" : "PAPER", tone: mode === "live" ? "live" : "off", lines: ["Wallet status not reported by this desk build."] };
  const tone = w.live ? "live" : w.keyLoaded ? "armed" : "off";
  const badge = w.live ? "LIVE ON" : "LIVE OFF";
  const lines: string[] = [];
  lines.push(
    w.keyLoaded
      ? `Key loaded: yes (${w.keySource === "env" ? "WALLET_PRIVATE_KEY" : "keypair file"}).`
      : w.keyInvalid
        ? "Key loaded: no. WALLET_PRIVATE_KEY is set but is not a Solana private key."
        : "Key loaded: no. Fill WALLET_PRIVATE_KEY= in Austin's .env."
  );
  if (w.balanceError) lines.push(`Balance: unavailable (${w.balanceError}).`);
  lines.push(w.live ? "LIVE is ON. One-tap and auto-buys send real swaps." : `LIVE is OFF. ${w.liveRequested ? "LIVE_TRADING=true but the desk could not arm." : "LIVE_TRADING is not true."}`);
  if (w.rpcPublic) lines.push("RPC: free public Solana RPC (rate limited).");
  return { badge, tone, lines };
}

