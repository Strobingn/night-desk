/**
 * Unsigned buy/sell transactions built with @pump-fun/pump-sdk and
 * @pump-fun/pump-swap-sdk. The fee payer is the requesting wallet.
 * This module never signs and never sends. The PumpPortal local-transaction API is not used.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  unpackMint,
  type RawMint
} from "@solana/spl-token";
import { AccountInfo, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import {
  GLOBAL_CONFIG_PDA,
  GLOBAL_PDA,
  PUMP_AMM_SDK,
  PUMP_SDK,
  bondingCurvePda,
  buyQuoteInput,
  canonicalPumpPoolPda,
  getFeeRecipient,
  type BondingCurve,
  type Global,
  type SwapSolanaState
} from "./sdk.js";
import { isTokenProgram, PUMP_FEE_PROGRAM, PUMP_PROGRAM, PUMP_SWAP_PROGRAM, SWAP_FEE_CONFIG, tokenProgramId } from "./constants.js";
import { buyTokens, quoteCurve, quoteIsSolMint, sellProceeds, type CurveReserves } from "./curve.js";
import { readCurveFees, readPoolFees } from "./fees.js";
import { decodePoolAccount, effectiveQuote, poolStateFromParts } from "./pumpswap.js";
import type { PumpConnection } from "./rpc.js";
import type { CurveState, PoolState, TradeQuote } from "./types.js";

export class IntentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function accountInfo(data: Buffer, owner: string): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 0, owner: new PublicKey(owner) } as AccountInfo<Buffer>;
}

function reservesFromBondingCurve(curve: BondingCurve): CurveReserves {
  const quote = curve.quoteMint?.equals?.(PublicKey.default) || !curve.quoteMint ? null : curve.quoteMint.toBase58();
  return {
    virtualTokenReserves: BigInt(curve.virtualTokenReserves.toString(10)),
    virtualQuoteReserves: BigInt(curve.virtualQuoteReserves.toString(10)),
    realTokenReserves: BigInt(curve.realTokenReserves.toString(10)),
    realQuoteReserves: BigInt(curve.realQuoteReserves.toString(10)),
    tokenTotalSupply: BigInt(curve.tokenTotalSupply.toString(10)),
    complete: curve.complete,
    creator: curve.creator.toBase58(),
    isMayhemMode: curve.isMayhemMode,
    quoteMint: quote
  };
}

async function loadCurve(connection: PumpConnection, mint: PublicKey): Promise<{ curve: BondingCurve; reserves: CurveReserves; address: string } | null> {
  const address = bondingCurvePda(mint).toBase58();
  const raw = await connection.getAccountInfo(address);
  if (!raw) return null;
  try {
    const curve = PUMP_SDK.decodeBondingCurve(accountInfo(raw.data, raw.owner));
    return { curve, reserves: reservesFromBondingCurve(curve), address };
  } catch {
    return null;
  }
}

async function tokenProgramFor(connection: PumpConnection, mint: string): Promise<"legacy" | "token2022"> {
  const raw = await connection.getAccountInfo(mint);
  if (!raw) throw new IntentError(422, "MINT_MISSING", "Mint account was not found.");
  const kind = isTokenProgram(raw.owner);
  if (!kind) throw new IntentError(422, "TOKEN_PROGRAM", "Mint is not owned by Tokenkeg or Token-2022.");
  return kind;
}

function buybackRecipient(global: Global): PublicKey {
  const listed = global.buybackFeeRecipients?.find((key) => key && !key.equals(PublicKey.default));
  return listed ?? global.feeRecipient;
}

export async function quoteMint(
  connection: PumpConnection,
  input: { mint: string; side: "buy" | "sell"; solLamports?: bigint; tokenAmount?: bigint; venue?: "curve" | "pumpswap" }
): Promise<{ quote: TradeQuote; curve: CurveState | null; pool: PoolState | null }> {
  const mint = new PublicKey(input.mint);
  const wantPool = input.venue === "pumpswap";
  const loaded = wantPool ? null : await loadCurve(connection, mint);
  if (loaded && !loaded.curve.complete && input.venue !== "pumpswap") {
    const fees = await readCurveFees(connection, loaded.curve);
    const amount = input.side === "buy" ? input.solLamports : input.tokenAmount;
    if (amount == null) throw new IntentError(400, "AMOUNT", input.side === "buy" ? "solLamports is required." : "tokenAmount is required.");
    const { curveState } = await import("./curve.js");
    return { quote: quoteCurve(loaded.reserves, input.side, amount, fees), curve: curveState(input.mint, loaded.reserves), pool: null };
  }
  const pool = await loadPool(connection, mint);
  if (!pool) throw new IntentError(422, "MARKET_MISSING", "No bonding curve or PumpSwap pool for that mint.");
  const fees = await readPoolFees(connection, pool.pool, pool.base, pool.effective, pool.supply);
  const feeBps = fees ? fees.lpFeeBps + fees.protocolFeeBps + fees.creatorFeeBps : null;
  if (input.side === "buy") {
    if (input.solLamports == null) throw new IntentError(400, "AMOUNT", "solLamports is required.");
    const tokens = poolTokensForSol(pool, input.solLamports);
    return {
      quote: {
        venue: "pumpswap",
        side: "buy",
        solLamports: input.solLamports.toString(),
        tokenAmount: tokens.toString(),
        feeBps: feeBps == null ? null : Number(feeBps),
        feeLamports: "0",
        feeSource: fees ? "chain" : "none"
      },
      curve: null,
      pool: pool.state
    };
  }
  if (input.tokenAmount == null) throw new IntentError(400, "AMOUNT", "tokenAmount is required.");
  const sol = poolSolForTokens(pool, input.tokenAmount);
  return {
    quote: {
      venue: "pumpswap",
      side: "sell",
      solLamports: sol.toString(),
      tokenAmount: input.tokenAmount.toString(),
      feeBps: feeBps == null ? null : Number(feeBps),
      feeLamports: "0",
      feeSource: fees ? "chain" : "none"
    },
    curve: null,
    pool: pool.state
  };
}

interface LoadedPool {
  pool: ReturnType<typeof decodePoolAccount>;
  address: string;
  base: bigint;
  quoteVault: bigint;
  effective: bigint;
  supply: bigint;
  state: PoolState;
  baseProgram: "legacy" | "token2022";
}

async function vaultBalance(connection: PumpConnection, address: string): Promise<bigint> {
  const raw = await connection.getAccountInfo(address);
  if (!raw || raw.data.length < 72) return 0n;
  return raw.data.readBigUInt64LE(64);
}

async function loadPool(connection: PumpConnection, mint: PublicKey): Promise<LoadedPool | null> {
  const address = canonicalPumpPoolPda(mint);
  const raw = await connection.getAccountInfo(address.toBase58());
  if (!raw) return null;
  let pool;
  try {
    pool = decodePoolAccount(raw.data);
  } catch {
    return null;
  }
  const base = await vaultBalance(connection, pool.poolBaseTokenAccount.toBase58());
  const quoteVault = await vaultBalance(connection, pool.poolQuoteTokenAccount.toBase58());
  const virtual = BigInt(pool.virtualQuoteReserves.toString(10));
  const effective = effectiveQuote(quoteVault, virtual);
  const mintRaw = await connection.getAccountInfo(mint.toBase58());
  const baseProgram = (mintRaw && isTokenProgram(mintRaw.owner)) || "legacy";
  const supply = mintRaw && mintRaw.data.length >= 44 ? mintRaw.data.readBigUInt64LE(36) : 1_000_000_000_000_000n;
  let state: PoolState;
  try {
    state = poolStateFromParts({ address: address.toBase58(), pool, baseReserve: base, quoteReserve: quoteVault, baseSupply: supply });
  } catch {
    return null;
  }
  return { pool, address: address.toBase58(), base, quoteVault, effective, supply, state, baseProgram };
}

/** Constant product on effective quote reserves (vault + signed virtual). Fees stay in `readPoolFees`. */
function poolTokensForSol(pool: LoadedPool, solIn: bigint): bigint {
  if (solIn <= 0n || pool.effective <= 0n) return 0n;
  return (solIn * pool.base) / (pool.effective + solIn);
}

