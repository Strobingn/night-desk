/**
 * v13.2 on-chain marks for held coins. One batched getMultipleAccounts call per cycle reads
 * the reserves of the exact pool the position is anchored to:
 * - pump.fun bonding curve (program 6EF8…): virtual SOL / virtual token reserves.
 * - PumpSwap pool (program pAMM…): WSOL vault / token vault balances. v13.6: either side
 *   may be WSOL (Dirk's QTFALCN pool has base = WSOL, quote = the coin; v13.2 refused it).
 * - v13.6 Raydium AMM v4 (675k…) and Raydium CPMM (CPMM…): WSOL vault / token vault.
 * - v13.8 Meteora DBC (virtual pool sqrt price), Meteora DAMM v2 (sqrt price), Meteora DAMM v1
 *   (vault shares), Meteora DLMM (active bin), Raydium CLMM and Orca Whirlpool (sqrt price).
 *   A migrated DBC pool / complete pump curve is followed to its new pool (one getProgramAccounts
 *   per mint, at most every 10 minutes). Anything else is unsupported and simply not read.
 *
 * These are SOL-per-token reserve ratios, not USD. PumpSwap's price is the quote vault
 * plus the pool's signed virtual_quote_reserves (the same figure PUMP_AMM_SDK.decodePool
 * exposes). Leaving that reserve out mis-prices the pool by about the reserve/vault ratio,
 * which is ~11% once protocol and creator fees have accrued. The pricer calibrates the
 * SOL ratio into USD, and the desk uses it for the live display and to pull a stop
 * confirmation forward. Marks never move the stop, the peak, or a fill on their own.
 */
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { BONDING_CURVE_DISC } from "../pump/curve.js";
import { PUMP_AMM_SDK } from "../pump/sdk.js";
import { SourceGate } from "./source-gate.js";
import { pumpReserveAddresses } from "./exclusions.js";

type FetchLike = typeof fetch;

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP7C";
export const METEORA_DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const METEORA_DAMM_V2 = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const METEORA_DAMM_V1 = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";
export const METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const ORCA_WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
/** A migrated pool is searched for its successor at most this often per mint. */
const DISCOVER_MS = 10 * 60_000;
const MAX_ACCOUNTS = 100;
/** A migrated curve or a missing account is looked at again after this. */
const RERESOLVE_MS = 60_000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** True for a base58 string that decodes to exactly 32 bytes. Fixtures like "CURVE" are not accounts. */
export function isPubkey(s: string): boolean {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return false;
    n = n * 58n + BigInt(v);
  }
  let lead = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    lead += 1;
  }
  const bytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
  return lead + bytes === 32;
}

function u64(buf: Uint8Array, offset: number): number {
  if (buf.length < offset + 8) return Number.NaN;
  return Number(new DataView(buf.buffer, buf.byteOffset + offset, 8).getBigUint64(0, true));
}

export type PoolKind = "curve" | "pumpswap" | "raydium" | "cpmm" | "dbc" | "dammv2" | "dammv1" | "dlmm" | "clmm" | "whirlpool";

/** v13.8 kinds whose price is an exact on-chain SOL ratio from a sqrt price / bin / vault shares. */
export const EXACT_KINDS: ReadonlySet<PoolKind> = new Set(["dbc", "dammv2", "dammv1", "dlmm", "clmm", "whirlpool"]);

export interface PoolInfo {
  kind: PoolKind;
  pair: string;
  mint: string;
  decimals: number;
  /** The coin's vault. */
  baseVault?: string;
  /** The WSOL vault. */
  quoteVault?: string;
  /** v13.8 accounts read each cycle (and websocket-subscribed), in decode order. */
  keys: string[];
  /** v13.8 sqrt / bin pools: the coin is token A (x, 0). */
  coinIsA?: boolean;
  /** Signed PumpSwap virtual quote reserves, base-10. Absent means 0 (price = vault ratio). */
  virtualQuoteRaw?: string;
  /** False when WSOL is the pool base and the coin is the quote (virtual reserve sits on the coin). */
  quoteIsSol?: boolean;
}

/** v13.8 one sqrt-price (Q64.64) pool: A-in-B price → SOL per coin. */
export function sqrtNative(data: Uint8Array, offset: number, coinIsA: boolean, coinDecimals: number): number {
  if (data.length < offset + 16) return Number.NaN;
  const view = new DataView(data.buffer, data.byteOffset + offset, 16);
  const raw = Number(view.getBigUint64(0, true)) + Number(view.getBigUint64(8, true)) * 2 ** 64;
  const f = raw / 2 ** 64;
  const decA = coinIsA ? coinDecimals : 9;
  const decB = coinIsA ? 9 : coinDecimals;
  const aInB = f * f * 10 ** (decA - decB);
  if (!(aInB > 0) || !Number.isFinite(aInB)) return Number.NaN;
  return coinIsA ? aInB : 1 / aInB;
}

