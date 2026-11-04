import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import { CANONICAL_SOL_CURVE, curveState, solToReachMarketCap } from "../../src/pump/curve.js";
import { PUMP_FEE_PROGRAM, PUMP_PROGRAM, PUMP_SWAP_PROGRAM } from "../../src/pump/constants.js";
import { EMPTY_FEED, isFeedStale, prefillForTarget, reducePumpFrame } from "../../web/src/pump/curve.js";
import { ALLOWED_PROGRAMS, encodeBase58, inspectTx } from "../../web/src/pump/wallet/guard.js";
import { attachWalletStandard, connectStandard, type StandardWallet, type WalletHost } from "../../web/src/pump/wallet/provider.js";
import { approveIntent, type WalletOpener } from "../../web/src/pump/wallet/sign.js";
import type { TradeEvent } from "../../src/pump/types.js";

const CAP = 5_000_000n;

function unsigned(feePayer: PublicKey, ixs: TransactionInstruction[]): string {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = new PublicKey(Buffer.alloc(32, 7)).toBase58();
  tx.add(...ixs);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

function transfer(from: PublicKey, lamports: number): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: Keypair.generate().publicKey, lamports });
}

describe("bonding curve terminal", () => {
  it("marks a feed stale 5s after the last tick", () => {
    const curve = curveState("Mint", CANONICAL_SOL_CURVE);
    let state = reducePumpFrame(EMPTY_FEED, curve, 1_000);
    expect(state.ticks).toHaveLength(1);
    expect(state.lastTickAt).toBe(1_000);
    expect(isFeedStale(state.lastTickAt, 5_999)).toBe(false);
    expect(isFeedStale(state.lastTickAt, 6_000)).toBe(true);
    expect(isFeedStale(null, 6_000)).toBe(false);
    const trade: TradeEvent = {
      mint: "Mint",
      signature: "sig1",
      isBuy: true,
      user: "Buyer",
      solAmountLamports: "1000",
      tokenAmount: "1",
      virtualQuoteReserves: curve.virtualQuoteReserves,
      virtualTokenReserves: curve.virtualTokenReserves,
      realQuoteReserves: "0",
      realTokenReserves: curve.realTokenReserves,
      feeLamports: "0",
      creator: curve.creator,
      timestamp: 2_000,
      quoteMint: null,
      source: "log"
    };
    state = reducePumpFrame(state, trade, 2_000);
    expect(state.tape).toHaveLength(1);
    expect(state.tape[0]?.isBuy).toBe(true);
    expect(isFeedStale(state.lastTickAt, 6_999)).toBe(false);
    expect(isFeedStale(state.lastTickAt, 7_000)).toBe(true);
  });

  it("pre-fills a target mcap within 0.5% of the server reverse quote", () => {
    const curve = curveState("canonical", CANONICAL_SOL_CURVE);
    const start = BigInt(curve.marketCapLamports);
    for (const target of [start + 1n, start * 2n, BigInt(curve.graduationMarketCapLamports)]) {
      const client = prefillForTarget(curve, target);
      const server = solToReachMarketCap(CANONICAL_SOL_CURVE, target);
      expect(client.reachable).toBe(server.reachable);
      const clientSol = BigInt(client.solNeededLamports);
      const serverSol = BigInt(server.solNeededLamports);
      const denom = serverSol === 0n ? 1n : serverSol;
      const gap = Number(clientSol > serverSol ? clientSol - serverSol : serverSol - clientSol) / Number(denom);
      expect(gap).toBeLessThan(0.005);
    }
  });

  it("keeps the allowlist to pump, PumpSwap, pump fees, system, token, token-2022, ATA, and compute budget", () => {
    expect(encodeBase58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    for (const id of [
      PUMP_PROGRAM,
      PUMP_SWAP_PROGRAM,
      PUMP_FEE_PROGRAM,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      ComputeBudgetProgram.programId
    ]) {
      expect(ALLOWED_PROGRAMS.has(id.toBase58())).toBe(true);
    }
    expect(ALLOWED_PROGRAMS.has("FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe")).toBe(false);
    expect(ALLOWED_PROGRAMS.size).toBe(8);
  });

  it("rejects a foreign fee payer, an unknown program, and an over-cap amount", () => {
    const wallet = Keypair.generate();
    const other = Keypair.generate();
    const ok = unsigned(wallet.publicKey, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      transfer(wallet.publicKey, 1_000)
    ]);
    expect(inspectTx({ unsignedTx: ok, wallet: wallet.publicKey.toBase58(), amountLamports: 1_000n, capLamports: CAP }).ok).toBe(true);

    const foreign = inspectTx({ unsignedTx: ok, wallet: other.publicKey.toBase58(), amountLamports: 1_000n, capLamports: CAP });
    expect(foreign.ok).toBe(false);
    expect(foreign.code).toBe("FOREIGN_FEE_PAYER");

    const unknown = unsigned(wallet.publicKey, [
      new TransactionInstruction({
        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        keys: [],
        data: Buffer.from([1])
      })
    ]);
    const unknownVerdict = inspectTx({ unsignedTx: unknown, wallet: wallet.publicKey.toBase58(), amountLamports: 1n, capLamports: CAP });
    expect(unknownVerdict.ok).toBe(false);
    expect(unknownVerdict.code).toBe("UNKNOWN_PROGRAM");

    const over = inspectTx({ unsignedTx: ok, wallet: wallet.publicKey.toBase58(), amountLamports: CAP + 1n, capLamports: CAP });
    expect(over.ok).toBe(false);
    expect(over.code).toBe("OVER_CAP");

    const fat = unsigned(wallet.publicKey, [transfer(wallet.publicKey, 2_000_000_000)]);
    const fatVerdict = inspectTx({ unsignedTx: fat, wallet: wallet.publicKey.toBase58(), amountLamports: 1n, capLamports: CAP });
    expect(fatVerdict.ok).toBe(false);
    expect(fatVerdict.code).toBe("OVER_CAP");
  });

  it("does not open the wallet in simulate mode", async () => {
    const wallet = Keypair.generate();
    const raw = unsigned(wallet.publicKey, [transfer(wallet.publicKey, 1_000)]);
    let opens = 0;
    const opener: WalletOpener = {
      address: wallet.publicKey.toBase58(),
      open: async () => {
        opens += 1;
        throw new Error("wallet opened");
      }
    };
    const simulated = await approveIntent({
      unsignedTx: raw,
      wallet: opener.address,
      amountLamports: 1_000n,
      capLamports: CAP,
      simulateOnly: true,
      opener
    });
    expect(simulated.opened).toBe(false);
    expect(simulated.code).toBe("SIMULATED");
    expect(opens).toBe(0);

    const blocked = await approveIntent({
      unsignedTx: raw,
      wallet: Keypair.generate().publicKey.toBase58(),
      amountLamports: 1_000n,
      capLamports: CAP,
      simulateOnly: false,
      opener
    });
    expect(blocked.opened).toBe(false);
    expect(blocked.guard).toBe("FOREIGN_FEE_PAYER");
    expect(opens).toBe(0);

    const live = await approveIntent({
      unsignedTx: raw,
      wallet: opener.address,
      amountLamports: 1_000n,
      capLamports: CAP,
      simulateOnly: false,
      opener: { ...opener, open: async (bytes) => { opens += 1; return bytes; } }
    });
    expect(live.opened).toBe(true);
    expect(live.code).toBe("SIGNED");
    expect(opens).toBe(1);
  });

  it("registers a Wallet Standard wallet without opening it", async () => {
    const listeners = new Map<string, Set<(event: { type?: string; detail?: unknown }) => void>>();
    const host: WalletHost = {
      addEventListener(type, cb) {
        const set = listeners.get(type) ?? new Set();
        set.add(cb);
        listeners.set(type, set);
      },
      dispatchEvent(event) {
        for (const cb of listeners.get(event.type) ?? []) cb(event);
        return true;
      }
    };
    const seen: StandardWallet[] = [];
    attachWalletStandard(host, (wallet) => seen.push(wallet));
    const wallet: StandardWallet = {
      name: "Phantom",
      accounts: [],
      features: {
        "standard:connect": { connect: async () => ({ accounts: [{ address: "Addr111", publicKey: new Uint8Array(32) }] }) },
        "solana:signTransaction": { signTransaction: async (input) => [{ signedTransaction: input.transaction }] }
      }
    };
    for (const cb of listeners.get("wallet-standard:register-wallet") ?? []) {
      cb({ detail: (api: { register: (w: StandardWallet) => void }) => api.register(wallet) });
    }
    expect(seen.map((item) => item.name)).toEqual(["Phantom"]);
    const connected = await connectStandard(wallet);
    expect(connected.address).toBe("Addr111");
    const signed = await connected.open(new Uint8Array([1, 2, 3]));
    expect(Array.from(signed)).toEqual([1, 2, 3]);
  });
});
