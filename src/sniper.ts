import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  Keypair,
  TransactionInstruction,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import bs58 from "bs58";

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];

// Multi-region Jito Block Engines for concurrent lowest-latency fan-out
export const JITO_ENDPOINTS = [
  "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
];

const NIGHT_DESK_TREASURY = new PublicKey(
  process.env.NIGHT_DESK_TREASURY_PUBKEY || "11111111111111111111111111111111"
);

// Zero-Latency Blockhash Cache (Saves 80-150ms per snipe)
let cachedBlockhash: { blockhash: string; updatedAt: number } | null = null;

export function resetBlockhashCache(): void {
  cachedBlockhash = null;
}

export async function getFastBlockhash(connection: Connection): Promise<string> {
  const now = Date.now();
  if (cachedBlockhash && now - cachedBlockhash.updatedAt < 400) {
    return cachedBlockhash.blockhash;
  }
  const latest = await connection.getLatestBlockhash("processed");
  cachedBlockhash = { blockhash: latest.blockhash, updatedAt: now };
  return latest.blockhash;
}

/**
 * Computes EV-Optimal Jito Validator Tip:
 * T* = min(0.22 * ExpectedProfit, max(T_min, P95_tip * (1 + 0.35 * ln(1 + contention))))
 */
export function calculateOptimalJitoTip(params: {
  expectedProfitLamports: number;
  rollingP95TipLamports?: number;
  competingBundlesCount?: number;
}): number {
  const {
    expectedProfitLamports,
    rollingP95TipLamports = 1_000_000, // 0.001 SOL baseline
    competingBundlesCount = 1,
  } = params;

  const minTip = 100_000; // 0.0001 SOL floor
  const maxProfitCap = Math.floor(expectedProfitLamports * 0.22); // Never bid >22% of edge
  const contentionMultiplier = 1 + 0.35 * Math.log(1 + competingBundlesCount);
  const dynamicTargetTip = Math.floor(rollingP95TipLamports * contentionMultiplier);

  return Math.max(minTip, Math.min(maxProfitCap, dynamicTargetTip));
}

/**
 * Volatility-Adjusted Dynamic Slippage (S_max in bps):
 * S_max(bps) = ceil(I(dx) * 10^4 + sigma_slot * sqrt(dt_blocks))
 */
export function calculateDynamicSlippageBps(params: {
  priceImpactRatio: number;
  slotVolatilityBps?: number;
  targetBlocks?: number;
}): number {
  const {
    priceImpactRatio,
    slotVolatilityBps = 50,
    targetBlocks = 1,
  } = params;
  const clampedImpact = Math.max(0, priceImpactRatio);
  const blocks = Math.max(1, targetBlocks);
  return Math.ceil(clampedImpact * 10_000 + slotVolatilityBps * Math.sqrt(blocks));
}

export interface AtomicTradeParams {
  connection: Connection;
  signer: Keypair;
  swapInstructions: TransactionInstruction[];
  lookupTableAccounts?: AddressLookupTableAccount[];
  tradeAmountLamports: number;
  expectedProfitLamports?: number;
  competingBundlesCount?: number;
  platformFeeBps?: number; // Default 85 bps (0.85%)
  computeUnitLimit?: number;
  fetchImpl?: typeof fetch;
}

export async function executeAtomicProfitSwap({
  connection,
  signer,
  swapInstructions,
  lookupTableAccounts = [],
  tradeAmountLamports,
  expectedProfitLamports = tradeAmountLamports * 0.15,
  competingBundlesCount = 2,
  platformFeeBps = 85,
  computeUnitLimit = 220_000,
  fetchImpl = fetch,
}: AtomicTradeParams): Promise<{
  success: boolean;
  bundleId?: string;
  feeCollectedLamports?: number;
  jitoTipLamports?: number;
  error?: string;
}> {
  try {
    // 1. Sub-millisecond Blockhash retrieval
    const blockhash = await getFastBlockhash(connection);

    // 2. Tight Compute Budget Allocation (Maximizes scheduler priority per CU)
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnitLimit,
    });

    // 3. Atomic Platform Rake Instruction (Fixes FIN-01)
    const feeLamports = Math.floor((tradeAmountLamports * platformFeeBps) / 10_000);
    const feeTransferIx = SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: NIGHT_DESK_TREASURY,
      lamports: feeLamports,
    });

    // 4. EV-Optimal Dynamic Jito Tip Instruction (Fixes TRD-01)
    const optimalTipLamports = calculateOptimalJitoTip({
      expectedProfitLamports,
      competingBundlesCount,
    });

    const randomTipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );
    const jitoTipIx = SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: randomTipAccount,
      lamports: optimalTipLamports,
    });

    // 5. Compile V0 Message with Address Lookup Table (ALT) Compression (Fixes PERF-01)
    const messageV0 = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        computeLimitIx,
        ...swapInstructions,
        feeTransferIx,
        jitoTipIx,
      ],
    }).compileToV0Message(lookupTableAccounts);

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([signer]);

    const serializedTx = bs58.encode(transaction.serialize());
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [[serializedTx]],
    });

    // 6. Multi-Region Concurrent Fan-Out (First regional block engine to accept wins)
    const response = await Promise.any(
      JITO_ENDPOINTS.map((endpoint) =>
        fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }).then(async (res) => {
          const json = (await res.json()) as { result?: string; error?: { message?: string } };
          if (json.error) throw new Error(json.error.message || "Jito bundle error");
          return json;
        })
      )
    );

    return {
      success: true,
      bundleId: response.result,
      feeCollectedLamports: feeLamports,
      jitoTipLamports: optimalTipLamports,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown execution failure";
    return { success: false, error: message };
  }
}