/** v13.8 Meteora DLMM: price of X in Y = (1 + binStep/10_000)^activeId, decimal-adjusted. */
export function dlmmNative(data: Uint8Array, coinIsA: boolean, coinDecimals: number): number {
  if (data.length < 82) return Number.NaN;
  const view = new DataView(data.buffer, data.byteOffset);
  const active = view.getInt32(76, true);
  const step = view.getUint16(80, true);
  const decX = coinIsA ? coinDecimals : 9;
  const decY = coinIsA ? 9 : coinDecimals;
  const xInY = Math.pow(1 + step / 10_000, active) * 10 ** (decX - decY);
  if (!(xInY > 0) || !Number.isFinite(xInY)) return Number.NaN;
  return coinIsA ? xInY : 1 / xInY;
}

/**
 * v13.8 decode one pool's cycle accounts (same order as PoolInfo.keys) into SOL per coin.
 * "gone" = migrated / complete: look for the successor pool. NaN = unreadable this time.
 */
export function decodePool(p: PoolInfo, datas: Array<Uint8Array | null>): number | "gone" {
  const d0 = datas[0];
  switch (p.kind) {
    case "curve": {
      const parsed = d0 ? parseCurve(d0, p.decimals) : null;
      if (!parsed || !parsed.traded) return Number.NaN;
      if (parsed.complete) return "gone";
      return parsed.native;
    }
    case "pumpswap": {
      const base = datas[0];
      const quote = datas[1];
      if (!base || !quote) return Number.NaN;
      let virtual = 0n;
      try {
        virtual = BigInt(p.virtualQuoteRaw ?? "0");
      } catch {
        virtual = 0n;
      }
      return pumpSwapNative(tokenAmount(base), tokenAmount(quote), p.decimals, virtual, p.quoteIsSol !== false);
    }
    case "raydium":
    case "cpmm": {
      const base = datas[0];
      const quote = datas[1];
      if (!base || !quote) return Number.NaN;
      const baseAmt = tokenAmount(base) / 10 ** p.decimals;
      const quoteAmt = tokenAmount(quote) / 1e9;
      return baseAmt > 0 && quoteAmt > 0 ? quoteAmt / baseAmt : Number.NaN;
    }
    case "dbc":
      if (!d0 || d0.length < 306) return Number.NaN;
      if (d0[305] !== 0) return "gone";
      return sqrtNative(d0, 280, true, p.decimals);
    case "dammv2":
      return d0 ? sqrtNative(d0, 456, p.coinIsA === true, p.decimals) : Number.NaN;
    case "whirlpool":
      return d0 ? sqrtNative(d0, 65, p.coinIsA === true, p.decimals) : Number.NaN;
    case "clmm":
      return d0 ? sqrtNative(d0, 253, p.coinIsA === true, p.decimals) : Number.NaN;
    case "dlmm":
      return d0 ? dlmmNative(d0, p.coinIsA === true, p.decimals) : Number.NaN;
    case "dammv1": {
      // keys: aVault, bVault, aVaultLp, bVaultLp, aLpMint, bLpMint. Pool share = vault total × lp held / lp supply.
      if (datas.some((x) => !x)) return Number.NaN;
      const [va, vb, la, lb, ma, mb] = datas as Uint8Array[];
      const supA = u64(ma!, 36);
      const supB = u64(mb!, 36);
      if (!(supA > 0) || !(supB > 0)) return Number.NaN;
      const amtA = (u64(va!, 11) * tokenAmount(la!)) / supA;
      const amtB = (u64(vb!, 11) * tokenAmount(lb!)) / supB;
      const coin = (p.coinIsA ? amtA : amtB) / 10 ** p.decimals;
      const sol = (p.coinIsA ? amtB : amtA) / 1e9;
      return coin > 0 && sol > 0 ? sol / coin : Number.NaN;
    }
  }
  return Number.NaN;
}

export interface ChainRead {
  mint: string;
  pair: string;
  kind: PoolKind;
  /** SOL per whole token. */
  native: number;
  at: number;
}

interface RpcAccount {
  owner: string;
  data: [string, string];
}

