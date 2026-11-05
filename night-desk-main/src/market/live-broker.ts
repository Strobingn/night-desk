import { readFileSync } from "node:fs";
import { HARD_RULES } from "../rules.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface LiveSwapRequest {
  side: "buy" | "sell";
  mint: string;
  /** USDC to spend on a buy. */
  sizeUsd?: number;
  /** Token qty on a sell. */
  qty?: number;
  decimals?: number | null;
  keypairPath: string;
  rpcUrl: string;
  quoteUrl: string;
  swapUrl: string;
}

export interface LiveSwapResult {
  signature: string;
  fillPriceUsd: number;
  qty: number;
  notionalUsd: number;
  feeUsd: number;
  slippage: number;
}

/**
 * Live swaps go through Jupiter and only run when the orchestrator has already
 * confirmed LIVE_TRADING=true and a keypair path. The secret stays on disk;
 * this module logs the public key only.
 */
export async function executeLiveSwap(req: LiveSwapRequest): Promise<LiveSwapResult> {
  if (!req.keypairPath) {
    throw new Error("LIVE_NOT_ARMED: WALLET_KEYPAIR_PATH is empty");
  }
  const secret = JSON.parse(readFileSync(req.keypairPath, "utf8")) as number[];
  if (!Array.isArray(secret) || secret.length < 64) {
    throw new Error("LIVE_NOT_ARMED: keypair file is not a Solana JSON secret key");
  }
  const web3 = await import("@solana/web3.js");
  const keypair = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new web3.Connection(req.rpcUrl, "confirmed");
  const owner = keypair.publicKey.toBase58();

  let inputMint: string;
  let outputMint: string;
  let amount: number;
  if (req.side === "buy") {
    if (!(req.sizeUsd && req.sizeUsd > 0)) throw new Error("LIVE_SWAP_FAILED: buy size missing");
    inputMint = USDC_MINT;
    outputMint = req.mint;
    amount = Math.floor(req.sizeUsd * 1_000_000);
  } else {
    if (!(req.qty && req.qty > 0)) throw new Error("LIVE_SWAP_FAILED: sell qty missing");
    if (req.decimals == null) throw new Error("LIVE_SWAP_FAILED: token decimals unknown");
    inputMint = req.mint;
    outputMint = USDC_MINT;
    amount = Math.floor(req.qty * 10 ** req.decimals);
  }
  if (!(amount > 0)) throw new Error("LIVE_SWAP_FAILED: amount rounded to zero");

  const quoteEndpoint = new URL(req.quoteUrl);
  quoteEndpoint.searchParams.set("inputMint", inputMint);
  quoteEndpoint.searchParams.set("outputMint", outputMint);
  quoteEndpoint.searchParams.set("amount", String(amount));
  quoteEndpoint.searchParams.set("slippageBps", "100");
  const quoteRes = await fetch(quoteEndpoint, { signal: AbortSignal.timeout(8000) });
  if (!quoteRes.ok) throw new Error(`LIVE_SWAP_FAILED: quote HTTP ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as { outAmount?: string; inAmount?: string; error?: string };
  if (!quote.outAmount || quote.error) throw new Error(`LIVE_SWAP_FAILED: ${quote.error ?? "empty quote"}`);

  const swapRes = await fetch(req.swapUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!swapRes.ok) throw new Error(`LIVE_SWAP_FAILED: swap HTTP ${swapRes.status}`);
  const swap = (await swapRes.json()) as { swapTransaction?: string; error?: string };
  if (!swap.swapTransaction) throw new Error(`LIVE_SWAP_FAILED: ${swap.error ?? "no swap transaction"}`);

  const tx = web3.VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  tx.sign([keypair]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 });
  await connection.confirmTransaction(signature, "confirmed");

  const inAmount = Number(quote.inAmount ?? amount);
  const outAmount = Number(quote.outAmount);
  let qty: number;
  let notionalUsd: number;
  let fillPriceUsd: number;
  if (req.side === "buy") {
    notionalUsd = req.sizeUsd!;
    const decimals = req.decimals ?? 6;
    qty = outAmount / 10 ** decimals;
    fillPriceUsd = qty > 0 ? notionalUsd / qty : 0;
  } else {
    qty = req.qty!;
    notionalUsd = outAmount / 1_000_000;
    fillPriceUsd = qty > 0 ? notionalUsd / qty : 0;
  }
  const feeUsd = notionalUsd * (HARD_RULES.feeBps / 10_000);
  console.log(`[executor] live ${req.side} ${req.mint} owner ${owner} sig ${signature}`);
  return {
    signature,
    fillPriceUsd,
    qty,
    notionalUsd,
    feeUsd,
    slippage: Math.abs(inAmount - amount) / amount || 0.01
  };
}
