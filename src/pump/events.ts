/**
 * Trade events from a pump `TradeEvent` log (SDK coder) or a PumpPortal JSON frame
 * on the scout socket. No second socket, and no PumpPortal local-transaction API.
 */
import { PublicKey } from "@solana/web3.js";
import { PUMP_SDK, pumpIdl } from "./sdk.js";
import type { TradeEvent } from "./types.js";

const TRADE_DISC = Buffer.from(
  (pumpIdl as { events: Array<{ name: string; discriminator: number[] }> }).events.find((event) => event.name === "TradeEvent")!.discriminator
);

function key(value: { toBase58?: () => string } | string | undefined | null): string {
  if (!value) return PublicKey.default.toBase58();
  if (typeof value === "string") return value;
  return value.toBase58?.() ?? PublicKey.default.toBase58();
}

function quoteMintOf(value: { toBase58?: () => string } | string | undefined | null): string | null {
  const text = key(value);
  return text === PublicKey.default.toBase58() ? null : text;
}

/** `Program data:` base64, or the raw event bytes (with the 8-byte discriminator). */
export function decodeTradeEventLog(data: Buffer, meta: { signature?: string; slot?: number } = {}): TradeEvent | null {
  if (data.length < 8 || !data.subarray(0, 8).equals(TRADE_DISC)) return null;
  const event = PUMP_SDK.decodeTradeEventBc(data.subarray(8));
  const sol = event.quoteAmount && !event.quoteAmount.isZero() ? event.quoteAmount : event.solAmount;
  const virtualQuote = event.virtualQuoteReserves && !event.virtualQuoteReserves.isZero() ? event.virtualQuoteReserves : event.virtualSolReserves;
  const realQuote = event.realQuoteReserves && !event.realQuoteReserves.isZero() ? event.realQuoteReserves : event.realSolReserves;
  const ts = Number(event.timestamp.toString(10));
  return {
    mint: event.mint.toBase58(),
    signature: meta.signature,
    slot: meta.slot,
    isBuy: event.isBuy,
    user: event.user.toBase58(),
    solAmountLamports: sol.toString(10),
    tokenAmount: event.tokenAmount.toString(10),
    virtualQuoteReserves: virtualQuote.toString(10),
    virtualTokenReserves: event.virtualTokenReserves.toString(10),
    realQuoteReserves: realQuote.toString(10),
    realTokenReserves: event.realTokenReserves.toString(10),
    feeLamports: event.fee.toString(10),
    creator: event.creator.toBase58(),
    timestamp: ts < 10_000_000_000 ? ts * 1000 : ts,
    ixName: event.ixName,
    quoteMint: quoteMintOf(event.quoteMint),
    source: "log"
  };
}

/** Pull `Program data:` lines that are pump trade events. */
export function decodeTradeEventsFromLogs(logs: readonly string[], meta: { signature?: string; slot?: number } = {}): TradeEvent[] {
  const out: TradeEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice("Program data: ".length), "base64");
    const event = decodeTradeEventLog(data, meta);
    if (event) out.push(event);
  }
  return out;
}

interface PortalFrame {
  mint?: string;
  signature?: string;
  txType?: string;
  traderPublicKey?: string;
  tokenAmount?: number | string;
  solAmount?: number | string;
  vTokensInBondingCurve?: number | string;
  vSolInBondingCurve?: number | string;
  marketCapSol?: number | string;
  name?: string;
  symbol?: string;
  pool?: string;
}

/**
 * PumpPortal `solAmount` / `vSolInBondingCurve` are SOL. A whole number such as
 * `30` is 30 SOL — JSON drops the decimal — not 30 lamports.
 */
function solToLamports(value: number | string | undefined): string {
  if (value == null || value === "") return "0";
  let text = typeof value === "number" ? (Number.isFinite(value) && value >= 0 ? value.toFixed(9) : "") : String(value).trim();
  if (!text) return "0";
  if (/e/i.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return "0";
    text = n.toFixed(9);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return "0";
  const [whole, frac = ""] = text.split(".");
  const digits = (frac + "000000000").slice(0, 10);
  let lamports = BigInt(whole) * 1_000_000_000n + BigInt(digits.slice(0, 9));
  if (digits[9]! >= "5") lamports += 1n;
  return lamports.toString();
}

function tokenRaw(value: number | string | undefined): string {
  if (value == null || value === "") return "0";
  const text = String(value);
  if (/^\d+$/.test(text)) return text;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return "0";
  // PumpPortal sends UI tokens (6 decimals) for the human amount.
  return BigInt(Math.round(n * 1_000_000)).toString();
}

/** PumpPortal `buy` / `sell` / `create` / `migrate` frame. Returns null for acks and other methods. */
export function decodePumpPortalFrame(raw: string, now = Date.now()): { kind: "trade"; event: TradeEvent } | { kind: "coin"; mint: string; name?: string; symbol?: string; creator?: string; txType: string } | null {
  let msg: PortalFrame;
  try {
    msg = JSON.parse(raw) as PortalFrame;
  } catch {
    return null;
  }
  if (!msg.mint || !msg.txType) return null;
  if (msg.txType === "create" || msg.txType === "migrate") {
    return { kind: "coin", mint: msg.mint, name: msg.name, symbol: msg.symbol, creator: msg.traderPublicKey, txType: msg.txType };
  }
  if (msg.txType !== "buy" && msg.txType !== "sell") return null;
  const event: TradeEvent = {
    mint: msg.mint,
    signature: msg.signature,
    isBuy: msg.txType === "buy",
    user: msg.traderPublicKey ?? PublicKey.default.toBase58(),
    solAmountLamports: solToLamports(msg.solAmount),
    tokenAmount: tokenRaw(msg.tokenAmount),
    virtualQuoteReserves: solToLamports(msg.vSolInBondingCurve),
    virtualTokenReserves: tokenRaw(msg.vTokensInBondingCurve),
    realQuoteReserves: "0",
    realTokenReserves: "0",
    feeLamports: "0",
    creator: PublicKey.default.toBase58(),
    timestamp: now,
    quoteMint: null,
    source: "pumpportal"
  };
  return { kind: "trade", event };
}

export function tradeId(event: TradeEvent): string {
  return event.signature ?? `${event.mint}:${event.timestamp}:${event.user}:${event.solAmountLamports}:${event.isBuy ? "b" : "s"}`;
}
