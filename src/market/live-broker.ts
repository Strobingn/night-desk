import { readFileSync } from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, SystemInstruction,
  TransactionMessage, VersionedTransaction,
  type VersionedTransactionResponse
} from "@solana/web3.js";
import { resolveLiveExecution, type LiveExecutionOptions } from "./live-options.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface PreparedLiveOrder {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  mint: string;
  side: "buy" | "sell";
  at: number;
}

export interface LiveSwapRequest {
  side: "buy" | "sell";
  mint: string;
  sizeUsd?: number;
  qty?: number;
  /** Preserve the exact amount received on-chain for a later sell. */
  rawQty?: string;
  decimals?: number | null;
  markUsd?: number;
  keypairPath: string;
  rpcUrl: string;
  quoteUrl: string;
  swapUrl: string;
  apiKey?: string;
  execution?: LiveExecutionOptions;
  /** Persist synchronously before the first network submission. */
  onPrepared?: (order: PreparedLiveOrder) => void;
}

export interface LiveSwapResult {
  signature: string;
  bundleId?: string;
  fillPriceUsd: number;
  qty: number;
  rawQty: string;
  notionalUsd: number;
  feeUsd: number;
  proceedsUsd?: number;
  networkFeeLamports: number;
  slippage: number;
}

export class LiveSwapError extends Error {
  constructor(message: string, readonly outcome: "failed" | "unknown", readonly signature?: string) {
    super(message);
  }
}

export function atomicAmount(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("LIVE_SWAP_FAILED: invalid amount or decimals");
  }
  const raw = Math.floor(value * 10 ** decimals);
  if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error("LIVE_SWAP_FAILED: unsafe or zero atomic amount; exact raw quantity required");
  return String(raw);
}

function positiveAmount(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error("LIVE_SWAP_FAILED: invalid atomic amount");
  const value = BigInt(raw);
  if (value > 18_446_744_073_709_551_615n) throw new Error("LIVE_SWAP_FAILED: amount exceeds u64");
  return value;
}

/** Base58 encoding for a transaction's 64-byte signature. No new runtime dependency. */
export function signatureBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = "1" + out; }
  return out;
}

/** Use transaction balance deltas, never quote output as a fill. */
export function confirmedFill(
  req: LiveSwapRequest, owner: string, receipt: VersionedTransactionResponse,
  expectedInput: bigint, minimumOutput: bigint, expectedFee: bigint, feeAccount?: string
): Omit<LiveSwapResult, "signature" | "bundleId"> {
  const meta = receipt.meta;
  if (!meta || meta.err) throw new Error("LIVE_SWAP_FAILED: confirmed transaction failed or has no metadata");
  if (!meta.preTokenBalances || !meta.postTokenBalances) throw new Error("LIVE_SWAP_FAILED: token balance metadata unavailable");
  const delta = (mint: string): bigint => {
    const sum = (rows: NonNullable<typeof meta.preTokenBalances>) => rows
      .filter((row) => row.owner === owner && row.mint === mint)
      .reduce((total, row) => total + BigInt(row.uiTokenAmount.amount), 0n);
    return sum(meta.postTokenBalances!) - sum(meta.preTokenBalances!);
  };
  const tokenDelta = delta(req.mint);
  const usdcDelta = delta(USDC_MINT);
  const input = req.side === "buy" ? -usdcDelta : -tokenDelta;
  const output = req.side === "buy" ? tokenDelta : usdcDelta;
  if (input !== expectedInput || output < minimumOutput || output <= 0n) {
    throw new Error("LIVE_SWAP_FAILED: confirmed balances differ from the bounded order; reconciliation required");
  }
  let fee = 0n;
  if (feeAccount) {
    const keys = [...receipt.transaction.message.staticAccountKeys,
      ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])];
    const index = keys.findIndex((key) => key.toBase58() === feeAccount);
    const amount = (rows: NonNullable<typeof meta.preTokenBalances>) =>
      rows.filter((row) => row.accountIndex === index && row.mint === USDC_MINT)
        .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
    fee = amount(meta.postTokenBalances) - amount(meta.preTokenBalances);
    if (index < 0 || fee !== expectedFee) throw new Error("LIVE_SWAP_FAILED: platform fee not verified in confirmed balances");
  }
  const rawQty = (req.side === "buy" ? tokenDelta : -tokenDelta).toString();
  const qty = Number(rawQty) / 10 ** req.decimals!;
  const netUsd = Number(req.side === "buy" ? -usdcDelta : usdcDelta) / 1_000_000;
  const feeUsd = Number(fee) / 1_000_000;
  const notionalUsd = req.side === "buy" ? netUsd : netUsd + feeUsd;
  const fillPriceUsd = notionalUsd / qty;
  if (![qty, netUsd, fillPriceUsd].every((n) => Number.isFinite(n) && n > 0)) throw new Error("LIVE_SWAP_FAILED: invalid confirmed fill");
  return {
    qty, rawQty, fillPriceUsd, notionalUsd, feeUsd,
    proceedsUsd: req.side === "sell" ? netUsd : undefined,
    networkFeeLamports: meta.fee,
    slippage: req.markUsd && req.markUsd > 0 ? Math.abs(fillPriceUsd - req.markUsd) / req.markUsd : 0
  };
}

