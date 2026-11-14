import { entryPriceAllowed } from "../agents/execution-math.js";
import { HARD_RULES, clampEntrySlippage } from "../rules.js";
import { CONFIRM_TIMEOUT_MS, QUOTE_TIMEOUT_MS, RECENT_FILL_TOKEN_MS, SELL_PRE_SEND_MS, SWAP_TIMEOUT_MS, isAmbiguousSendError, isNoRoutesBody, isNoSellRouteMessage, noSellRouteError, preSendFailure, rejectedSend, sellExitImpactError, sellQuoteTimeoutError, unconfirmedSend, withTimeout } from "./live-submit.js";
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
  /** v13.23 Helius Sender tip. Default 0.000005 SOL. Paper never reaches this. */
  senderTipLamports?: number;
  /** Same key must not broadcast twice. A new order uses a new key. */
  idemKey?: string;
  /**
   * The qty is the amount a live buy just filled. If the token-account read is empty or does
   * not answer quickly, sell that qty instead of refusing.
   */
  confirmedFill?: boolean;
  /**
   * Manual sell only. Quote this send up to 50% and do not refuse on the exit cap.
   * The saved maxExitSlippage is not changed. No route is still a refusal.
   */
  sellAnyway?: boolean;
}

/** Quote tolerance for one sell. Sell anyway widens this send only, up to 50%. */
export function sellQuoteTolerance(exitCap: number, sellAnyway: boolean): number {
  const cap = Math.min(0.5, Math.max(0.005, exitCap));
  return sellAnyway ? 0.5 : cap;
}

/** True when this sell's quoted haircut is over the saved exit cap and the operator did not confirm it. */
export function sellImpactRefused(worst: number, exitCap: number, sellAnyway: boolean): boolean {
  return worst > exitCap + 1e-9 && !sellAnyway;
}

/**
 * Atoms to sell. A positive wallet balance caps the request. A just-confirmed fill with no
 * readable balance sells the booked amount. Anything else with no balance is refused.
 */