/**
 * BondingCurve (pump IDL): 8 disc, virtual_token u64 @8, virtual_quote u64 @16,
 * real_token @24, real_quote @32, supply @40, complete @48, creator @49,
 * is_mayhem @81, is_cashback @82, quote_mint @83, initial_virtual_quote_reserves @142.
 * Quote atoms are lamports only for the default pubkey or WSOL. A non-SOL quote is not a SOL price.
 * `traded` is true when real quote is at least 0.01 SOL, or when virtual quote has moved
 * at least 0.01 SOL from the stored initial (Mayhem leaves real quote at 1 lamport).
 */
export function parseCurve(data: Uint8Array, decimals: number): { native: number; complete: boolean; realSol: number; traded: boolean } | null {
  if (!curveDiscOk(data) || data.length < 49) return null;
  if (curveQuoteKind(data) === "other") return null;
  const vTok = u64(data, 8);
  const vSol = u64(data, 16);
  if (!(vTok > 0) || !(vSol > 0)) return null;
  return {
    native: vSol / 1e9 / (vTok / 10 ** decimals),
    complete: data[48] === 1,
    realSol: u64(data, 32) / 1e9,
    traded: curveQuoteMoved(data)
  };
}

function u64bi(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 8) return 0n;
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

function curveDiscOk(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  let nonzero = false;
  for (let i = 0; i < 8; i += 1) if (data[i] !== 0) nonzero = true;
  if (!nonzero) return true;
  for (let i = 0; i < 8; i += 1) if (data[i] !== BONDING_CURVE_DISC[i]) return false;
  return true;
}

function curveQuoteKind(data: Uint8Array): "sol" | "other" | "short" {
  if (data.length < 115) return "short";
  const mint = base58(data.subarray(83, 115));
  if (mint === "11111111111111111111111111111111" || mint === WSOL_MINT) return "sol";
  return "other";
}

function curveQuoteMoved(data: Uint8Array): boolean {
  const realQuote = u64bi(data, 32);
  if (realQuote >= 10_000_000n) return true;
  if (data.length < 150) return false;
  const initial = u64bi(data, 142);
  const virtualQuote = u64bi(data, 16);
  if (initial <= 0n) return false;
  const delta = virtualQuote > initial ? virtualQuote - initial : initial - virtualQuote;
  return delta >= 10_000_000n;
}

/** Why a curve cannot be a SOL mark. Null means `parseCurve` is usable. */
export function curveMarkReason(data: Uint8Array, decimals: number): string | null {
  if (!curveDiscOk(data)) return "bonding curve account did not match the pump IDL";
  if (curveQuoteKind(data) === "other") return "quote mint is not SOL, so the curve is not a SOL price";
  const parsed = parseCurve(data, decimals);
  if (!parsed || !(parsed.native > 0) || !Number.isFinite(parsed.native)) return "the bonding curve is empty";
  if (parsed.complete) return "the bonding curve is complete (the coin migrated to a pool)";
  if (!parsed.traded) return "no SOL has traded on its bonding curve, so the curve price is not real";
  return null;
}

/**
 * v13.6: a curve nobody has bought on (real SOL ~0) still carries a virtual price, which can be far
 * from where the coin actually trades (seen live: PEAR's curve held 15 lamports and quoted 35x Jupiter).
 */
export const CURVE_MIN_REAL_SOL = 0.01;

/**
 * PumpSwap pool: 8 disc, bump u8, index u16, creator, base mint @43, quote mint @75,
 * lp mint @107, base vault @139, quote vault @171, signed virtual_quote_reserves i128 @245.
 * Price uses quote vault + that signed reserve. The SDK decode is preferred; a short or
 * pre-discriminator fixture falls back to the same offsets.
 */
export function parsePumpSwapPool(data: Uint8Array): { baseMint: string; quoteMint: string; baseVault: string; quoteVault: string; virtualQuoteReserves: bigint } | null {
  if (data.length < 203) return null;
  const manual = {
    baseMint: base58(data.subarray(43, 75)),
    quoteMint: base58(data.subarray(75, 107)),
    baseVault: base58(data.subarray(139, 171)),
    quoteVault: base58(data.subarray(171, 203))
  };
  return { ...manual, virtualQuoteReserves: signedVirtualQuote(data, manual) };
}

/**
 * SOL per whole coin. solRaw is always the WSOL vault in lamports: a reversed pool (WSOL base)
 * is normalized by solSides before this runs, so the 9-decimal quote scale stays. Virtual 0 keeps
 * the vault ratio. The signed virtual reserve is quote-token raw: lamports when the quote is SOL,
 * coin raw when the pool is reversed. A value hundreds of times the side it is added to is a bad
 * decode, not a price.
 */
