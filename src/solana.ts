import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

export const DEFAULT_PLATFORM_FEE_BPS = 85; // 0.85% atomic platform rake
export const MIN_RENT_EXEMPT_LAMPORTS = 890_880; // Standard Solana system account rent-exempt minimum

export function getTreasuryPublicKey(override?: string | PublicKey): PublicKey {
  if (override instanceof PublicKey) return override;
  const raw = override || process.env.NIGHT_DESK_TREASURY_PUBKEY || "11111111111111111111111111111111";
  return new PublicKey(raw);
}

/**
 * Calculates the exact atomic platform rake in lamports for a given trade notional.
 */
export function calculatePlatformFeeLamports(
  tradeAmountLamports: number,
  platformFeeBps: number = DEFAULT_PLATFORM_FEE_BPS
): number {
  if (!(tradeAmountLamports > 0) || !(platformFeeBps > 0)) return 0;
  return Math.floor((tradeAmountLamports * platformFeeBps) / 10_000);
}

/**
 * Creates the atomic SystemProgram.transfer instruction routing the platform rake
 * to the Night Desk treasury inside the same transaction as the user swap (Fixes FIN-01).
 */
export function createAtomicFeeInstruction(params: {
  payer: PublicKey;
  tradeAmountLamports: number;
  platformFeeBps?: number;
  treasuryPubkey?: string | PublicKey;
}): { instruction: TransactionInstruction; feeLamports: number } {
  const feeLamports = calculatePlatformFeeLamports(
    params.tradeAmountLamports,
    params.platformFeeBps ?? DEFAULT_PLATFORM_FEE_BPS
  );
  const toPubkey = getTreasuryPublicKey(params.treasuryPubkey);
  const instruction = SystemProgram.transfer({
    fromPubkey: params.payer,
    toPubkey,
    lamports: feeLamports,
  });
  return { instruction, feeLamports };
}

/**
 * Injects an atomic platform fee instruction into an existing instruction list,
 * guaranteeing zero-leakage fee capture if and only if the swap succeeds.
 */
export function injectAtomicPlatformFee(params: {
  instructions: TransactionInstruction[];
  payer: PublicKey;
  tradeAmountLamports: number;
  platformFeeBps?: number;
  treasuryPubkey?: string | PublicKey;
}): { instructions: TransactionInstruction[]; feeLamports: number } {
  const { instruction, feeLamports } = createAtomicFeeInstruction(params);
  if (feeLamports <= 0) {
    return { instructions: [...params.instructions], feeLamports: 0 };
  }
  return {
    instructions: [...params.instructions, instruction],
    feeLamports,
  };
}

export interface TreasurySweepResult {
  sweptWallets: number;
  totalSweptLamports: number;
  signatures: string[];
}

/**
 * Sweeps excess SOL from sub-wallets into the central Night Desk treasury while
 * preserving rent-exempt minimum + fee buffer on each sub-wallet.
 */
export async function sweepSubWalletsToTreasury(params: {
  connection: Connection;
  subWallets: Keypair[];
  treasuryPubkey?: string | PublicKey;
  keepBufferLamports?: number;
}): Promise<TreasurySweepResult> {
  const {
    connection,
    subWallets,
    treasuryPubkey,
    keepBufferLamports = MIN_RENT_EXEMPT_LAMPORTS + 10_000,
  } = params;
  const treasury = getTreasuryPublicKey(treasuryPubkey);
  const latest = await connection.getLatestBlockhash("confirmed");
  const signatures: string[] = [];
  let totalSweptLamports = 0;
  let sweptWallets = 0;

  for (const wallet of subWallets) {
    const balance = await connection.getBalance(wallet.publicKey, "confirmed");
    const sweepable = balance - keepBufferLamports;
    if (sweepable <= 0) continue;

    const ix = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: treasury,
      lamports: sweepable,
    });
    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    signatures.push(sig);
    totalSweptLamports += sweepable;
    sweptWallets += 1;
  }

  return {
    sweptWallets,
    totalSweptLamports,
    signatures,
  };
}
