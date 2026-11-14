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
import { solanaConnection, type AccountBytes, type PumpConnection } from "../pump/rpc.js";
import { GLOBAL_CONFIG_PDA, GLOBAL_PDA } from "../pump/sdk.js";
import { CURVE_FEE_CONFIG, SWAP_FEE_CONFIG } from "../pump/constants.js";
import type { LiveSwapResult } from "./live-broker.js";
import { CONFIRM_TIMEOUT_MS, isAmbiguousSendError, isNoSellRouteMessage, noSellRouteError, rejectedSend, sellExitImpactError, unconfirmedSend, withTimeout } from "./live-submit.js";
import { loadDeskKeypair } from "./wallet-key.js";

/**
 * How far a sell fill sits under the mark. A fill at or above the mark is not a loss.
 * Automatic exits use this so a better on-chain price is not refused as slippage.
 */
export function pumpSellShortfall(fillPriceUsd: number, markPriceUsd: number): number {
  if (!(markPriceUsd > 0) || !(fillPriceUsd > 0) || !Number.isFinite(fillPriceUsd) || !Number.isFinite(markPriceUsd)) return 0;
  return Math.max(0, (markPriceUsd - fillPriceUsd) / markPriceUsd);
}

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
  /** Fraction, e.g. 0.03. Sell anyway widens this send only. */
  slippageFraction?: number;
  /** Saved exit cap. A sell over this is refused unless sellAnyway is set. */
  exitCap?: number;
  /** Manual sell only. Does not apply when the pool has no quote. */
  sellAnyway?: boolean;
  keypairPath?: string;
  readEnvSecret?: () => string | undefined;
  rpcUrl: string;
  /** Tests pass a fixture connection. Production uses SOLANA_RPC_URL. */
  connection?: PumpConnection;
  /** Tests capture the signed bytes. Production sends them on rpcUrl. */
  broadcast?: (raw: Uint8Array) => Promise<{ signature: string; err: unknown; state?: "confirmed" | "rejected" | "unknown" }>;
  /** Exec-lane fetch. Preparation and broadcast do not wait on the 9/min poll budget. */
  rpcFetch?: typeof fetch;
  /** v13.23 Helius Sender tip for this live swap. Omitted in tests that inject broadcast. */
  senderTipLamports?: number;
  idemKey?: string;
}

async function defaultBroadcast(
  rpcUrl: string,
  raw: Uint8Array,
  fetchImpl?: typeof fetch
): Promise<{ signature: string; err: unknown; state: "confirmed" | "rejected" | "unknown" }> {
  const web3 = await import("@solana/web3.js");
  const connection = fetchImpl
    ? new web3.Connection(rpcUrl, { commitment: "confirmed", fetch: fetchImpl })
    : new web3.Connection(rpcUrl, "confirmed");
  let signature: string;
  try {
    const { sendLiveTransaction } = await import("./helius-sender.js");
    signature = await sendLiveTransaction({
      idemKey: Buffer.from(raw).toString("base64").slice(0, 44),
      raw,
      fetchImpl: fetchImpl ?? fetch,
      fallback: () => connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 2 })
    });
  } catch (err) {
    if (isAmbiguousSendError(err)) return { signature: "", err, state: "unknown" };
    throw err;
  }
  try {
    const confirmed = await withTimeout(connection.confirmTransaction(signature, "confirmed"), CONFIRM_TIMEOUT_MS, "confirmation");
    if (confirmed.value.err) return { signature, err: confirmed.value.err, state: "rejected" };
    return { signature, err: null, state: "confirmed" };
  } catch (err) {
    return { signature, err, state: "unknown" };
  }
}

/** Pump program accounts that are the same for every coin and change only when Pump changes its fees. */
const PROTOCOL_ACCOUNTS = new Set([GLOBAL_PDA.toBase58(), CURVE_FEE_CONFIG.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), SWAP_FEE_CONFIG.toBase58()]);
const PROTOCOL_TTL_MS = 10 * 60_000;
/** A mint's token program never changes, and a Pump coin's supply is fixed. */
const MINT_TTL_MS = 60 * 60_000;
const fixedAccounts = new Map<string, { at: number; value: AccountBytes }>();

/** Drop every kept account. Tests only: the desk never empties the cache on a failed swap. */
export function forgetFixedAccounts(): void {
  fixedAccounts.clear();
  protocolSuspect = false;
  protocolWarmedAt = 0;
}

let protocolSuspect = false;
let protocolWarmedAt = 0;
/** The desk re-reads the fixed Pump accounts this often, off the swap lane, so a swap never has to. */
export const PROTOCOL_WARM_MS = 8 * 60_000;
/** After a failed swap they are re-read sooner, but not more than once in this long. */
const PROTOCOL_REWARM_MIN_MS = 2 * 60_000;

/** A mint account the desk already read for its safety check. The swap does not read it again. */
export function rememberMintAccount(mint: string, value: AccountBytes, now = Date.now()): void {
  if (mint && value?.owner && value.data?.length) fixedAccounts.set(mint, { at: now, value });
}

/** True when the fixed Pump accounts should be read again: on schedule, or after a swap failed. */
export function protocolWarmDue(now = Date.now()): boolean {
  const age = now - protocolWarmedAt;
  return age >= PROTOCOL_WARM_MS || (protocolSuspect && age >= PROTOCOL_REWARM_MIN_MS);
}

/**
 * Read the four fixed Pump accounts and keep them. The desk calls this on the read lane, in the
 * background. A read that fails leaves the kept copy in place.
 */