export function pumpSwapNative(coinRaw: number, solRaw: number, decimals: number, virtualQuote: bigint, quoteIsSol: boolean): number {
  if (virtualQuote !== 0n) {
    const side = quoteIsSol ? solRaw : coinRaw;
    if (side > 0 && Number.isFinite(side)) {
      const abs = virtualQuote < 0n ? -virtualQuote : virtualQuote;
      const raw = BigInt(Math.max(0, Math.trunc(side)));
      if (raw > 0n && abs > raw * 1_000n) return Number.NaN;
    }
  }
  if (virtualQuote === 0n) {
    const baseAmt = coinRaw / 10 ** decimals;
    const quoteAmt = solRaw / 1e9;
    return baseAmt > 0 && quoteAmt > 0 ? quoteAmt / baseAmt : Number.NaN;
  }
  let coin = BigInt(Math.trunc(coinRaw));
  let sol = BigInt(Math.trunc(solRaw));
  if (quoteIsSol) sol += virtualQuote;
  else coin += virtualQuote;
  if (coin <= 0n || sol <= 0n) return Number.NaN;
  const scale = 10n ** BigInt(decimals);
  const scaled = (sol * scale * 1_000_000_000_000n) / (coin * 1_000_000_000n);
  return Number(scaled) / 1e12;
}

function signedVirtualQuote(data: Uint8Array, manual: { baseMint: string; quoteMint: string }): bigint {
  try {
    const info = {
      data: Buffer.from(data),
      executable: false,
      lamports: 0,
      owner: new PublicKey(PUMPSWAP_PROGRAM)
    } as AccountInfo<Buffer>;
    const pool = PUMP_AMM_SDK.decodePool(info);
    if (pool.baseMint.toBase58() === manual.baseMint && pool.quoteMint.toBase58() === manual.quoteMint) {
      return BigInt(pool.virtualQuoteReserves.toString(10));
    }
  } catch {
    /* Fixture bytes are not a real pool account. The i128 at the IDL offset is the reserve. */
  }
  return readI128LE(data, 245);
}

function readI128LE(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 16) return 0n;
  let n = 0n;
  for (let i = 15; i >= 0; i -= 1) n = (n << 8n) + BigInt(data[offset + i] ?? 0);
  if (n >= 1n << 127n) n -= 1n << 128n;
  return n;
}

/** Raydium AMM v4: base vault @336, quote vault @368, base mint @400, quote mint @432 (752 bytes). */
export function parseRaydiumV4(data: Uint8Array): { baseMint: string; quoteMint: string; baseVault: string; quoteVault: string } | null {
  if (data.length < 464) return null;
  return {
    baseVault: base58(data.subarray(336, 368)),
    quoteVault: base58(data.subarray(368, 400)),
    baseMint: base58(data.subarray(400, 432)),
    quoteMint: base58(data.subarray(432, 464))
  };
}

/** Raydium CPMM: token0 vault @72, token1 vault @104, token0 mint @168, token1 mint @200. */
export function parseCpmm(data: Uint8Array): { baseMint: string; quoteMint: string; baseVault: string; quoteVault: string } | null {
  if (data.length < 232) return null;
  return {
    baseVault: base58(data.subarray(72, 104)),
    quoteVault: base58(data.subarray(104, 136)),
    baseMint: base58(data.subarray(168, 200)),
    quoteMint: base58(data.subarray(200, 232))
  };
}

/** Coin vault and WSOL vault of a two-sided pool, whichever side WSOL is on. Null if it is not coin/WSOL. */
export function solSides(
  pool: { baseMint: string; quoteMint: string; baseVault: string; quoteVault: string } | null,
  mint: string
): { tokenVault: string; solVault: string } | null {
  if (!pool) return null;
  if (pool.baseMint === mint && pool.quoteMint === WSOL_MINT) return { tokenVault: pool.baseVault, solVault: pool.quoteVault };
  if (pool.baseMint === WSOL_MINT && pool.quoteMint === mint) return { tokenVault: pool.quoteVault, solVault: pool.baseVault };
  return null;
}

/** SPL token account (classic or 2022): mint @0, owner @32, amount u64 @64. */
export function tokenAmount(data: Uint8Array): number {
  return u64(data, 64);
}

/** Mint account decimals @44 (classic or 2022). */
export function mintDecimals(data: Uint8Array): number | null {
  if (data.length < 45) return null;
  const d = data[44]!;
  return d <= 12 ? d : null;
}

