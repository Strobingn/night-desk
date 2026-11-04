/**
 * Program ids taken from the official SDKs (verified against mainnet):
 *   pump        6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *   pump-swap   pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *   pump-fees   pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
 * Fee-config PDAs are derived, not pasted:
 *   curve       8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt
 *   pumpswap    5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx
 * Fee rates are not constants. They are read from those accounts.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PUMP_AMM_FEE_CONFIG_PDA, PUMP_AMM_PROGRAM_ID, PUMP_FEE_CONFIG_PDA, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID } from "./sdk.js";

export const PUMP_PROGRAM = PUMP_PROGRAM_ID;
export const PUMP_SWAP_PROGRAM = PUMP_AMM_PROGRAM_ID;
export const PUMP_FEE_PROGRAM = PUMP_FEE_PROGRAM_ID;

/** pump-fees FeeConfig for bonding curves (`["fee_config", pump_program]`). */
export const CURVE_FEE_CONFIG = PUMP_FEE_CONFIG_PDA;
/** pump-fees FeeConfig for PumpSwap (`["fee_config", pump_amm_program]`). */
export const SWAP_FEE_CONFIG = PUMP_AMM_FEE_CONFIG_PDA;

/** Legacy `create` mints. TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA. */
export const SPL_TOKEN_PROGRAM = TOKEN_PROGRAM_ID;
/** `create_v2` mints. TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb. */
export const SPL_TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID;

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Hard ceilings. Settings may only tighten or sit at these. */
export const TRADE_CAP_CEILING_LAMPORTS = 1n * LAMPORTS_PER_SOL;
export const DAY_CAP_CEILING_LAMPORTS = 5n * LAMPORTS_PER_SOL;
/** Defaults until a setting is saved. */
export const TRADE_CAP_DEFAULT_LAMPORTS = 5_000_000n;
export const DAY_CAP_DEFAULT_LAMPORTS = 25_000_000n;

export const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isTokenProgram(owner: PublicKey | string): "legacy" | "token2022" | null {
  const key = typeof owner === "string" ? owner : owner.toBase58();
  if (key === SPL_TOKEN_PROGRAM.toBase58()) return "legacy";
  if (key === SPL_TOKEN_2022_PROGRAM.toBase58()) return "token2022";
  return null;
}

export function tokenProgramId(kind: "legacy" | "token2022"): PublicKey {
  return kind === "token2022" ? SPL_TOKEN_2022_PROGRAM : SPL_TOKEN_PROGRAM;
}
