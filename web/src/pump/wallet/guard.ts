/**
 * Checks an unsigned legacy transaction before any wallet window opens.
 * Fee payer must be the connected wallet, every instruction program must be
 * on the allowlist, and neither the declared trade size nor a system-program
 * spend by the fee payer may exceed the cap.
 */

/** pump, PumpSwap, pump-fees, system, token, Token-2022, ATA, compute budget. */
export const ALLOWED_PROGRAMS: ReadonlySet<string> = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111"
]);

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type GuardCode = "FOREIGN_FEE_PAYER" | "UNKNOWN_PROGRAM" | "OVER_CAP" | "MALFORMED";

export interface GuardVerdict {
  ok: boolean;
  code?: GuardCode;
  message?: string;
}

export function inspectTx(input: {
  unsignedTx: string;
  wallet: string;
  amountLamports: bigint;
  capLamports: bigint;
}): GuardVerdict {
  if (input.capLamports < 0n || input.amountLamports < 0n) {
    return { ok: false, code: "MALFORMED", message: "Amount and cap must be non-negative lamports." };
  }
  if (input.amountLamports > input.capLamports) {
    return { ok: false, code: "OVER_CAP", message: "Trade amount is above the cap." };
  }
  let decoded: DecodedLegacy;
  try {
    decoded = decodeLegacy(bytesFromBase64(input.unsignedTx));
  } catch (err) {
    return { ok: false, code: "MALFORMED", message: err instanceof Error ? err.message : "Transaction could not be read." };
  }
  if (decoded.feePayer !== input.wallet) {
    return { ok: false, code: "FOREIGN_FEE_PAYER", message: "Fee payer is not the connected wallet." };
  }
  for (const program of decoded.programIds) {
    if (!ALLOWED_PROGRAMS.has(program)) {
      return { ok: false, code: "UNKNOWN_PROGRAM", message: `Program ${program} is not allowlisted.` };
    }
  }
  if (decoded.feePayerSystemSpend > input.capLamports) {
    return { ok: false, code: "OVER_CAP", message: "System-program spend by the fee payer is above the cap." };
  }
  return { ok: true };
}

interface DecodedLegacy {
  feePayer: string;
  programIds: string[];
  feePayerSystemSpend: bigint;
}

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let body = "";
  while (n > 0n) {
    const rem = n % 58n;
    n /= 58n;
    body = BASE58[Number(rem)] + body;
  }
  return "1".repeat(zeros) + body;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesFromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, "");
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new Error("Transaction is not base64.");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i] ?? "");
    const b = B64.indexOf(clean[i + 1] ?? "");
    const c = clean[i + 2] === "=" ? 0 : B64.indexOf(clean[i + 2] ?? "");
    const d = clean[i + 3] === "=" ? 0 : B64.indexOf(clean[i + 3] ?? "");
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("Transaction is not base64.");
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (p < out.length) out[p++] = (n >> 16) & 255;
    if (p < out.length) out[p++] = (n >> 8) & 255;
    if (p < out.length) out[p++] = n & 255;
  }
  return out;
}

class Reader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  remaining(): number {
    return this.bytes.length - this.pos;
  }
  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error("Transaction ended early.");
    return this.bytes[this.pos++] ?? 0;
  }
  bytesOf(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.bytes.length) throw new Error("Transaction ended early.");
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }
  compactU16(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 3; i += 1) {
      const b = this.u8();
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
    }
    throw new Error("Compact length is too wide.");
  }
}

function u32le(data: Uint8Array): number {
  return (data[0] ?? 0) | ((data[1] ?? 0) << 8) | ((data[2] ?? 0) << 16) | ((data[3] ?? 0) << 24);
}

function u64le(data: Uint8Array, offset: number): bigint {
  let n = 0n;
  for (let i = 0; i < 8; i += 1) n += BigInt(data[offset + i] ?? 0) << BigInt(8 * i);
  return n;
}

/** Legacy (non-versioned) transaction. The fee payer is account key 0. */
export function decodeLegacy(bytes: Uint8Array): DecodedLegacy {
  const r = new Reader(bytes);
  const sigs = r.compactU16();
  if (sigs > 8) throw new Error("Too many signatures.");
  r.bytesOf(sigs * 64);
  const lead = r.u8();
  if ((lead & 0x80) !== 0) throw new Error("Versioned transactions are not accepted.");
  r.u8();
  r.u8();
  const keyCount = r.compactU16();
  if (keyCount < 1 || keyCount > 64) throw new Error("Account list is empty or too long.");
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i += 1) keys.push(encodeBase58(r.bytesOf(32)));
  r.bytesOf(32);
  const ixCount = r.compactU16();
  const programIds: string[] = [];
  let spend = 0n;
  const feePayer = keys[0] ?? "";
  for (let i = 0; i < ixCount; i += 1) {
    const programIndex = r.u8();
    const program = keys[programIndex];
    if (!program) throw new Error("Instruction program index is out of range.");
    programIds.push(program);
    const accCount = r.compactU16();
    const accounts: number[] = [];
    for (let a = 0; a < accCount; a += 1) accounts.push(r.u8());
    const dataLen = r.compactU16();
    const data = r.bytesOf(dataLen);
    if (program === SYSTEM_PROGRAM && data.length >= 12 && u32le(data) === 2) {
      const source = keys[accounts[0] ?? -1];
      if (source === feePayer) spend += u64le(data, 4);
    }
  }
  if (r.remaining() !== 0) throw new Error("Transaction has trailing bytes.");
  return { feePayer, programIds, feePayerSystemSpend: spend };
}
