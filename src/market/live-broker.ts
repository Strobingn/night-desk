import { entryPriceAllowed } from "../agents/execution-math.js";
import { HARD_RULES, clampEntrySlippage } from "../rules.js";
import { loadDeskKeypair, type WalletKeyInput } from "./wallet-key.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface LiveSwapRequest {
  side: "buy" | "sell";
  mint: string;
  /** USDC to spend on a buy. */
  sizeUsd?: number;
  /** Token qty on a sell. */
  qty?: number;
  decimals?: number | null;
  /** v13.2 file path. v13.5: WALLET_PRIVATE_KEY (via readEnvSecret) wins when set. */
  keypairPath?: string;
  readEnvSecret?: () => string | undefined;
  rpcUrl: string;
  quoteUrl: string;
  swapUrl: string;
  /** Spot the desk is buying against. A buy quote above the entry cap is not sent. */
  markPriceUsd?: number;
  maxEntrySlippage?: number;
  /** v13.5 sell slippage (exit tolerance). Defaults to the entry cap + 3%. */
  maxExitSlippage?: number;
  /** Exec-lane fetch. Blockhash, simulate, and send do not wait on the 9/min poll budget. */
  rpcFetch?: typeof fetch;
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
 * confirmed LIVE_TRADING=true and a wallet key. The secret stays in Austin's .env
 * (or the keypair file) and is parsed in memory; this module logs the public key only.
 */
export async function executeLiveSwap(req: LiveSwapRequest): Promise<LiveSwapResult> {
  const loaded = loadDeskKeypair({ keypairPath: req.keypairPath, readEnvSecret: req.readEnvSecret });
  if (!loaded) {
    throw new Error("LIVE_NOT_ARMED: no usable wallet key (WALLET_PRIVATE_KEY is empty or invalid)");
  }
  const web3 = await import("@solana/web3.js");
  const keypair = loaded.keypair;
  const connection = req.rpcFetch
    ? new web3.Connection(req.rpcUrl, { commitment: "confirmed", fetch: req.rpcFetch })
    : new web3.Connection(req.rpcUrl, "confirmed");
  const owner = keypair.publicKey.toBase58();
  // v13.5: decimals come from the chain, not the scout feed (a wrong guess sells 1000x off).
  let decimals: number | null = null;
  try {
    const supply = await connection.getTokenSupply(new web3.PublicKey(req.mint));
    decimals = supply.value.decimals;
  } catch {
    decimals = req.decimals ?? null;
  }
  if (decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("LIVE_SWAP_FAILED: token decimals unknown");
  }

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
    inputMint = req.mint;
    outputMint = USDC_MINT;
    amount = Math.floor(req.qty * 10 ** decimals);
    // v13.5: never try to sell more than the wallet holds (fees, rounding, or a manual wallet move).
    const held = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { mint: new web3.PublicKey(req.mint) });
    let raw = 0;
    for (const row of held.value) {
      const amt = (row.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
      if (amt) raw += Number(amt);
    }
    if (!(raw > 0)) throw new Error("LIVE_SWAP_FAILED: wallet holds none of this token");
    amount = Math.min(amount, raw);
  }
  if (!(amount > 0)) throw new Error("LIVE_SWAP_FAILED: amount rounded to zero");

  const quoteEndpoint = new URL(req.quoteUrl);
  quoteEndpoint.searchParams.set("inputMint", inputMint);
  quoteEndpoint.searchParams.set("outputMint", outputMint);
  quoteEndpoint.searchParams.set("amount", String(amount));
  const entryCap = clampEntrySlippage(req.maxEntrySlippage ?? HARD_RULES.maxEntrySlippage);
  const exitCap = Math.min(0.5, Math.max(0.005, req.maxExitSlippage ?? entryCap + HARD_RULES.exitImpactSlack));
  const slipCap = req.side === "buy" ? entryCap : exitCap;
  quoteEndpoint.searchParams.set("slippageBps", String(Math.round(slipCap * 10_000)));
  const quoteRes = await fetch(quoteEndpoint, { signal: AbortSignal.timeout(8000) });
  if (!quoteRes.ok) throw new Error(`LIVE_SWAP_FAILED: quote HTTP ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as { outAmount?: string; inAmount?: string; error?: string };
  if (!quote.outAmount || quote.error) throw new Error(`LIVE_SWAP_FAILED: ${quote.error ?? "empty quote"}`);

  if (req.side === "buy") {
    const quotedQty = Number(quote.outAmount) / 10 ** decimals;
    const quotedPrice = quotedQty > 0 ? req.sizeUsd! / quotedQty : Number.NaN;
    const mark = req.markPriceUsd ?? 0;
    const gate = entryPriceAllowed(mark, quotedPrice, entryCap);
    if (!gate.ok) throw new Error(gate.message);
  }

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
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  // v13.5: a landed-but-failed swap is not a fill.
  if (confirmed?.value?.err) throw new Error(`LIVE_SWAP_FAILED: transaction ${signature} failed on chain`);

  const inAmount = Number(quote.inAmount ?? amount);
  const outAmount = Number(quote.outAmount);
  let qty: number;
  let notionalUsd: number;
  let fillPriceUsd: number;
  if (req.side === "buy") {
    notionalUsd = req.sizeUsd!;
    qty = outAmount / 10 ** decimals;
    fillPriceUsd = qty > 0 ? notionalUsd / qty : 0;
  } else {
    qty = amount / 10 ** decimals;
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
