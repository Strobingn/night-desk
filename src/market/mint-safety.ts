/**
 * v13.23 token safety. A pump curve mint with both authorities revoked passes.
 * An active mint or freeze authority, or a Token-2022 mint that can freeze,
 * hook, tax, pause, or block transfers, does not.
 *
 * Extension type numbers are the on-chain Token-2022 TLV tags
 * (spl-token ExtensionType). DefaultAccountState blocks only when the
 * default state byte is Frozen (2).
 */
import { MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

export const TOKENKEG = TOKEN_PROGRAM_ID.toBase58();
export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();

/** spl-token ExtensionType values. */
const EXT = {
  TransferFeeConfig: 1,
  MintCloseAuthority: 3,
  DefaultAccountState: 6,
  NonTransferable: 9,
  PermanentDelegate: 12,
  TransferHook: 14,
  PausableConfig: 26
} as const;

const MINT_SIZE = 82;
const ACCOUNT_SIZE = 165;
const FROZEN = 2;

export interface MintAccountBytes {
  owner: string;
  data: Uint8Array;
}

export interface MintSafety {
  status: "safe" | "blocked" | "unknown";
  /** "Safe", "Unknown", or "Blocked: <reason>". */
  chip: string;
  supply: bigint | null;
}

export const SAFETY_UNKNOWN: MintSafety = { status: "unknown", chip: "Unknown", supply: null };

export function blocked(reason: string, supply: bigint | null = null): MintSafety {
  return { status: "blocked", chip: `Blocked: ${reason}`, supply };
}

/** Revoked authorities, legacy token program. The shape a pump curve mint has. */
export function safeMintAccount(supply = 1_000_000_000n): MintAccountBytes {
  return { owner: TOKENKEG, data: encodeMint({ supply }) };
}

export function encodeMint(opts: {
  mintAuthority?: boolean;
  freezeAuthority?: boolean;
  supply?: bigint;
  extensions?: Array<{ type: number; data: Uint8Array }>;
} = {}): Buffer {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: opts.mintAuthority ? 1 : 0,
      mintAuthority: PublicKey.default,
      supply: opts.supply ?? 1_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: opts.freezeAuthority ? 1 : 0,
      freezeAuthority: PublicKey.default
    },
    base
  );
  if (!opts.extensions?.length) return base;
  const tlv = Buffer.concat(
    opts.extensions.map((ext) => {
      const head = Buffer.alloc(4 + ext.data.length);
      head.writeUInt16LE(ext.type, 0);
      head.writeUInt16LE(ext.data.length, 2);
      Buffer.from(ext.data).copy(head, 4);
      return head;
    })
  );
  const out = Buffer.alloc(ACCOUNT_SIZE + 1 + tlv.length);
  base.copy(out, 0);
  out[ACCOUNT_SIZE] = 1;
  tlv.copy(out, ACCOUNT_SIZE + 1);
  return out;
}

export function decodeMintSafety(account: MintAccountBytes | null | undefined): MintSafety {
  if (!account?.data || account.data.length < MINT_SIZE) return SAFETY_UNKNOWN;
  const owner = account.owner;
  if (owner !== TOKENKEG && owner !== TOKEN_2022) return SAFETY_UNKNOWN;
  let raw: { mintAuthorityOption: number; supply: bigint; freezeAuthorityOption: number };
  try {
    raw = MintLayout.decode(Buffer.from(account.data.subarray(0, MINT_SIZE))) as typeof raw;
  } catch {
    return SAFETY_UNKNOWN;
  }
  const supply = raw.supply;
  if (raw.mintAuthorityOption) return blocked("mint authority active", supply);
  if (raw.freezeAuthorityOption) return blocked("freeze authority active", supply);
  if (owner !== TOKEN_2022) return { status: "safe", chip: "Safe", supply };
  const hit = blockedExtension(account.data);
  if (hit === "malformed") return SAFETY_UNKNOWN;
  if (hit) return blocked(hit, supply);
  return { status: "safe", chip: "Safe", supply };
}

function blockedExtension(data: Uint8Array): string | null | "malformed" {
  if (data.length <= MINT_SIZE) return null;
  if (data.length <= ACCOUNT_SIZE || data[ACCOUNT_SIZE] !== 1) return "malformed";
  const present = new Set<number>();
  let frozenDefault = false;
  let offset = ACCOUNT_SIZE + 1;
  while (offset + 4 <= data.length) {
    const type = data[offset]! | (data[offset + 1]! << 8);
    const len = data[offset + 2]! | (data[offset + 3]! << 8);
    offset += 4;
    if (type === 0) break;
    if (offset + len > data.length) return "malformed";
    present.add(type);
    if (type === EXT.DefaultAccountState && len >= 1 && data[offset] === FROZEN) frozenDefault = true;
    offset += len;
  }
  if (present.has(EXT.PermanentDelegate)) return "Token-2022 PermanentDelegate";
  if (present.has(EXT.TransferHook)) return "Token-2022 TransferHook";
  if (present.has(EXT.TransferFeeConfig)) return "Token-2022 TransferFeeConfig";
  if (frozenDefault) return "Token-2022 DefaultAccountState frozen";
  if (present.has(EXT.PausableConfig)) return "Token-2022 Pausable";
  if (present.has(EXT.MintCloseAuthority)) return "Token-2022 MintCloseAuthority";
  if (present.has(EXT.NonTransferable)) return "Token-2022 NonTransferable";
  return null;
}