export async function warmProtocolAccounts(base: PumpConnection, now: () => number = Date.now): Promise<number> {
  protocolWarmedAt = now();
  protocolSuspect = false;
  const rows = await Promise.allSettled([...PROTOCOL_ACCOUNTS].map(async (address) => [address, await base.getAccountInfo(address)] as const));
  let kept = 0;
  for (const row of rows) {
    if (row.status !== "fulfilled" || !row.value[1]) continue;
    fixedAccounts.set(row.value[0], { at: now(), value: row.value[1] });
    kept += 1;
  }
  return kept;
}

/**
 * The connection one swap is built on.
 *
 * Building a Pump swap read the same fixed accounts on every trade, and some of them twice. On a
 * budget of 8 sends a minute that put about 40 seconds between reading the price and sending the
 * order, and a falling coin moves past the 6% exit cap in less. Here each address is read once per
 * swap, and the fixed ones are kept between swaps, so the price read is the last one before the send.
 * A failed swap does not empty the cache: its retry has to be just as short.
 */
export function swapConnection(base: PumpConnection, mint: string, now: () => number = Date.now): PumpConnection {
  const seen = new Map<string, Promise<AccountBytes | null>>();
  return {
    getAccountInfo(address: string) {
      const earlier = seen.get(address);
      if (earlier) return earlier;
      const ttl = PROTOCOL_ACCOUNTS.has(address) ? PROTOCOL_TTL_MS : address === mint ? MINT_TTL_MS : 0;
      const kept = ttl > 0 ? fixedAccounts.get(address) : undefined;
      const job =
        kept && now() - kept.at < ttl
          ? Promise.resolve<AccountBytes | null>(kept.value)
          : base.getAccountInfo(address).then((value) => {
              if (ttl > 0 && value) fixedAccounts.set(address, { at: now(), value });
              return value;
            });
      seen.set(address, job);
      return job;
    },
    getLatestBlockhash: () => base.getLatestBlockhash(),
    simulateTransaction: (tx) => base.simulateTransaction(tx)
  };
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
  const connection = swapConnection(req.connection ?? solanaConnection(req.rpcUrl, req.rpcFetch), req.mint);
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
    // The usual cause is the price moving. The kept accounts stay, so the retry is still three
    // sends. The desk re-reads the fixed ones in the background in case Pump changed its fees.
    protocolSuspect = true;
    const message = err instanceof IntentError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    if (req.side === "sell" && (isNoSellRouteMessage(message) || /insufficient liquidity|no liquidity|zero liquidity/i.test(message))) {
      throw noSellRouteError();
    }
    throw new Error(`LIVE_SWAP_FAILED: ${message}`);
  }
  const qty = Number(built.tokenAmount) / 10 ** decimals;
  const sol = Number(built.solLamports) / 1_000_000_000;
  const notionalUsd = req.side === "buy" ? req.sizeUsd! : sol * req.solPriceUsd;
  const fillPriceUsd = qty > 0 ? notionalUsd / qty : 0;
  if (req.side === "buy") {
    const gate = entryPriceAllowed(req.markPriceUsd ?? 0, fillPriceUsd, slip);
    if (!gate.ok) throw new Error(gate.message);
  } else {
    if (!(qty > 0) || !(fillPriceUsd > 0)) throw noSellRouteError();
    const cap = req.exitCap ?? slip;
    const shortfall = pumpSellShortfall(fillPriceUsd, req.markPriceUsd ?? 0);
    if (shortfall > cap + 1e-9 && req.sellAnyway !== true) throw sellExitImpactError(shortfall, cap);
  }
  if (!(qty > 0) || !(fillPriceUsd > 0)) throw new Error("LIVE_SWAP_FAILED: pump quote was not a usable fill. Nothing was sent.");
  const blockhash = await connection.getLatestBlockhash();
  const unsigned = serializeUnsigned(loaded.keypair.publicKey.toBase58(), blockhash, built.instructions);
  const sim = await connection.simulateTransaction(unsigned.tx);
  if (sim.err) {
    protocolSuspect = true;
    throw new Error(`LIVE_SWAP_FAILED: simulation ${sim.err}. Nothing was sent.`);
  }
  const tx = Transaction.from(Buffer.from(unsigned.base64, "base64"));
  if (req.senderTipLamports != null && req.senderTipLamports > 0) {
    const { addTipToLegacy } = await import("./helius-sender.js");
    addTipToLegacy(tx, loaded.keypair.publicKey, req.senderTipLamports);
  }
  tx.partialSign(loaded.keypair);
  if (!tx.signature) throw new Error("LIVE_SWAP_FAILED: transaction was not signed. Nothing was sent.");
  const raw = tx.serialize();
  const sent = await (req.broadcast ?? ((bytes) => defaultBroadcast(req.rpcUrl, bytes, req.rpcFetch)))(raw);
  if (sent.state === "unknown") throw unconfirmedSend(sent.signature || null, req.side);
  if (sent.err || sent.state === "rejected") throw rejectedSend(sent.signature || "unknown", req.side);
  const feeLamports = Number(built.quote.feeLamports);
  const feeUsd = Number.isFinite(feeLamports) && feeLamports > 0 ? (feeLamports / 1_000_000_000) * req.solPriceUsd : 0;
  const mark = req.markPriceUsd ?? fillPriceUsd;
  const slippage = mark > 0 ? Math.abs(fillPriceUsd - mark) / mark : 0;
  console.log(`[executor] pump live ${req.side} ${req.mint} venue ${built.venue} owner ${loaded.keypair.publicKey.toBase58()} sig ${sent.signature}`);
  return { signature: sent.signature, fillPriceUsd, qty, notionalUsd, feeUsd, slippage };
}