function poolSolForTokens(pool: LoadedPool, tokens: bigint): bigint {
  if (tokens <= 0n || tokens >= pool.base) return 0n;
  return (tokens * pool.effective) / (pool.base - tokens) + 1n;
}

export interface BuiltIntent {
  venue: "curve" | "pumpswap";
  solLamports: bigint;
  tokenAmount: bigint;
  feeBps: number | null;
  instructions: TransactionInstruction[];
  quote: TradeQuote;
}

export async function buildIntent(
  connection: PumpConnection,
  input: { wallet: string; mint: string; side: "buy" | "sell"; solLamports?: bigint; tokenAmount?: bigint; slippageBps?: number; venue?: "curve" | "pumpswap" }
): Promise<BuiltIntent> {
  const user = new PublicKey(input.wallet);
  const mint = new PublicKey(input.mint);
  const slip = BigInt(input.slippageBps ?? 100);
  const kind = await tokenProgramFor(connection, input.mint);
  const tokenProgram = tokenProgramId(kind);
  const loaded = input.venue === "pumpswap" ? null : await loadCurve(connection, mint);
  if (loaded && !loaded.curve.complete && input.venue !== "pumpswap") {
    return buildCurve(connection, { user, mint, tokenProgram, loaded, side: input.side, solLamports: input.solLamports, tokenAmount: input.tokenAmount, slip });
  }
  return buildPool(connection, { user, mint, tokenProgram, kind, side: input.side, solLamports: input.solLamports, tokenAmount: input.tokenAmount, slip });
}

