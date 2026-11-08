/**
 * Manual live buy/sell on a pump.fun bonding curve or PumpSwap pool.
 *
 * Instructions come from @pump-fun/pump-sdk and @pump-fun/pump-swap-sdk, read
 * through SOLANA_RPC_URL (or DESK_WALLET_RPC_URL). This does not call
 * frontend-api-v3.pump.fun and does not use PumpPortal trade-local.
 * A failed simulation is not broadcast. There is no paper fill from this path.
 */
import { Transaction } from "@solana/web3.js";
import { entryPriceAllowed } from "../agents/execution-math.js";
import { HARD_RULES } from "../rules.js";
import { IntentError, buildIntent, serializeUnsigned } from "../pump/intents.js";
import { solanaConnection, type PumpConnection } from "../pump/rpc.js";
import type { LiveSwapResult } from "./live-broker.js";
import { loadDeskKeypair } from "./wallet-key.js";

export function usesPumpRoute(input: { dex?: string | null; priceFeed?: string | null }): boolean {
  if (input.priceFeed === "chain") return true;
  const dex = (input.dex ?? "").toLowerCase();
  return dex === "pump.fun" || dex.startsWith("pump.fun ");
}

export interface PumpLiveRequest {
  side: "buy" | "sell";
  mint: string;
  sizeUsd?: number;
  qty?: number;
  decimals?: number | null;
  solPriceUsd: number;
  markPriceUsd?: number;
  /** Fraction, e.g. 0.03. */
  slippageFraction?: number;
  keypairPath?: string;
  readEnvSecret?: () => string | undefined;
  rpcUrl: string;
  /** Tests pass a fixture connection. Production uses SOLANA_RPC_URL. */
  connection?: PumpConnection;
  /** Tests capture the signed bytes. Production sends them on rpcUrl. */
  broadcast?: (raw: Uint8Array) => Promise<{ signature: string; err: unknown }>;
}

async function defaultBroadcast(rpcUrl: string, raw: Uint8Array): Promise<{ signature: string; err: unknown }> {
  const web3 = await import("@solana/web3.js");
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 2 });
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  return { signature, err: confirmed.value.err ?? null };
}

export async function executePumpLiveSwap(req: PumpLiveRequest): Promise<LiveSwapResult> {
  if (!req.rpcUrl?.trim()) throw new Error("LIVE_SWAP_FAILED: SOLANA_RPC_URL is missing. Nothing was sent.");
  const loaded = loadDeskKeypair({ keypairPath: req.keypairPath, readEnvSecret: req.readEnvSecret });
  if (!loaded) throw new Error("LIVE_NOT_ARMED: no usable wallet key (WALLET_PRIVATE_KEY is empty or invalid)");
  if (!(req.solPriceUsd > 0) || !Number.isFinite(req.solPriceUsd)) {
    throw new Error("LIVE_SWAP_FAILED: no fresh SOL/USD price. Nothing was sent.");
  }
  const decimals = req.decimals ?? 6;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("LIVE_SWAP_FAILED: token decimals unknown");
  const slip = req.slippageFraction ?? HARD_RULES.maxEntrySlippage;
  let solLamports: bigint | undefined;
  let tokenAmount: bigint | undefined;
  if (req.side === "buy") {
    if (!(req.sizeUsd && req.sizeUsd > 0)) throw new Error("LIVE_SWAP_FAILED: buy size missing");
    solLamports = BigInt(Math.max(0, Math.floor((req.sizeUsd / req.solPriceUsd) * 1_000_000_000)));
    if (solLamports <= 1n) throw new Error("LIVE_SWAP_FAILED: SOL amount rounded to zero");
  } else {
    if (!(req.qty && req.qty > 0)) throw new Error("LIVE_SWAP_FAILED: sell qty missing");
    tokenAmount = BigInt(Math.floor(req.qty * 10 ** decimals));
    if (tokenAmount <= 0n) throw new Error("LIVE_SWAP_FAILED: token amount rounded to zero");
  }
  const connection = req.connection ?? solanaConnection(req.rpcUrl);
  let built;
  try {
    built = await buildIntent(connection, {
      wallet: loaded.keypair.publicKey.toBase58(),
      mint: req.mint,
      side: req.side,
      solLamports,
      tokenAmount,
      slippageBps: Math.round(slip * 10_000)
    });
  } catch (err) {
    const message = err instanceof IntentError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    throw new Error(`LIVE_SWAP_FAILED: ${message}`);
  }
  const qty = Number(built.tokenAmount) / 10 ** decimals;
  const sol = Number(built.solLamports) / 1_000_000_000;
  const notionalUsd = req.side === "buy" ? req.sizeUsd! : sol * req.solPriceUsd;
  const fillPriceUsd = qty > 0 ? notionalUsd / qty : 0;
  if (req.side === "buy") {
    const gate = entryPriceAllowed(req.markPriceUsd ?? 0, fillPriceUsd, slip);
    if (!gate.ok) throw new Error(gate.message);
  }
  if (!(qty > 0) || !(fillPriceUsd > 0)) throw new Error("LIVE_SWAP_FAILED: pump quote was not a usable fill. Nothing was sent.");
  const blockhash = await connection.getLatestBlockhash();
  const unsigned = serializeUnsigned(loaded.keypair.publicKey.toBase58(), blockhash, built.instructions);
  const sim = await connection.simulateTransaction(unsigned.tx);
  if (sim.err) throw new Error(`LIVE_SWAP_FAILED: simulation ${sim.err}. Nothing was sent.`);
  const tx = Transaction.from(Buffer.from(unsigned.base64, "base64"));
  tx.partialSign(loaded.keypair);
  if (!tx.signature) throw new Error("LIVE_SWAP_FAILED: transaction was not signed. Nothing was sent.");
  const raw = tx.serialize();
  const sent = await (req.broadcast ?? ((bytes) => defaultBroadcast(req.rpcUrl, bytes)))(raw);
  if (sent.err) throw new Error(`LIVE_SWAP_FAILED: transaction ${sent.signature} failed on chain`);
  const feeLamports = Number(built.quote.feeLamports);
  const feeUsd = Number.isFinite(feeLamports) && feeLamports > 0 ? (feeLamports / 1_000_000_000) * req.solPriceUsd : 0;
  const mark = req.markPriceUsd ?? fillPriceUsd;
  const slippage = mark > 0 ? Math.abs(fillPriceUsd - mark) / mark : 0;
  console.log(`[executor] pump live ${req.side} ${req.mint} venue ${built.venue} owner ${loaded.keypair.publicKey.toBase58()} sig ${sent.signature}`);
  return { signature: sent.signature, fillPriceUsd, qty, notionalUsd, feeUsd, slippage };
}
