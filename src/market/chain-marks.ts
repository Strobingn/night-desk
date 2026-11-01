/**
 * v13.2 on-chain marks for held coins. One batched getMultipleAccounts call per cycle reads
 * the reserves of the exact pool the position is anchored to:
 * - pump.fun bonding curve (program 6EF8…): virtual SOL / virtual token reserves.
 * - PumpSwap pool (program pAMM…): WSOL vault / token vault balances. v13.6: either side
 *   may be WSOL (Dirk's QTFALCN pool has base = WSOL, quote = the coin; v13.2 refused it).
 * - v13.6 Raydium AMM v4 (675k…) and Raydium CPMM (CPMM…): WSOL vault / token vault.
 * Meteora DLMM (bins) and anything else is unsupported and simply not read.
 *
 * These are SOL-per-token reserve ratios, not USD, and not the same number DexScreener
 * or Jupiter print (PumpSwap reads ~11% under them). The pricer calibrates them, and the
 * desk uses them for the live display and to pull a stop confirmation forward. They never
 * move the stop, the peak, or a fill on their own.
 */
import { SourceGate } from "./source-gate.js";
import { pumpReserveAddresses } from "./exclusions.js";

type FetchLike = typeof fetch;

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP7C";
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

export type PoolKind = "curve" | "pumpswap" | "raydium" | "cpmm";

export interface PoolInfo {
  kind: PoolKind;
  pair: string;
  mint: string;
  decimals: number;
  /** The coin's vault. */
  baseVault?: string;
  /** The WSOL vault. */
  quoteVault?: string;
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

/** Pump curve: 8 disc, vTok u64 @8, vSol u64 @16, realTok @24, realSol @32, supply @40, complete @48. */
export function parseCurve(data: Uint8Array, decimals: number): { native: number; complete: boolean; realSol: number } | null {
  if (data.length < 49) return null;
  const vTok = u64(data, 8);
  const vSol = u64(data, 16);
  if (!(vTok > 0) || !(vSol > 0)) return null;
  return { native: vSol / 1e9 / (vTok / 10 ** decimals), complete: data[48] === 1, realSol: u64(data, 32) / 1e9 };
}

/**
 * v13.6: a curve nobody has bought on (real SOL ~0) still carries a virtual price, which can be far
 * from where the coin actually trades (seen live: PEAR's curve held 15 lamports and quoted 35x Jupiter).
 */
export const CURVE_MIN_REAL_SOL = 0.01;

/** PumpSwap pool: 8 disc, bump u8, index u16, creator, base mint @43, quote mint @75, lp @107, base vault @139, quote vault @171. */
export function parsePumpSwapPool(data: Uint8Array): { baseMint: string; quoteMint: string; baseVault: string; quoteVault: string } | null {
  if (data.length < 203) return null;
  return {
    baseMint: base58(data.subarray(43, 75)),
    quoteMint: base58(data.subarray(75, 107)),
    baseVault: base58(data.subarray(139, 171)),
    quoteVault: base58(data.subarray(171, 203))
  };
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
    todo.forEach(({ mint, pair }, i) => {
      const acc = accounts[i];
      const mintAcc = accounts[todo.length + i];
      const decimals = mintAcc ? mintDecimals(Buffer.from(mintAcc.data[0], "base64")) : null;
      if (!acc || decimals == null) {
        this.pools.set(pair, { unsupported: true, at: now });
        return;
      }
      const data = Buffer.from(acc.data[0], "base64");
      if (acc.owner === PUMP_PROGRAM && parseCurve(data, decimals)) {
        this.pools.set(pair, { kind: "curve", pair, mint, decimals });
        return;
      }
      const amm: Array<[string, PoolKind, (d: Uint8Array) => ReturnType<typeof parsePumpSwapPool>]> = [
        [PUMPSWAP_PROGRAM, "pumpswap", parsePumpSwapPool],
        [RAYDIUM_AMM_V4, "raydium", parseRaydiumV4],
        [RAYDIUM_CPMM, "cpmm", parseCpmm]
      ];
      for (const [owner, kind, parse] of amm) {
        if (acc.owner !== owner) continue;
        const sides = solSides(parse(data), mint);
        if (sides) {
          this.pools.set(pair, { kind, pair, mint, decimals, baseVault: sides.tokenVault, quoteVault: sides.solVault });
          return;
        }
      }
      this.pools.set(pair, { unsupported: true, at: now });
    });
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
      const parsed = parseCurve(data, decimals);
      if (!parsed || !(parsed.native > 0) || !Number.isFinite(parsed.native)) {
        missing.set(mint, "the bonding curve is empty");
        return;
      }
      if (parsed.complete) {
        missing.set(mint, "the bonding curve is complete (the coin migrated to a pool)");
        return;
      }
      if (!(parsed.realSol >= CURVE_MIN_REAL_SOL)) {
        missing.set(mint, "no SOL has traded on its bonding curve, so the curve price is not real");
        return;
      }
      quotes.set(mint, { mint, curve, native: parsed.native, virtualSol: u64(data, 16) / 1e9, complete: false, decimals });
    });
    return { quotes, missing };
  }

  /**
   * Reads every supported pool in one call. Unsupported pools are skipped.
   * Throws on transport errors so the gate can back off; never invents a price.
   */
  async read(wanted: Array<{ mint: string; pair: string }>, now: number): Promise<Map<string, ChainRead>> {
    const out = new Map<string, ChainRead>();
    if (!wanted.length) return out;
    await this.resolve(wanted, now);
    const pools = wanted.map((w) => this.info(w.pair)).filter((p): p is PoolInfo => p != null && p.mint === wanted.find((w) => w.pair === p.pair)?.mint);
    if (!pools.length) return out;
    const keys: string[] = [];
    for (const p of pools) {
      if (p.kind === "curve") keys.push(p.pair);
      else keys.push(p.baseVault!, p.quoteVault!);
    }
    const accounts = await this.rpc(keys);
    let k = 0;
    for (const p of pools) {
      if (p.kind === "curve") {
        const acc = accounts[k++];
        const parsed = acc && acc.owner === PUMP_PROGRAM ? parseCurve(Buffer.from(acc.data[0], "base64"), p.decimals) : null;
        if (!parsed || parsed.complete) {
          // Migrated or gone: look at the pair again later instead of quoting a dead curve.
          this.pools.set(p.pair, { unsupported: true, at: now });
          continue;
        }
        if (parsed.native > 0 && Number.isFinite(parsed.native)) out.set(p.mint, { mint: p.mint, pair: p.pair, kind: p.kind, native: parsed.native, at: now });
      } else {
        const base = accounts[k++];
        const quote = accounts[k++];
        if (!base || !quote) continue;
        const baseAmt = tokenAmount(Buffer.from(base.data[0], "base64")) / 10 ** p.decimals;
        const quoteAmt = tokenAmount(Buffer.from(quote.data[0], "base64")) / 1e9;
        const native = quoteAmt / baseAmt;
        if (baseAmt > 0 && quoteAmt > 0 && Number.isFinite(native)) out.set(p.mint, { mint: p.mint, pair: p.pair, kind: p.kind, native, at: now });
      }
    }
    return out;
  }
}