/** The caller must arm live mode and own the persistent single-order guard. */
export async function executeLiveSwap(
  req: LiveSwapRequest,
  deps: { connection?: Connection; fetchImpl?: typeof fetch; signer?: Keypair } = {}
): Promise<LiveSwapResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const options = req.execution ?? resolveLiveExecution({});
  // Revalidate programmatic callers; invalid settings must never loosen the cap.
  if (!Number.isInteger(options.slippageBps) || options.slippageBps < 1 || options.slippageBps > 100 ||
      !Number.isFinite(options.maxPriceImpactPct) || options.maxPriceImpactPct <= 0 || options.maxPriceImpactPct > 0.01 ||
      !Number.isInteger(options.platformFeeBps) || options.platformFeeBps < 0 || options.platformFeeBps > 100 ||
      (options.platformFeeBps > 0 && !options.feeAccount) || !["rpc", "jito"].includes(options.transport) ||
      !Number.isSafeInteger(options.jitoTipLamports) || options.jitoTipLamports < 1000 || options.jitoTipLamports > 1_000_000) {
    throw new Error("LIVE_SWAP_FAILED: invalid execution options");
  }
  if (req.decimals == null || !Number.isInteger(req.decimals) || req.decimals < 0 || req.decimals > 18) {
    throw new Error("LIVE_SWAP_FAILED: token decimals unknown or invalid");
  }
  new PublicKey(req.mint);
  if (req.mint === USDC_MINT) throw new Error("LIVE_SWAP_FAILED: token must differ from USDC");
  if (!req.keypairPath && !deps.signer) throw new Error("LIVE_NOT_ARMED: WALLET_KEYPAIR_PATH is empty");
  let signer = deps.signer;
  if (!signer) {
    const secret: unknown = JSON.parse(readFileSync(req.keypairPath, "utf8"));
    if (!Array.isArray(secret) || secret.length !== 64 || secret.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error("LIVE_NOT_ARMED: invalid Solana JSON keypair");
    }
    signer = Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const connection = deps.connection ?? new Connection(req.rpcUrl, "confirmed");
  const owner = signer.publicKey.toBase58();
  const inputMint = req.side === "buy" ? USDC_MINT : req.mint;
  const outputMint = req.side === "buy" ? req.mint : USDC_MINT;
  const amount = req.side === "buy" ? atomicAmount(req.sizeUsd!, 6) : req.rawQty ?? atomicAmount(req.qty!, req.decimals);
  const expectedInput = positiveAmount(amount);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (req.apiKey) headers["x-api-key"] = req.apiKey;
  const quoteEndpoint = new URL(req.quoteUrl);
  if (quoteEndpoint.protocol !== "https:" || new URL(req.swapUrl).protocol !== "https:") throw new Error("LIVE_SWAP_FAILED: Jupiter endpoints must use HTTPS");
  quoteEndpoint.searchParams.set("inputMint", inputMint);
  quoteEndpoint.searchParams.set("outputMint", outputMint);
  quoteEndpoint.searchParams.set("amount", amount);
  quoteEndpoint.searchParams.set("slippageBps", String(options.slippageBps));
  quoteEndpoint.searchParams.set("swapMode", "ExactIn");
  quoteEndpoint.searchParams.set("platformFeeBps", String(options.platformFeeBps));
  const quoteRes = await fetchImpl(quoteEndpoint, { headers, signal: AbortSignal.timeout(8000) });
  if (!quoteRes.ok) throw new Error(`LIVE_SWAP_FAILED: quote HTTP ${quoteRes.status}`);
  // Preserve unknown routing fields for /swap.
  const quote = await quoteRes.json() as Record<string, unknown>;
  const outAmount = positiveAmount(quote.outAmount);
  const minimumOutput = positiveAmount(quote.otherAmountThreshold);
  const impact = Number(quote.priceImpactPct);
  if (quote.error || quote.inputMint !== inputMint || quote.outputMint !== outputMint || quote.swapMode !== "ExactIn" ||
      positiveAmount(quote.inAmount) !== expectedInput || minimumOutput > outAmount ||
      !Number.isInteger(quote.slippageBps) || Number(quote.slippageBps) < 0 || Number(quote.slippageBps) > options.slippageBps ||
      typeof quote.priceImpactPct !== "string" || !Number.isFinite(impact) || impact < 0 || impact > options.maxPriceImpactPct) {
    throw new Error("LIVE_SWAP_FAILED: quote exceeds order bounds or price-impact limit");
  }
  if (minimumOutput < outAmount * BigInt(10_000 - options.slippageBps) / 10_000n) throw new Error("LIVE_SWAP_FAILED: quote minimum output is too low");
  const platformFee = quote.platformFee as { feeBps?: unknown; amount?: unknown } | null;
  let expectedFee = 0n;
  let feeBefore = 0n;
  if (options.platformFeeBps > 0) {
    if (platformFee?.feeBps !== options.platformFeeBps) throw new Error("LIVE_SWAP_FAILED: platform fee missing from quote");
    expectedFee = positiveAmount(platformFee.amount);
    const feeInfo = (await connection.getParsedAccountInfo(new PublicKey(options.feeAccount!), "confirmed")).value;
    const parsed = feeInfo && "parsed" in feeInfo.data ? feeInfo.data.parsed as { info?: { mint?: string; owner?: string; state?: string; tokenAmount?: { amount?: string } } } : null;
    if (feeInfo?.owner.toBase58() !== TOKEN_PROGRAM || parsed?.info?.mint !== USDC_MINT || parsed.info.state !== "initialized" || parsed.info.owner === owner) {
      throw new Error("LIVE_SWAP_FAILED: fee account must be an initialized external USDC token account");
    }
    const raw = parsed.info.tokenAmount?.amount;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error("LIVE_SWAP_FAILED: fee account balance unavailable");
    feeBefore = BigInt(raw);
  } else if (platformFee && (platformFee.feeBps !== 0 || BigInt(String(platformFee.amount ?? "0")) !== 0n)) {
    throw new Error("LIVE_SWAP_FAILED: unexpected platform fee");
  }
  const swapRes = await fetchImpl(req.swapUrl, {
    method: "POST", headers,
    body: JSON.stringify({
      quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      ...(options.platformFeeBps > 0 ? { feeAccount: options.feeAccount } : {}),
      ...(options.transport === "jito" ? { prioritizationFeeLamports: { jitoTipLamports: options.jitoTipLamports } } : {})
    }), signal: AbortSignal.timeout(8000)
  });
  if (!swapRes.ok) throw new Error(`LIVE_SWAP_FAILED: swap HTTP ${swapRes.status}`);
  const swap = await swapRes.json() as { swapTransaction?: string; lastValidBlockHeight?: number; error?: unknown };
  if (swap.error || typeof swap.swapTransaction !== "string" || !Number.isSafeInteger(swap.lastValidBlockHeight) || swap.lastValidBlockHeight! <= 0) {
    throw new Error("LIVE_SWAP_FAILED: invalid swap transaction or expiry");
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  if (tx.version !== 0 || !tx.message.staticAccountKeys[0]?.equals(signer.publicKey) || tx.message.header.numRequiredSignatures !== 1) {
    throw new Error("LIVE_SWAP_FAILED: unexpected transaction payer, version or signers");
  }
  const tables = await Promise.all(tx.message.addressTableLookups.map(async (lookup) => {
    const table = await connection.getAddressLookupTable(lookup.accountKey);
    if (!table.value) throw new Error("LIVE_SWAP_FAILED: address lookup table unavailable");
    return table.value;
  }));
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  const keys = new Set(message.instructions.flatMap((ix) => ix.keys.map((key) => key.pubkey.toBase58())));
  if (options.platformFeeBps > 0 && !keys.has(options.feeAccount!)) throw new Error("LIVE_SWAP_FAILED: fee account missing from transaction");
  if (options.transport === "jito") {
    if (new URL(options.jitoUrl).protocol !== "https:") throw new Error("LIVE_SWAP_FAILED: Jito endpoint must use HTTPS");
    const accounts = await jitoRpc(fetchImpl, options.jitoUrl, "getTipAccounts", []);
    if (!Array.isArray(accounts) || !accounts.length || accounts.some((key) => typeof key !== "string")) throw new Error("LIVE_SWAP_FAILED: no Jito tip accounts");
    const tip = message.instructions.reduce((total, ix) => {
      if (!ix.programId.equals(SystemProgram.programId)) return total;
      try {
        if (SystemInstruction.decodeInstructionType(ix) !== "Transfer") return total;
        const transfer = SystemInstruction.decodeTransfer(ix);
        return transfer.fromPubkey.equals(signer!.publicKey) && accounts.includes(transfer.toPubkey.toBase58()) ? total + transfer.lamports : total;
      } catch { return total; }
    }, 0n);
    if (tip !== BigInt(options.jitoTipLamports)) throw new Error("LIVE_SWAP_FAILED: Jito tip missing or exceeds configured budget");
  }
  tx.sign([signer]);
  const wire = tx.serialize();
  if (wire.length > 1232) throw new Error("LIVE_SWAP_FAILED: transaction exceeds Solana packet size");
  const simulation = await connection.simulateTransaction(tx, {
    commitment: "confirmed", sigVerify: true,
    ...(options.platformFeeBps > 0 ? { accounts: { encoding: "base64", addresses: [options.feeAccount!] } } : {})
  });
  if (simulation.value.err) throw new Error("LIVE_SWAP_FAILED: pre-submission simulation rejected transaction");
  if (options.platformFeeBps > 0) {
    const data = simulation.value.accounts?.[0]?.data;
    const bytes = data && Buffer.from(data[0], "base64");
    if (!bytes || bytes.length < 72 || bytes.readBigUInt64LE(64) - feeBefore !== expectedFee) {
      throw new Error("LIVE_SWAP_FAILED: simulation did not collect the quoted USDC fee atomically");
    }
  }
  const signature = signatureBase58(tx.signatures[0]!);
  const prepared: PreparedLiveOrder = {
    signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swap.lastValidBlockHeight!,
    mint: req.mint, side: req.side, at: Date.now()
  };
  req.onPrepared?.(prepared);
  let bundleId: string | undefined;
  try {
    if (options.transport === "jito") {
      const result = await jitoRpc(fetchImpl, options.jitoUrl, "sendBundle", [[Buffer.from(wire).toString("base64")], { encoding: "base64" }]);
      if (typeof result !== "string" || !result) throw new Error("Jito did not return a bundle ID");
      bundleId = result;
    } else {
      const result = await connection.sendRawTransaction(wire, { skipPreflight: false, maxRetries: 2 });
      if (result !== signature) throw new Error("RPC returned an unexpected transaction signature");
    }
    const confirmation = await connection.confirmTransaction({
      signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight,
      abortSignal: AbortSignal.timeout(60_000)
    }, "confirmed");
    if (confirmation.value.err) throw new LiveSwapError("LIVE_SWAP_FAILED: transaction rejected on-chain", "failed", signature);
    const receipt = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!receipt) throw new Error("Confirmed receipt unavailable; reconcile this signature before another order");
    const fill = confirmedFill(req, owner, receipt, expectedInput, minimumOutput, expectedFee, options.platformFeeBps > 0 ? options.feeAccount : undefined);
    return { signature, bundleId, ...fill };
  } catch (error) {
    if (error instanceof LiveSwapError) throw error;
    throw new LiveSwapError(`LIVE_OUTCOME_UNKNOWN: ${signature}. ${error instanceof Error ? error.message : "submission or confirmation failed"}`, "unknown", signature);
  }
}

const jitoNextSlot = new Map<string, number>();

async function jitoRpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  // Jito's public default is one request per second per IP/region. Tip discovery
  // and bundle submission share that budget; a rejected send must not spill to RPC.
  const now = Date.now();
  const slot = Math.max(now, jitoNextSlot.get(url) ?? 0);
  jitoNextSlot.set(url, slot + 1100);
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  const response = await fetchImpl(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`Jito HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (body.error || body.result == null) throw new Error(`Jito ${method} failed`);
  return body.result;
}
