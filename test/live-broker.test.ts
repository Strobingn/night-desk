import { describe, expect, it, vi } from "vitest";
import {
  AddressLookupTableAccount, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
  type Connection, type VersionedTransactionResponse
} from "@solana/web3.js";
import { atomicAmount, confirmedFill, executeLiveSwap, signatureBase58, USDC_MINT, type LiveSwapRequest } from "../src/market/live-broker.js";
import { resolveLiveExecution } from "../src/market/live-options.js";

const signer = Keypair.generate();
const mint = Keypair.generate().publicKey;
const feeKey = Keypair.generate().publicKey;
const tipKey = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();
const request: LiveSwapRequest = {
  side: "buy", mint: mint.toBase58(), sizeUsd: 8, decimals: 6, markUsd: 0.08,
  keypairPath: "", rpcUrl: "https://rpc.test", quoteUrl: "https://jupiter.test/quote", swapUrl: "https://jupiter.test/swap"
};

function tokenBalance(index: number, token: string, raw: string, owner = signer.publicKey.toBase58()) {
  return { accountIndex: index, mint: token, owner,
    uiTokenAmount: { amount: raw, decimals: 6, uiAmount: Number(raw) / 1e6, uiAmountString: String(Number(raw) / 1e6) } };
}

function fixture({ jito = false, fee = false, alt = false } = {}) {
  const options = { ...resolveLiveExecution({}), transport: jito ? "jito" as const : "rpc" as const,
    platformFeeBps: fee ? 85 : 0, feeAccount: fee ? feeKey.toBase58() : undefined };
  const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey,
    state: { deactivationSlot: 18_446_744_073_709_551_615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [feeKey] } });
  const instructions = [new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: true }, { pubkey: feeKey, isSigner: false, isWritable: true }],
    data: Buffer.alloc(1)
  })];
  if (jito) instructions.push(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: tipKey, lamports: options.jitoTipLamports }));
  const message = new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(alt ? [table] : []);
  const unsigned = new VersionedTransaction(message);
  const keys = [...message.staticAccountKeys, ...(alt ? [feeKey] : [])];
  const feeIndex = keys.findIndex((key) => key.equals(feeKey));
  const before = [tokenBalance(40, USDC_MINT, "100000000"), tokenBalance(41, mint.toBase58(), "0")];
  const after = [tokenBalance(40, USDC_MINT, "92000000"), tokenBalance(41, mint.toBase58(), "99500000")];
  if (fee) {
    before.push(tokenBalance(feeIndex, USDC_MINT, "100", "treasury"));
    after.push(tokenBalance(feeIndex, USDC_MINT, "68100", "treasury"));
  }
  const receipt = { transaction: { message }, meta: { err: null, fee: 5000,
    preTokenBalances: before, postTokenBalances: after,
    loadedAddresses: { writable: alt ? [feeKey] : [], readonly: [] } } } as unknown as VersionedTransactionResponse;
  const quote: Record<string, unknown> = {
    inputMint: USDC_MINT, outputMint: mint.toBase58(), inAmount: "8000000", outAmount: "100000000",
    otherAmountThreshold: "99000000", swapMode: "ExactIn", slippageBps: 100, priceImpactPct: "0.003",
    platformFee: fee ? { amount: "68000", feeBps: 85 } : null, routePlan: [], providerExtra: { preserve: true }
  };
  const feeData = Buffer.alloc(165); feeData.writeBigUInt64LE(68100n, 64);
  const connection = {
    getAddressLookupTable: vi.fn(async () => ({ value: table })),
    getParsedAccountInfo: vi.fn(async () => ({ value: {
      owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      data: { parsed: { info: { mint: USDC_MINT, owner: "treasury", state: "initialized", tokenAmount: { amount: "100" } } } }
    } })),
    simulateTransaction: vi.fn(async () => ({ value: { err: null, accounts: fee ? [{ data: [feeData.toString("base64"), "base64"] }] : null } })),
    sendRawTransaction: vi.fn(async (wire: Uint8Array) => signatureBase58(VersionedTransaction.deserialize(wire).signatures[0]!)),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    getTransaction: vi.fn(async () => receipt)
  };
  const swapBodies: Record<string, unknown>[] = [];
  const bundles: unknown[][] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/quote")) return Response.json(quote);
    const body = JSON.parse(String(init?.body));
    if (url.includes("/swap")) {
      swapBodies.push(body);
      return Response.json({ swapTransaction: Buffer.from(unsigned.serialize()).toString("base64"), lastValidBlockHeight: 12345 });
    }
    if (body.method === "getTipAccounts") return Response.json({ result: [tipKey.toBase58()] });
    if (body.method === "sendBundle") { bundles.push(body.params); return Response.json({ result: "bundle-1" }); }
    throw new Error(`Unexpected fetch ${url}`);
  });
  const run = (overrides: Partial<LiveSwapRequest> = {}) => executeLiveSwap({ ...request, execution: options, ...overrides },
    { signer, connection: connection as unknown as Connection, fetchImpl: fetchImpl as typeof fetch });
  return { run, connection, quote, swapBodies, receipt, bundles, fetchImpl, options };
}

