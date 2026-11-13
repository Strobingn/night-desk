import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { bundleShare, slotActivity } from "../src/market/bundle.js";
import { addTipToLegacy, clearSenderIdem, MIN_TIP_LAMPORTS, sendLiveTransaction, SENDER_TIP_ACCOUNTS } from "../src/market/helius-sender.js";
import { decodeMintSafety, encodeMint, safeMintAccount, TOKEN_2022, TOKENKEG } from "../src/market/mint-safety.js";
import { bucketFor, rpcLane } from "../src/market/net.js";
import { testConfig } from "./helpers.js";

const MINT = "GoodMint1111111111111111111111111111111111";

describe("v13.23 token safety", () => {
  it("blocks a freeze-active mint and lets Buy anyway through", async () => {
    const desk = new Desk(testConfig(), {
      mintAccounts: async () => ({ owner: TOKENKEG, data: encodeMint({ freezeAuthority: true }) })
    });
    try {
      desk.updateSettings({ autoBuy: false });
      await desk.submitCandidate(makeToken({ mint: MINT }));
      expect(desk.book.positions.size).toBe(0);
      const held = await desk.manualBuy(MINT);
      expect(held.ok).toBe(false);
      if (held.ok) return;
      expect(held.error).toMatch(/Blocked: freeze authority active/);
      expect(held.code).toBe("HARD_KILL");
      const bought = await desk.manualBuy(MINT, undefined, { confirmHardKill: true });
      expect(bought.ok).toBe(true);
      expect(desk.snapshot().positions[0]?.safetyChip).toBe("Blocked: freeze authority active");
    } finally {
      desk.stop();
    }
  });

  it("blocks a Token-2022 TransferHook and passes a normal pump mint", async () => {
    const hook = decodeMintSafety({
      owner: TOKEN_2022,
      data: encodeMint({ extensions: [{ type: 14, data: new Uint8Array(32) }] })
    });
    expect(hook.chip).toBe("Blocked: Token-2022 TransferHook");
    const frozen = decodeMintSafety({
      owner: TOKEN_2022,
      data: encodeMint({ extensions: [{ type: 6, data: Uint8Array.of(2) }] })
    });
    expect(frozen.chip).toBe("Blocked: Token-2022 DefaultAccountState frozen");
    expect(decodeMintSafety(safeMintAccount()).chip).toBe("Safe");

    const desk = new Desk(testConfig(), {
      mintAccounts: async () => ({ owner: TOKEN_2022, data: encodeMint({ extensions: [{ type: 14, data: new Uint8Array(32) }] }) })
    });
    try {
      desk.updateSettings({ autoBuy: false });
      await desk.submitCandidate(makeToken({ mint: MINT }));
      const held = await desk.manualBuy(MINT);
      expect(held.ok).toBe(false);
      if (!held.ok) expect(held.error).toMatch(/Blocked: Token-2022 TransferHook/);
    } finally {
      desk.stop();
    }

    const open = new Desk(testConfig(), { mintAccounts: async () => safeMintAccount() });
    try {
      open.updateSettings({ autoBuy: false });
      await open.submitCandidate(makeToken({ mint: MINT, symbol: "PUMP" }));
      const bought = await open.manualBuy(MINT);
      expect(bought.ok).toBe(true);
      expect(open.snapshot().positions[0]?.safetyChip).toBe("Safe");
    } finally {
      open.stop();
    }
  });

  it("shows Unknown and does not block a manual buy when the mint read fails, and the AI skips", async () => {
    const desk = new Desk(testConfig(), { mintAccounts: async () => null });
    try {
      await desk.submitCandidate(makeToken({ mint: MINT, symbol: "UNK" }));
      expect(desk.book.positions.size).toBe(0);
      const bought = await desk.manualBuy(MINT);
      expect(bought.ok).toBe(true);
      expect(desk.snapshot().positions[0]?.safetyChip).toBe("Unknown");
    } finally {
      desk.stop();
    }
  });
});

