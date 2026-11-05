/**
 * Opens the connected wallet at most once, and only after TxGuard passes.
 * Simulate mode returns before the opener is touched. Nothing here broadcasts
 * or retries.
 */
import { bytesFromBase64, inspectTx, type GuardCode } from "./guard";

export interface WalletOpener {
  address: string;
  /** Opens the wallet UI. Called at most once per approve. */
  open(unsigned: Uint8Array): Promise<Uint8Array>;
}

export interface ApproveResult {
  opened: boolean;
  signed: Uint8Array | null;
  code: "SIMULATED" | "SIGNED" | "GUARD" | "NO_WALLET" | "NO_TX";
  guard?: GuardCode;
  message: string;
}

export async function approveIntent(input: {
  unsignedTx: string | null;
  wallet: string;
  amountLamports: bigint;
  capLamports: bigint;
  simulateOnly: boolean;
  opener: WalletOpener | null;
}): Promise<ApproveResult> {
  if (input.simulateOnly) {
    return { opened: false, signed: null, code: "SIMULATED", message: "Simulate mode. The wallet stays closed." };
  }
  if (!input.unsignedTx) {
    return { opened: false, signed: null, code: "NO_TX", message: "No unsigned transaction to sign." };
  }
  const verdict = inspectTx({
    unsignedTx: input.unsignedTx,
    wallet: input.wallet,
    amountLamports: input.amountLamports,
    capLamports: input.capLamports
  });
  if (!verdict.ok) {
    return { opened: false, signed: null, code: "GUARD", guard: verdict.code, message: verdict.message ?? "Transaction rejected." };
  }
  if (!input.opener || input.opener.address !== input.wallet) {
    return { opened: false, signed: null, code: "NO_WALLET", message: "Connect the fee-payer wallet first." };
  }
  const bytes = bytesFromBase64(input.unsignedTx);
  const signed = await input.opener.open(bytes);
  return { opened: true, signed, code: "SIGNED", message: "Signed once in the wallet. Night Desk does not broadcast or retry." };
}