describe("bounded live execution", () => {
  it("records confirmed balances rather than quoted quantities and confirms the signed expiry", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.qty).toBe(99.5);
    expect(result.rawQty).toBe("99500000");
    expect(result.notionalUsd).toBe(8);
    expect(result.feeUsd).toBe(0);
    expect(result.networkFeeLamports).toBe(5000);
    expect(f.connection.confirmTransaction).toHaveBeenCalledWith(expect.objectContaining({ blockhash, lastValidBlockHeight: 12345 }), "confirmed");
    expect(f.swapBodies[0]!.quoteResponse).toEqual(f.quote);
    expect(f.swapBodies[0]!.dynamicComputeUnitLimit).toBe(true);
  });

  it("persists the signed order before submission", async () => {
    const f = fixture();
    await f.run({ onPrepared: (order) => {
      expect(order.signature).toBeTruthy();
      expect(order.blockhash).toBe(blockhash);
      expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
    } });
  });

  it.each([
    { inAmount: "9000000" }, { outputMint: USDC_MINT }, { priceImpactPct: "0.02" },
    { priceImpactPct: "NaN" }, { otherAmountThreshold: "1" }, { slippageBps: 1500 }, { outAmount: "-1" }
  ])("rejects an out-of-bounds quote before sending: %j", async (change) => {
    const f = fixture(); Object.assign(f.quote, change);
    await expect(f.run()).rejects.toThrow();
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses unknown decimals before fetching or signing", async () => {
    const f = fixture();
    await expect(f.run({ decimals: null })).rejects.toThrow(/decimals/);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses failed simulation before sending", async () => {
    const f = fixture();
    f.connection.simulateTransaction.mockResolvedValueOnce({ value: { err: { InstructionError: [0, "bad"] }, accounts: null } } as never);
    await expect(f.run()).rejects.toThrow(/simulation/);
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("treats confirmed on-chain errors as failures, never fills", async () => {
    const f = fixture();
    f.connection.confirmTransaction.mockResolvedValueOnce({ value: { err: { InstructionError: [0, "bad"] } } } as never);
    await expect(f.run()).rejects.toMatchObject({ outcome: "failed" });
    expect(f.connection.getTransaction).not.toHaveBeenCalled();
  });

  it("retains the signature when submission is uncertain", async () => {
    const f = fixture();
    f.connection.sendRawTransaction.mockRejectedValueOnce(new Error("timeout"));
    await expect(f.run()).rejects.toMatchObject({ outcome: "unknown", signature: expect.any(String) });
    expect(f.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not turn a confirmation without receipt into a fill", async () => {
    const f = fixture(); f.connection.getTransaction.mockResolvedValueOnce(null as never);
    await expect(f.run()).rejects.toMatchObject({ outcome: "unknown" });
  });

  it("preserves lookup tables and verifies the fee in simulation and the confirmed transaction", async () => {
    const f = fixture({ fee: true, alt: true });
    const result = await f.run();
    expect(result.feeUsd).toBe(0.068);
    expect(f.swapBodies[0]!.feeAccount).toBe(feeKey.toBase58());
    expect(f.connection.getAddressLookupTable).toHaveBeenCalledTimes(1);
    const wire = f.connection.sendRawTransaction.mock.calls[0]![0];
    expect(VersionedTransaction.deserialize(wire).message.addressTableLookups).toHaveLength(1);
  });

  it("refuses a missing atomic fee before sending", async () => {
    const f = fixture({ fee: true });
    f.connection.simulateTransaction.mockResolvedValueOnce({ value: { err: null, accounts: null } });
    await expect(f.run()).rejects.toThrow(/fee atomically/);
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not accept a quote that omits the configured fee", async () => {
    const f = fixture({ fee: true }); f.quote.platformFee = null;
    await expect(f.run()).rejects.toThrow(/fee missing/);
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("sends a single tipped Jito transaction with base64 and waits for on-chain confirmation", async () => {
    const f = fixture({ jito: true, fee: true });
    const result = await f.run();
    expect(result.bundleId).toBe("bundle-1");
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(f.bundles).toHaveLength(1);
    expect(f.bundles[0]![1]).toEqual({ encoding: "base64" });
    expect(f.bundles[0]![0]).toHaveLength(1);
    expect(f.connection.confirmTransaction).toHaveBeenCalledTimes(1);
  });

  it("never falls back to public RPC after Jito rejects a bundle", async () => {
    const f = fixture({ jito: true });
    f.fetchImpl.mockImplementationOnce(async () => Response.json(f.quote))
      .mockImplementationOnce(async () => {
        const other = fixture({ jito: true });
        return other.fetchImpl("https://jupiter.test/swap", { body: "{}" });
      });
    // The other fixture has the same tip account and signer.
    f.fetchImpl.mockImplementationOnce(async () => Response.json({ result: [tipKey.toBase58()] }))
      .mockImplementationOnce(async () => Response.json({ error: { message: "auction rejected" } }));
    await expect(f.run()).rejects.toMatchObject({ outcome: "unknown" });
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("counts sell fees once and reports net proceeds", () => {
    const f = fixture({ fee: true });
    f.receipt.meta!.preTokenBalances = [tokenBalance(40, USDC_MINT, "0"), tokenBalance(41, mint.toBase58(), "100000000"), tokenBalance(1, USDC_MINT, "0", "treasury")];
    f.receipt.meta!.postTokenBalances = [tokenBalance(40, USDC_MINT, "9915000"), tokenBalance(41, mint.toBase58(), "0"), tokenBalance(1, USDC_MINT, "85000", "treasury")];
    const feeIndex = f.receipt.transaction.message.staticAccountKeys.findIndex((key) => key.equals(feeKey));
    f.receipt.meta!.preTokenBalances[2]!.accountIndex = feeIndex;
    f.receipt.meta!.postTokenBalances[2]!.accountIndex = feeIndex;
    const result = confirmedFill({ ...request, side: "sell", qty: 100 }, signer.publicKey.toBase58(), f.receipt, 100000000n, 9900000n, 85000n, feeKey.toBase58());
    expect(result.proceedsUsd).toBe(9.915);
    expect(result.notionalUsd).toBe(10);
    expect(result.feeUsd).toBe(0.085);
  });

  it("rejects unsafe atomic numbers instead of losing precision", () => {
    expect(atomicAmount(8, 6)).toBe("8000000");
    expect(() => atomicAmount(1e12, 9)).toThrow(/unsafe/);
    expect(() => atomicAmount(Number.NaN, 6)).toThrow();
  });
});