/** v13.6 one on-demand pump.fun bonding-curve read. */
export interface CurveQuote {
  mint: string;
  /** Bonding-curve PDA (the "pair" a curve-priced position anchors to). */
  curve: string;
  /** SOL per whole token. */
  native: number;
  /** Virtual SOL reserve, SOL. Constant-product depth of the curve. */
  virtualSol: number;
  complete: boolean;
  decimals: number;
}

/** The pump.fun bonding-curve PDA for a mint, or null when it cannot be derived. */
export function pumpCurveAddress(mint: string): string | null {
  const curve = pumpReserveAddresses(mint)[0];
  return curve ?? null;
}

export class ChainMarkReader {
  readonly gate: SourceGate;
  private readonly pools = new Map<string, PoolInfo | { unsupported: true; at: number }>();
  private id = 0;
  /** v13.8 anchored pair → the pool actually read (a migrated pool's successor). */
  private readonly alias = new Map<string, string>();
  private readonly migrated = new Set<string>();
  private readonly discoveredAt = new Map<string, number>();
  private readonly why = new Map<string, string>();
  /** v13.8 latest websocket copy per account. */
  private readonly cache = new Map<string, { data: Uint8Array; at: number }>();

  constructor(
    private readonly rpcUrl: string,
    private readonly fetchImpl: FetchLike,
    minIntervalMs = 1_000
  ) {
    this.gate = new SourceGate(minIntervalMs);
  }

  info(pair: string): PoolInfo | null {
    const p = this.pools.get(pair);
    return p && !("unsupported" in p) ? p : null;
  }