export function resolveSellAtoms(requested: number, walletRaw: number | null, confirmedFill: boolean): number | null {
  if (!(requested > 0) || !Number.isFinite(requested)) return null;
  if (walletRaw != null && walletRaw > 0 && Number.isFinite(walletRaw)) return Math.min(requested, Math.floor(walletRaw));
  return confirmedFill ? Math.floor(requested) : null;
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
  // v13.39: a live sell's pre-send work (decimals, token accounts, Jupiter quote) must
  // finish inside SELL_PRE_SEND_MS so the desk can answer with a reason. A send already
  // in flight is not aborted. Live buys keep the existing 8s quote budget.
  const sellDeadline = req.side === "sell" ? Date.now() + SELL_PRE_SEND_MS : null;
  const remainMs = (): number => (sellDeadline == null ? QUOTE_TIMEOUT_MS : Math.max(50, sellDeadline - Date.now()));
  const sellPreSend = async <T>(work: Promise<T>, label: string): Promise<T> => {
    try {
      return await withTimeout(work, remainMs(), label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (req.side === "sell" && /timed out/i.test(message)) throw sellQuoteTimeoutError();
      throw err;
    }
  };
  // v13.5: decimals come from the chain, not the scout feed (a wrong guess sells 1000x off).
  let decimals: number | null = null;
  try {
    const supply =
      req.side === "sell"
        ? await sellPreSend(connection.getTokenSupply(new web3.PublicKey(req.mint)), "token decimals")
        : await connection.getTokenSupply(new web3.PublicKey(req.mint));
    decimals = supply.value.decimals;
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === "LIVE_NOT_SUBMITTED") throw err;
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
    // Never sell more than the wallet holds. A fill from the last 30s keeps its booked qty when
    // that read is empty or does not answer, so the exit is not refused while the account settles.
    const pending = sellPreSend(
      connection.getParsedTokenAccountsByOwner(keypair.publicKey, { mint: new web3.PublicKey(req.mint) }),
      "wallet token balance"
    );
    let walletRaw: number | null = null;
    try {
      const held = req.confirmedFill
        ? await Promise.race([
            pending.then(
              (value) => value,
              () => null
            ),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), RECENT_FILL_TOKEN_MS))
          ])
        : await pending;
      if (held) {
        let raw = 0;
        for (const row of held.value) {
          const amt = (row.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
          if (amt) raw += Number(amt);
        }
        walletRaw = raw;
      }
    } catch (err) {
      if (!req.confirmedFill) throw err;
    }
    const atoms = resolveSellAtoms(amount, walletRaw, req.confirmedFill === true);
    if (atoms == null) throw new Error("LIVE_SWAP_FAILED: wallet holds none of this token");
    amount = atoms;
  }
  if (!(amount > 0)) throw new Error("LIVE_SWAP_FAILED: amount rounded to zero");

  const quoteEndpoint = new URL(req.quoteUrl);
  quoteEndpoint.searchParams.set("inputMint", inputMint);
  quoteEndpoint.searchParams.set("outputMint", outputMint);
  quoteEndpoint.searchParams.set("amount", String(amount));
  const entryCap = clampEntrySlippage(req.maxEntrySlippage ?? HARD_RULES.maxEntrySlippage);
  const exitCap = Math.min(0.5, Math.max(0.005, req.maxExitSlippage ?? entryCap + HARD_RULES.exitImpactSlack));
  const slipCap = req.side === "buy" ? entryCap : sellQuoteTolerance(exitCap, req.sellAnyway === true);
  quoteEndpoint.searchParams.set("slippageBps", String(Math.round(slipCap * 10_000)));
  let quoteRes: Response;
  const quoteMs = req.side === "sell" ? Math.min(QUOTE_TIMEOUT_MS, remainMs()) : QUOTE_TIMEOUT_MS;
  try {
    quoteRes = await fetch(quoteEndpoint, { signal: AbortSignal.timeout(quoteMs) });
  } catch {
    throw req.side === "sell" ? sellQuoteTimeoutError() : preSendFailure("quote", "timeout");
  }
  if (!quoteRes.ok) {
    let body: unknown = null;
    try {
      body = await quoteRes.json();
    } catch {
      /* body optional */
    }
    if (req.side === "sell" && isNoRoutesBody(quoteRes.status, body)) throw noSellRouteError();
    throw preSendFailure("quote", quoteRes.status);
  }
  const quote = (await quoteRes.json()) as {
    outAmount?: string;
    inAmount?: string;
    error?: string;
    errorCode?: string;
    priceImpactPct?: string | number;
  };
  if (req.side === "sell" && isNoSellRouteMessage(`${quote.error ?? ""} ${quote.errorCode ?? ""}`)) throw noSellRouteError();
  if (req.side === "sell" && !quote.outAmount && !quote.error) throw noSellRouteError();
  if (!quote.outAmount || quote.error) throw new Error(`LIVE_SWAP_FAILED: ${quote.error ?? "empty quote"}`);

  if (req.side === "buy") {
    const quotedQty = Number(quote.outAmount) / 10 ** decimals;
    const quotedPrice = quotedQty > 0 ? req.sizeUsd! / quotedQty : Number.NaN;
    const mark = req.markPriceUsd ?? 0;
    const gate = entryPriceAllowed(mark, quotedPrice, entryCap);
    if (!gate.ok) throw new Error(gate.message);
  } else {
    // v13.39: refuse a live sell whose quoted fill exceeds the exit slippage cap. Nothing is sent.
    const outUsd = Number(quote.outAmount) / 1_000_000;
    const soldQty = amount / 10 ** decimals;
    const midValue = (req.markPriceUsd ?? 0) * soldQty;
    const vsMark = midValue > 0 && Number.isFinite(outUsd) ? 1 - outUsd / midValue : null;
    const impactRaw = Number(quote.priceImpactPct);
    const impact = Number.isFinite(impactRaw) ? (impactRaw > 1 ? impactRaw / 100 : impactRaw) : null;
    const worst = Math.max(vsMark ?? 0, impact ?? 0);
    if ((vsMark != null || impact != null) && sellImpactRefused(worst, exitCap, req.sellAnyway === true)) throw sellExitImpactError(worst, exitCap);
  }

  let swapRes: Response;
  try {
    swapRes = await fetch(req.swapUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: owner,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true
      }),
      signal: AbortSignal.timeout(SWAP_TIMEOUT_MS)
    });
  } catch {
    throw preSendFailure("swap", "timeout");
  }
  if (!swapRes.ok) throw preSendFailure("swap", swapRes.status);
  const swap = (await swapRes.json()) as { swapTransaction?: string; error?: string };
  if (!swap.swapTransaction) throw new Error(`LIVE_SWAP_FAILED: ${swap.error ?? "no swap transaction"}`);

  const tx = web3.VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  const { sendLiveTransaction, versionedWithTip, tipLamports } = await import("./helius-sender.js");
  const tipped = await versionedWithTip(tx, keypair.publicKey, tipLamports(req.senderTipLamports == null ? undefined : req.senderTipLamports / 1_000_000_000), async (address) => {
    const table = await connection.getAddressLookupTable(address);
    return table.value;
  }).catch(() => tx);
  tipped.sign([keypair]);
  const raw = tipped.serialize();
  // maxRetries on the fallback resubmits this same signed transaction. It is not a second order.
  let signature: string;
  try {
    signature = await sendLiveTransaction({
      idemKey: req.idemKey ?? Buffer.from(raw).toString("base64").slice(0, 44),
      raw,
      side: req.side,
      fetchImpl: fetch,
      fallback: () => connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 2 })
    });
  } catch (err) {
    if (isAmbiguousSendError(err)) throw unconfirmedSend(null, req.side);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LIVE_SWAP_FAILED: ${message}. Nothing was sent.`);
  }
  let confirmed: { value?: { err?: unknown } };
  try {
    confirmed = await withTimeout(connection.confirmTransaction(signature, "confirmed"), CONFIRM_TIMEOUT_MS, "confirmation");
  } catch {
    throw unconfirmedSend(signature, req.side);
  }
  if (confirmed?.value?.err) throw rejectedSend(signature, req.side);

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
    slippage: realizedFillSlippage(req.side, req.markPriceUsd, fillPriceUsd)
  };
}

/** Fill versus the mark the order was priced at. A quote whose in-amount matches the request is not 1%. */
export function realizedFillSlippage(side: "buy" | "sell", markPriceUsd: number | undefined, fillPriceUsd: number): number {
  const mark = markPriceUsd ?? 0;
  if (!(mark > 0) || !(fillPriceUsd > 0) || !Number.isFinite(mark) || !Number.isFinite(fillPriceUsd)) return 0;
  const raw = side === "buy" ? (fillPriceUsd - mark) / mark : (mark - fillPriceUsd) / mark;
  return raw > 0 && Number.isFinite(raw) ? raw : 0;
}