async function buildCurve(
  connection: PumpConnection,
  args: {
    user: PublicKey;
    mint: PublicKey;
    tokenProgram: PublicKey;
    loaded: { curve: BondingCurve; reserves: CurveReserves };
    side: "buy" | "sell";
    solLamports?: bigint;
    tokenAmount?: bigint;
    slip: bigint;
  }
): Promise<BuiltIntent> {
  if (!quoteIsSolMint(args.loaded.reserves.quoteMint)) {
    throw new IntentError(422, "QUOTE_MINT", "This curve is not quoted in SOL. No SOL buy or sell was built.");
  }
  const globalRaw = await connection.getAccountInfo(GLOBAL_PDA.toBase58());
  if (!globalRaw) throw new IntentError(422, "GLOBAL_MISSING", "Pump Global account was not found, so the fee recipient is unknown.");
  const global = PUMP_SDK.decodeGlobal(accountInfo(globalRaw.data, globalRaw.owner || PUMP_PROGRAM.toBase58()));
  const fees = await readCurveFees(connection, args.loaded.curve);
  const feeRecipient = getFeeRecipient(global, args.loaded.curve.isMayhemMode);
  const buyback = buybackRecipient(global);
  const ata = getAssociatedTokenAddressSync(args.mint, args.user, true, args.tokenProgram);
  const ixs: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(ata.toBase58()))) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(args.user, ata, args.user, args.mint, args.tokenProgram));
  }
  if (args.side === "buy") {
    if (args.solLamports == null) throw new IntentError(400, "AMOUNT", "solLamports is required.");
    const bought = buyTokens(args.loaded.reserves, args.solLamports, fees);
    if (bought.tokens <= 0n) throw new IntentError(422, "QUOTE_ZERO", "That SOL amount buys no tokens on the curve.");
    const maxSol = (args.solLamports * (10_000n + args.slip)) / 10_000n;
    ixs.push(
      await PUMP_SDK.getBuyInstructionRaw({
        user: args.user,
        mint: args.mint,
        creator: args.loaded.curve.creator,
        amount: new BN(bought.tokens.toString(10)),
        solAmount: new BN(maxSol.toString(10)),
        tokenProgram: args.tokenProgram,
        feeRecipient,
        buybackFeeRecipient: buyback
      })
    );
    return {
      venue: "curve",
      solLamports: args.solLamports,
      tokenAmount: bought.tokens,
      feeBps: fees ? Number(bought.feeBps) : null,
      instructions: ixs,
      quote: quoteCurve(args.loaded.reserves, "buy", args.solLamports, fees)
    };
  }
  if (args.tokenAmount == null) throw new IntentError(400, "AMOUNT", "tokenAmount is required.");
  const sold = sellProceeds(args.loaded.reserves, args.tokenAmount, fees);
  const minSol = (sold.lamports * (10_000n - args.slip)) / 10_000n;
  ixs.push(
    await PUMP_SDK.getSellInstructionRaw({
      user: args.user,
      mint: args.mint,
      creator: args.loaded.curve.creator,
      amount: new BN(args.tokenAmount.toString(10)),
      solAmount: new BN(minSol.toString(10)),
      tokenProgram: args.tokenProgram,
      feeRecipient,
      buybackFeeRecipient: buyback
    })
  );
  return {
    venue: "curve",
    solLamports: sold.lamports,
    tokenAmount: args.tokenAmount,
    feeBps: fees ? Number(sold.feeBps) : null,
    instructions: ixs,
    quote: quoteCurve(args.loaded.reserves, "sell", args.tokenAmount, fees)
  };
}