  private async rpc(accounts: string[]): Promise<Array<RpcAccount | null>> {
    const out: Array<RpcAccount | null> = [];
    for (let i = 0; i < accounts.length; i += MAX_ACCOUNTS) {
      const chunk = accounts.slice(i, i + MAX_ACCOUNTS);
      const res = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: "getMultipleAccounts", params: [chunk, { encoding: "base64", commitment: "processed" }] }),
        signal: AbortSignal.timeout(4_000)
      });
      if (!res.ok) throw new Error(`rpc HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { value?: unknown }; error?: { code?: number; message?: string } };
      if (body.error) throw new Error(`rpc ${body.error.code ?? ""} ${body.error.message ?? "error"}`.trim());
      const value = body.result?.value;
      if (!Array.isArray(value) || value.length !== chunk.length) throw new Error("rpc bad getMultipleAccounts reply");
      for (const row of value) {
        const acc = row as { owner?: unknown; data?: unknown } | null;
        out.push(acc && typeof acc.owner === "string" && Array.isArray(acc.data) ? { owner: acc.owner, data: acc.data as [string, string] } : null);
      }
    }
    return out;
  }

  private async resolve(wanted: Array<{ mint: string; pair: string }>, now: number): Promise<void> {
    const todo = wanted.filter(({ mint, pair }) => {
      if (!isPubkey(pair) || !isPubkey(mint)) {
        this.pools.set(pair, { unsupported: true, at: Number.POSITIVE_INFINITY });
        return false;
      }
      const p = this.pools.get(pair);
      return !p || ("unsupported" in p && now - p.at >= RERESOLVE_MS);
    });
    if (!todo.length) return;
    const accounts = await this.rpc([...todo.map((t) => t.pair), ...todo.map((t) => t.mint)]);
    // v13.8 DBC needs its quote vault's mint; DAMM v1 needs its vaults' LP mints. One extra call.
    const second: Array<{ mint: string; pair: string; decimals: number; kind: "dbc" | "dammv1"; data: Uint8Array }> = [];
    todo.forEach(({ mint, pair }, i) => {
      const acc = accounts[i];
      const mintAcc = accounts[todo.length + i];
      const decimals = mintAcc ? mintDecimals(Buffer.from(mintAcc.data[0], "base64")) : null;
      if (!acc || decimals == null) {
        this.pools.set(pair, { unsupported: true, at: now });
        this.why.set(mint, !acc ? "pool account not found" : "mint account unreadable");
        return;
      }
      const data = Buffer.from(acc.data[0], "base64");
      if (acc.owner === PUMP_PROGRAM && parseCurve(data, decimals)) {
        this.pools.set(pair, { kind: "curve", pair, mint, decimals, keys: [pair] });
        return;
      }
      const amm: Array<[string, PoolKind, (d: Uint8Array) => { baseMint: string; quoteMint: string; baseVault: string; quoteVault: string; virtualQuoteReserves?: bigint } | null]> = [
        [PUMPSWAP_PROGRAM, "pumpswap", parsePumpSwapPool],
        [RAYDIUM_AMM_V4, "raydium", parseRaydiumV4],
        [RAYDIUM_CPMM, "cpmm", parseCpmm]
      ];
      for (const [owner, kind, parse] of amm) {
        if (acc.owner !== owner) continue;
        const parsed = parse(data);
        const sides = solSides(parsed, mint);
        if (sides && parsed) {
          this.pools.set(pair, {
            kind,
            pair,
            mint,
            decimals,
            baseVault: sides.tokenVault,
            quoteVault: sides.solVault,
            keys: [sides.tokenVault, sides.solVault],
            ...(kind === "pumpswap"
              ? { virtualQuoteRaw: (parsed.virtualQuoteReserves ?? 0n).toString(), quoteIsSol: parsed.quoteMint === WSOL_MINT }
              : {})
          });
          return;
        }
      }
      const pk = (o: number) => (data.length >= o + 32 ? base58(data.subarray(o, o + 32)) : "");
      // Sqrt-price / bin pools: [owner, kind, mintA offset, mintB offset].
      const sqrtPools: Array<[string, PoolKind, number, number]> = [
        [METEORA_DAMM_V2, "dammv2", 168, 200],
        [ORCA_WHIRLPOOL, "whirlpool", 101, 181],
        [RAYDIUM_CLMM, "clmm", 73, 105],
        [METEORA_DLMM, "dlmm", 88, 120]
      ];
      for (const [owner, kind, oa, ob] of sqrtPools) {
        if (acc.owner !== owner) continue;
        const ma = pk(oa);
        const mb = pk(ob);
        if ((ma === mint && mb === WSOL_MINT) || (ma === WSOL_MINT && mb === mint)) {
          this.pools.set(pair, { kind, pair, mint, decimals, coinIsA: ma === mint, keys: [pair] });
          return;
        }
      }
      if (acc.owner === METEORA_DBC && pk(136) === mint) {
        if (data[305] !== 0) {
          this.pools.set(pair, { unsupported: true, at: now });
          this.why.set(mint, "its Meteora DBC pool migrated");
          this.migrated.add(pair);
          return;
        }
        second.push({ mint, pair, decimals, kind: "dbc", data });
        return;
      }
      if (acc.owner === METEORA_DAMM_V1) {
        const ma = pk(40);
        const mb = pk(72);
        if ((ma === mint && mb === WSOL_MINT) || (ma === WSOL_MINT && mb === mint)) {
          second.push({ mint, pair, decimals, kind: "dammv1", data });
          return;
        }
      }
      this.pools.set(pair, { unsupported: true, at: now });
      this.why.set(mint, acc.owner === METEORA_DBC || acc.owner === METEORA_DAMM_V1 || sqrtPools.some(([o]) => o === acc.owner) || amm.some(([o]) => o === acc.owner)
        ? "its pool is not paired with SOL"
        : `unsupported pool program ${acc.owner.slice(0, 6)}…`);
    });
    if (!second.length) return;
    const extra: string[] = [];
    for (const row of second) {
      if (row.kind === "dbc") extra.push(base58(row.data.subarray(200, 232)));
      else extra.push(base58(row.data.subarray(104, 136)), base58(row.data.subarray(136, 168)));
    }
    const got = await this.rpc(extra);
    let k = 0;
    for (const row of second) {
      if (row.kind === "dbc") {
        const qv = got[k++];
        const qmint = qv ? base58(Buffer.from(qv.data[0], "base64").subarray(0, 32)) : "";
        if (qmint === WSOL_MINT) this.pools.set(row.pair, { kind: "dbc", pair: row.pair, mint: row.mint, decimals: row.decimals, coinIsA: true, keys: [row.pair] });
        else {
          this.pools.set(row.pair, { unsupported: true, at: now });
          this.why.set(row.mint, "its Meteora DBC pool is not quoted in SOL");
        }
      } else {
        const va = got[k++];
        const vb = got[k++];
        if (!va || !vb) {
          this.pools.set(row.pair, { unsupported: true, at: now });
          continue;
        }
        const lpA = base58(Buffer.from(va.data[0], "base64").subarray(115, 147));
        const lpB = base58(Buffer.from(vb.data[0], "base64").subarray(115, 147));
        const d = row.data;
        this.pools.set(row.pair, {
          kind: "dammv1",
          pair: row.pair,
          mint: row.mint,
          decimals: row.decimals,
          coinIsA: base58(d.subarray(40, 72)) === row.mint,
          keys: [base58(d.subarray(104, 136)), base58(d.subarray(136, 168)), base58(d.subarray(168, 200)), base58(d.subarray(200, 232)), lpA, lpB]
        });
      }
    }
  }

  /** v13.8 why a held coin has no on-chain read (for the report / card). */
  reason(mint: string): string | undefined {
    return this.why.get(mint);
  }

  /** v13.8 the pool actually read for an anchored pair (a migrated pool's successor). */
  target(pair: string): string {
    return this.alias.get(pair) ?? pair;
  }

  /**
   * v13.8 a migrated DBC pool / complete pump curve: find its successor (DAMM v2 / v1 for DBC,
   * PumpSwap for pump). getProgramAccounts with a mint filter; at most once per mint per 10 min.
   */
  async discover(mint: string, pair: string, now: number): Promise<string | null> {
    const last = this.discoveredAt.get(mint) ?? Number.NEGATIVE_INFINITY;
    if (now - last < DISCOVER_MS) return this.alias.get(pair) ?? null;
    this.discoveredAt.set(mint, now);
    const searches: Array<[string, Array<Record<string, unknown>>]> = [
      [METEORA_DAMM_V2, [{ dataSize: 1112 }, { memcmp: { offset: 168, bytes: mint } }, { memcmp: { offset: 200, bytes: WSOL_MINT } }]],
      [METEORA_DAMM_V2, [{ dataSize: 1112 }, { memcmp: { offset: 168, bytes: WSOL_MINT } }, { memcmp: { offset: 200, bytes: mint } }]],
      [METEORA_DAMM_V1, [{ dataSize: 944 }, { memcmp: { offset: 40, bytes: mint } }, { memcmp: { offset: 72, bytes: WSOL_MINT } }]],
      [PUMPSWAP_PROGRAM, [{ memcmp: { offset: 43, bytes: mint } }, { memcmp: { offset: 75, bytes: WSOL_MINT } }]]
    ];
    const fromCurve = this.why.get(mint) === "its pump.fun curve completed";
    for (const [program, filters] of searches) {
      if ((program === PUMPSWAP_PROGRAM) !== fromCurve) continue;
      try {
        const res = await this.fetchImpl(this.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: "getProgramAccounts", params: [program, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters }] }),
          signal: AbortSignal.timeout(6_000)
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { result?: Array<{ pubkey?: string }> };
        const hit = Array.isArray(body.result) ? body.result.find((r) => typeof r.pubkey === "string")?.pubkey : undefined;
        if (hit) {
          this.alias.set(pair, hit);
          return hit;
        }
      } catch {
        /* next search; never invent a pool */
      }
    }
    return null;
  }

  /** v13.8 decode the latest websocket copies of one pool's accounts (null when any is missing). */
  decodeCached(pair: string): { read: ChainRead } | null {
    const p = this.info(pair);
    if (!p) return null;
    const datas = p.keys.map((k) => this.cache.get(k)?.data ?? null);
    if (datas.some((d) => !d)) return null;
    const at = Math.max(...p.keys.map((k) => this.cache.get(k)!.at));
    const native = decodePool(p, datas);
    if (native === "gone" || !(native > 0) || !Number.isFinite(native)) return null;
    return { read: { mint: p.mint, pair: p.pair, kind: p.kind, native, at } };
  }

  /** v13.8 a websocket account update. */
  noteAccount(key: string, data: Uint8Array, at: number): void {
    this.cache.set(key, { data, at });
  }

  /** v13.8 every account to subscribe for these anchored pairs: key → pair. */
  subscriptions(pairs: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const anchored of pairs) {
      const pair = this.target(anchored);
      const p = this.info(pair);
      if (!p) continue;
      for (const k of p.keys) out.set(k, pair);
    }
    return out;
  }

  /** v13.8 the newest websocket copy of every key of a pool is at most this old. */
  cachedAge(pair: string, now: number): number {
    const p = this.info(pair);
    if (!p) return Number.POSITIVE_INFINITY;
    let oldest = Number.NEGATIVE_INFINITY;
    for (const k of p.keys) {
      const c = this.cache.get(k);
      if (!c) return Number.POSITIVE_INFINITY;
      oldest = Math.max(oldest, now - c.at);
    }
    return oldest;
  }

  /**
   * v13.6 on-demand pump.fun curve reads (manual buy with no feed price, Tape cards with
   * "Mark 0"). One getMultipleAccounts for curves + mints. Missing, non-pump, empty or
   * unparsable curves are simply absent from the result: callers stay fail-closed.
   */
  async readCurves(mints: string[]): Promise<{ quotes: Map<string, CurveQuote>; missing: Map<string, string> }> {
    const quotes = new Map<string, CurveQuote>();
    const missing = new Map<string, string>();
    const rows = mints
      .filter((m) => isPubkey(m))
      .map((mint) => ({ mint, curve: pumpCurveAddress(mint) }))
      .filter((r): r is { mint: string; curve: string } => {
        if (!r.curve) missing.set(r.mint, "no pump.fun curve address");
        return !!r.curve;
      });
    if (!rows.length) return { quotes, missing };
    const accounts = await this.rpc([...rows.map((r) => r.curve), ...rows.map((r) => r.mint)]);
    rows.forEach(({ mint, curve }, i) => {
      const acc = accounts[i];
      const mintAcc = accounts[rows.length + i];
      if (!acc || acc.owner !== PUMP_PROGRAM) {
        missing.set(mint, "no pump.fun bonding curve on-chain for it");
        return;
      }
      const decimals = mintAcc ? mintDecimals(Buffer.from(mintAcc.data[0], "base64")) : null;
      if (decimals == null) {
        missing.set(mint, "its mint account could not be read");
        return;
      }
      const data = Buffer.from(acc.data[0], "base64");
      const reason = curveMarkReason(data, decimals);
      if (reason) {
        missing.set(mint, reason);
        return;
      }
      const parsed = parseCurve(data, decimals);
      if (!parsed) {
        missing.set(mint, "the bonding curve is empty");
        return;
      }
      quotes.set(mint, { mint, curve, native: parsed.native, virtualSol: u64(data, 16) / 1e9, complete: false, decimals });
    });
    return { quotes, missing };
  }

  /**
   * Reads every supported pool in one call. Unsupported pools are skipped.
   * Throws on transport errors so the gate can back off; never invents a price.
   * v13.8: a pool whose websocket copy is fresher than `skipFreshMs` is decoded from that copy
   * instead of being polled (fewer RPC calls); a migrated pool is followed to its successor.
   */
  async read(
    wanted: Array<{ mint: string; pair: string }>,
    now: number,
    skipFreshMs = 0,
    /** Clock read after a polled RPC body is decoded. Cached websocket copies keep their own `at`. */
    clock?: () => number
  ): Promise<Map<string, ChainRead>> {
    const out = new Map<string, ChainRead>();
    if (!wanted.length) return out;
    const mapped = wanted.map((w) => ({ mint: w.mint, pair: this.target(w.pair), anchored: w.pair }));
    await this.resolve(mapped, now);
    for (const m of mapped) {
      if (!this.info(m.pair) && (this.migrated.has(m.pair) || this.why.get(m.mint) === "its pump.fun curve completed")) {
        const next = await this.discover(m.mint, m.anchored, now);
        if (next && next !== m.pair) {
          m.pair = next;
          await this.resolve([{ mint: m.mint, pair: next }], now);
        }
      }
    }
    const pools: PoolInfo[] = [];
    for (const m of mapped) {
      const p = this.info(m.pair);
      if (!p || p.mint !== m.mint) continue;
      if (skipFreshMs > 0 && this.cachedAge(p.pair, now) <= skipFreshMs) {
        const cached = this.decodeCached(p.pair);
        if (cached) {
          out.set(p.mint, cached.read);
          continue;
        }
      }
      pools.push(p);
    }
    if (!pools.length) return out;
    const keys: string[] = [];
    for (const p of pools) keys.push(...p.keys);
    const accounts = await this.rpc(keys);
    // The accounts are the chain state at the moment this response was decoded. The caller's
    // `now` is when the read was queued; a public-RPC wait longer than the live-mark window
    // would make a fresh decode look stale. A cache hit above keeps the notification time.
    const polledAt = clock ? clock() : now;
    let k = 0;
    for (const p of pools) {
      const datas = p.keys.map(() => {
        const acc = accounts[k++];
        return acc ? (Buffer.from(acc.data[0], "base64") as Uint8Array) : null;
      });
      if (p.kind === "curve") {
        const acc = accounts[k - 1];
        if (!acc || acc.owner !== PUMP_PROGRAM) datas[0] = null;
      }
      const native = decodePool(p, datas);
      if (native === "gone") {
        // Migrated or gone: look for the successor instead of quoting a dead pool.
        this.pools.set(p.pair, { unsupported: true, at: now });
        this.migrated.add(p.pair);
        this.why.set(p.mint, p.kind === "curve" ? "its pump.fun curve completed" : "its Meteora DBC pool migrated");
        continue;
      }
      if (native > 0 && Number.isFinite(native)) out.set(p.mint, { mint: p.mint, pair: p.pair, kind: p.kind, native, at: polledAt });
    }
    return out;
  }
}