describe("v13.23 launch bundle", () => {
  it("excludes the curve PDA and pool vault, and flags 20% or a shared funder", () => {
    const curve = "CurvePda111111111111111111111111111111111";
    const vault = "PoolVault11111111111111111111111111111111";
    const supply = 1_000_000n;
    const excluded = new Set([curve, vault]);
    const flagged = bundleShare({
      supply,
      excluded,
      deltas: [
        { owner: curve, account: "curveAta", delta: 800_000n },
        { owner: "pool", account: vault, delta: 500_000n },
        { owner: "creator", account: "cAta", delta: 150_000n },
        { owner: "buyer", account: "bAta", delta: 50_000n }
      ]
    });
    expect(flagged.acquired).toBe(200_000n);
    expect(flagged.flagged).toBe(true);
    expect(flagged.label).toBe("Bundled 20%");

    const under = bundleShare({
      supply,
      excluded,
      deltas: [
        { owner: curve, account: "curveAta", delta: 800_000n },
        { owner: "creator", account: "cAta", delta: 100_000n },
        { owner: "buyer", account: "bAta", delta: 50_000n }
      ]
    });
    expect(under.flagged).toBe(false);
    expect(under.label).toBeNull();

    const funded = bundleShare({
      supply,
      excluded,
      deltas: [
        { owner: "a", account: "aAta", delta: 10_000n },
        { owner: "b", account: "bAta", delta: 10_000n }
      ],
      funders: new Map([
        ["a", "parent"],
        ["b", "parent"]
      ])
    });
    expect(funded.flagged).toBe(true);
    expect(funded.label).toBe("Bundled 2%");
  });

  it("reads same-slot deltas for one mint and ignores the other", () => {
    const activity = slotActivity("MintA", [
      {
        transaction: { message: { accountKeys: ["ata", "payer"] } },
        meta: {
          preTokenBalances: [],
          postTokenBalances: [
            { accountIndex: 0, mint: "MintA", owner: "wallet", uiTokenAmount: { amount: "25" } },
            { accountIndex: 0, mint: "MintB", owner: "wallet", uiTokenAmount: { amount: "999" } }
          ]
        }
      }
    ]);
    expect(activity.deltas).toEqual([{ owner: "wallet", account: "ata", delta: 25n }]);
  });

  it("keeps bundle reads on the Helius read lane and Sender off the credit budget", () => {
    const helius = bucketFor("https://mainnet.helius-rpc.com/?api-key=test");
    expect(rpcLane(helius, 2, JSON.stringify({ method: "getAccountInfo" }))?.id).toBe("helius");
    expect(rpcLane(helius, 2, JSON.stringify({ method: "getBlock" }))?.id).toBe("helius");
    expect(rpcLane(helius, 1, JSON.stringify({ method: "getAccountInfo" }))?.id).toBe("helius:exec");
    expect(rpcLane(helius, -1, JSON.stringify({ method: "getAccountInfo" }))?.id).toBe("helius:exec");
    expect(rpcLane(helius, -1, JSON.stringify({ method: "getAccountInfo" }), true)?.id).toBe("helius");
    expect(rpcLane(helius, -1, JSON.stringify({ method: "getBlock" }), true)?.id).toBe("helius");
    expect(rpcLane(helius, -1, JSON.stringify({ method: "getSignaturesForAddress" }), true)?.id).toBe("helius");
    expect(bucketFor("https://sender.helius-rpc.com/fast?swqos_only=true")).toBeNull();
    expect(bucketFor("http://ewr-sender.helius-rpc.com/fast?swqos_only=true")).toBeNull();
  });
});

describe("v13.23 Helius Sender", () => {
  it("falls back once when Sender rejects, and a second call with the same key does not send again", async () => {
    clearSenderIdem();
    let sends = 0;
    let fallbacks = 0;
    const fetchImpl = (async () => {
      sends += 1;
      return new Response(JSON.stringify({ error: { message: "rejected" } }), { status: 500, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const first = await sendLiveTransaction({
      idemKey: "order-1",
      raw: Uint8Array.of(1, 2, 3),
      fetchImpl,
      fallback: async () => {
        fallbacks += 1;
        return "fallback-sig";
      }
    });
    const second = await sendLiveTransaction({
      idemKey: "order-1",
      raw: Uint8Array.of(1, 2, 3),
      fetchImpl,
      fallback: async () => {
        fallbacks += 1;
        return "second";
      }
    });
    expect(first).toBe("fallback-sig");
    expect(second).toBe("fallback-sig");
    expect(sends).toBe(1);
    expect(fallbacks).toBe(1);
  });

  it("does not fall back when Sender returns a signature, and a timeout does not send twice", async () => {
    clearSenderIdem();
    let fallbacks = 0;
    const ok = await sendLiveTransaction({
      idemKey: "order-2",
      raw: Uint8Array.of(4),
      fetchImpl: (async () => new Response(JSON.stringify({ result: "sender-sig" }), { status: 200 })) as typeof fetch,
      fallback: async () => {
        fallbacks += 1;
        return "nope";
      }
    });
    expect(ok).toBe("sender-sig");
    expect(fallbacks).toBe(0);

    clearSenderIdem();
    await expect(
      sendLiveTransaction({
        idemKey: "order-3",
        raw: Uint8Array.of(5),
        fetchImpl: (async () => {
          throw new Error("fetch failed");
        }) as typeof fetch,
        fallback: async () => {
          fallbacks += 1;
          return "nope";
        }
      })
    ).rejects.toThrow(/unconfirmed|Nothing new|submitted/i);
    expect(fallbacks).toBe(0);
  });

  it("puts the minimum tip and a priority fee on a legacy transaction", () => {
    const payer = Keypair.generate();
    const tx = new Transaction();
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = payer.publicKey.toBase58();
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }));
    addTipToLegacy(tx, payer.publicKey, MIN_TIP_LAMPORTS);
    const tips = tx.instructions.filter((ix) => SENDER_TIP_ACCOUNTS.includes(ix.keys[1]?.pubkey.toBase58() as (typeof SENDER_TIP_ACCOUNTS)[number]));
    expect(tips).toHaveLength(1);
    expect(Buffer.from(tips[0]!.data).readBigUInt64LE(4)).toBe(BigInt(MIN_TIP_LAMPORTS));
  });
});