async function buildPool(
  connection: PumpConnection,
  args: {
    user: PublicKey;
    mint: PublicKey;
    tokenProgram: PublicKey;
    kind: "legacy" | "token2022";
    side: "buy" | "sell";
    solLamports?: bigint;
    tokenAmount?: bigint;
    slip: bigint;
  }
): Promise<BuiltIntent> {
  const loaded = await loadPool(connection, args.mint);
  if (!loaded) throw new IntentError(422, "MARKET_MISSING", "No PumpSwap pool for that mint.");
  if (!quoteIsSolMint(loaded.pool.quoteMint?.toBase58?.() ?? null)) {
    throw new IntentError(422, "QUOTE_MINT", "This PumpSwap pool is not quoted in SOL. No SOL buy or sell was built.");
  }
  const globalRaw = await connection.getAccountInfo(GLOBAL_CONFIG_PDA.toBase58());
  if (!globalRaw) throw new IntentError(422, "GLOBAL_MISSING", "PumpSwap global config was not found.");
  const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(accountInfo(globalRaw.data, globalRaw.owner));
  const feeRaw = await connection.getAccountInfo(SWAP_FEE_CONFIG.toBase58());
  let feeConfig = null;
  if (feeRaw) {
    try {
      feeConfig = PUMP_AMM_SDK.decodeFeeConfig(accountInfo(feeRaw.data, PUMP_FEE_PROGRAM.toBase58()));
    } catch {
      feeConfig = null;
    }
  }
  const mintRaw = await connection.getAccountInfo(args.mint.toBase58());
  if (!mintRaw) throw new IntentError(422, "MINT_MISSING", "Mint account was not found.");
  const unpacked = unpackMint(args.mint, accountInfo(mintRaw.data, mintRaw.owner), args.tokenProgram);
  const baseMintAccount: RawMint = {
    mintAuthorityOption: unpacked.mintAuthority ? 1 : 0,
    mintAuthority: unpacked.mintAuthority ?? PublicKey.default,
    supply: unpacked.supply,
    decimals: unpacked.decimals,
    isInitialized: unpacked.isInitialized,
    freezeAuthorityOption: unpacked.freezeAuthority ? 1 : 0,
    freezeAuthority: unpacked.freezeAuthority ?? PublicKey.default
  };
  const userBase = getAssociatedTokenAddressSync(args.mint, args.user, true, args.tokenProgram);
  const userQuote = getAssociatedTokenAddressSync(NATIVE_MINT, args.user, true);
  const state: SwapSolanaState = {
    globalConfig,
    feeConfig,
    poolKey: new PublicKey(loaded.address),
    poolAccountInfo: accountInfo((await connection.getAccountInfo(loaded.address))!.data, PUMP_SWAP_PROGRAM.toBase58()),
    pool: loaded.pool,
    poolBaseAmount: new BN(loaded.base.toString(10)),
    poolQuoteAmount: new BN(loaded.effective.toString(10)),
    baseTokenProgram: args.tokenProgram,
    quoteTokenProgram: tokenProgramId("legacy"),
    baseMint: args.mint,
    baseMintAccount,
    user: args.user,
    userBaseTokenAccount: userBase,
    userQuoteTokenAccount: userQuote,
    userBaseAccountInfo: null,
    userQuoteAccountInfo: null
  };
  // The SDK prices with vault quote. virtual reserves are already inside `effective`,
  // and buyQuoteInput adds virtualQuoteReserves again — pass 0 here because we pre-added them.
  if (args.side === "buy") {
    if (args.solLamports == null) throw new IntentError(400, "AMOUNT", "solLamports is required.");
    const priced = buyQuoteInput({
      quote: new BN(args.solLamports.toString(10)),
      slippage: Number(args.slip) / 100,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: new BN(0),
      globalConfig,
      baseMintAccount,
      baseMint: args.mint,
      coinCreator: loaded.pool.coinCreator,
      creator: loaded.pool.creator,
      feeConfig,
      quoteMint: loaded.pool.quoteMint,
      isMayhemMode: loaded.pool.isMayhemMode,
      creatorFeeBps: loaded.pool.creatorFeeBps
    });
    const ixs = await PUMP_AMM_SDK.buyInstructions(state, priced.base, priced.maxQuote);
    return {
      venue: "pumpswap",
      solLamports: args.solLamports,
      tokenAmount: BigInt(priced.base.toString(10)),
      feeBps: null,
      instructions: ixs,
      quote: {
        venue: "pumpswap",
        side: "buy",
        solLamports: args.solLamports.toString(),
        tokenAmount: priced.base.toString(10),
        feeBps: null,
        feeLamports: "0",
        feeSource: feeConfig ? "chain" : "none"
      }
    };
  }
  if (args.tokenAmount == null) throw new IntentError(400, "AMOUNT", "tokenAmount is required.");
  const sol = poolSolForTokens(loaded, args.tokenAmount);
  const min = (sol * (10_000n - args.slip)) / 10_000n;
  const ixs = await PUMP_AMM_SDK.sellInstructions(state, new BN(args.tokenAmount.toString(10)), new BN(min.toString(10)));
  return {
    venue: "pumpswap",
    solLamports: sol,
    tokenAmount: args.tokenAmount,
    feeBps: null,
    instructions: ixs,
    quote: {
      venue: "pumpswap",
      side: "sell",
      solLamports: sol.toString(),
      tokenAmount: args.tokenAmount.toString(),
      feeBps: null,
      feeLamports: "0",
      feeSource: feeConfig ? "chain" : "none"
    }
  };
}

export function serializeUnsigned(wallet: string, blockhash: string, instructions: TransactionInstruction[]): { tx: Transaction; base64: string } {
  const tx = new Transaction();
  tx.feePayer = new PublicKey(wallet);
  tx.recentBlockhash = blockhash;
  tx.add(...instructions);
  if (tx.feePayer.toBase58() !== wallet) throw new Error("Fee payer is not the requesting wallet.");
  if (tx.signatures.some((entry) => entry.signature != null)) throw new Error("Refusing to return a signed transaction.");
  const base64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  return { tx, base64 };
}
