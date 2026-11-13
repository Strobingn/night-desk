import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Desk } from "../src/desk/orchestrator.js";
import { BUCKETS, rpcLane } from "../src/market/net.js";
import { testConfig } from "./helpers.js";

const HELIUS = "https://mainnet.helius-rpc.com/?api-key=test";

describe("v13.49 launch-bundle check reads the coin's own launch transactions", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const buyer = Keypair.generate().publicKey.toBase58();
  const ata = Keypair.generate().publicKey.toBase58();

  type Call = { method: string; items: Array<{ method: string; params: unknown[] }>; priority?: number; readLane?: boolean };

  function deskWith(reply: (call: Call) => unknown): { desk: Desk; calls: Call[] } {
    const calls: Call[] = [];
    const desk = new Desk(testConfig({ walletRpcUrl: HELIUS }));
    desk.net.fetch = (async (_url: unknown, init?: RequestInit & { ndPriority?: number; ndReadLane?: boolean }) => {
      const parsed = JSON.parse(String(init?.body)) as unknown;
      const items = (Array.isArray(parsed) ? parsed : [parsed]) as Call["items"];
      const call: Call = { method: items[0]!.method, items, priority: init?.ndPriority, readLane: init?.ndReadLane };
      calls.push(call);
      return new Response(JSON.stringify(reply(call)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof desk.net.fetch;
    return { desk, calls };
  }

  const rpc = (desk: Desk) =>
    (desk as unknown as { rpcBundle: (mint: string, supply: bigint, priority?: -1 | 0 | 1 | 2) => Promise<unknown> }).rpcBundle.bind(desk);

  /** getTransaction shape: keys under message, unlike getBlock "accounts". */
  const tx = (amount: string) => ({
    slot: 9,
    meta: { preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint, owner: buyer, uiTokenAmount: { amount } }], innerInstructions: [] },
    transaction: { signatures: ["x"], message: { accountKeys: [{ pubkey: buyer }, { pubkey: ata }], instructions: [] } }
  });
  const block = (amount: string) => ({
    result: {
      transactions: [
        {
          meta: { preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint, owner: buyer, uiTokenAmount: { amount } }] },
          transaction: { accountKeys: [{ pubkey: buyer }, { pubkey: ata }] }
        }
      ]
    }
  });
  // Newest first, as the RPC returns them. Slot 9 is the launch slot.
  const signatures = (launch: Array<{ signature: string; err?: unknown }>) => ({
    result: [{ slot: 12, signature: "later2", err: null }, { slot: 11, signature: "later1", err: null }, ...launch.map((row) => ({ slot: 9, err: null, ...row }))]
  });

  it("fetches only the launch-slot transactions, in one batch, and never the block", async () => {
    const { desk, calls } = deskWith((call) => {
      if (call.method === "getSignaturesForAddress") return signatures([{ signature: "buy" }, { signature: "failed", err: { InstructionError: [] } }, { signature: "create" }]);
      if (call.method === "getTransaction") return call.items.map((item, id) => ({ jsonrpc: "2.0", id, result: tx(item.params[0] === "buy" ? "250000" : "0") }));
      throw new Error("the block must not be read");
    });
    try {
      const result = (await rpc(desk)(mint, 1_000_000n, -1)) as { flagged: boolean; pct: number };
      expect(result.flagged).toBe(true);
      expect(result.pct).toBe(25);
      expect(calls.map((call) => call.method)).toEqual(["getSignaturesForAddress", "getTransaction"]);
      expect(calls[1]!.items.map((item) => item.params[0])).toEqual(["buy", "create"]); // failed one left out, later slots left out
      expect(calls.every((call) => call.priority === -1 && call.readLane === true)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("reads the whole slot when the batch comes back incomplete", async () => {
    const { desk, calls } = deskWith((call) => {
      if (call.method === "getSignaturesForAddress") return signatures([{ signature: "buy" }, { signature: "create" }]);
      if (call.method === "getTransaction") return [{ jsonrpc: "2.0", id: 0, result: tx("250000") }, { jsonrpc: "2.0", id: 1, result: null }];
      return block("250000");
    });
    try {
      const result = (await rpc(desk)(mint, 1_000_000n, -1)) as { flagged: boolean };
      expect(result.flagged).toBe(true);
      expect(calls.map((call) => call.method)).toEqual(["getSignaturesForAddress", "getTransaction", "getBlock"]);
    } finally {
      desk.stop();
    }
  });

  it("reads the whole slot when the batch is refused outright", async () => {
    const { desk, calls } = deskWith((call) => {
      if (call.method === "getSignaturesForAddress") return signatures([{ signature: "create" }]);
      if (call.method === "getTransaction") return { jsonrpc: "2.0", error: { code: -32600, message: "batch requests are not allowed" } };
      return block("100000");
    });
    try {
      const result = (await rpc(desk)(mint, 1_000_000n, -1)) as { flagged: boolean };
      expect(result.flagged).toBe(false);
      expect(calls.at(-1)!.method).toBe("getBlock");
    } finally {
      desk.stop();
    }
  });

  it("goes straight to the slot read when more than ten transactions launched with the coin", async () => {
    const { desk, calls } = deskWith((call) => {
      if (call.method === "getSignaturesForAddress") return signatures(Array.from({ length: 11 }, (_, i) => ({ signature: `s${i}` })));
      return block("100000");
    });
    try {
      await rpc(desk)(mint, 1_000_000n, -1);
      expect(calls.map((call) => call.method)).toEqual(["getSignaturesForAddress", "getBlock"]);
    } finally {
      desk.stop();
    }
  });

  it("keeps a batched getTransaction on the Helius read lane", () => {
    const helius = BUCKETS.find((b) => b.id === "helius")!;
    const batch = JSON.stringify([{ jsonrpc: "2.0", id: 0, method: "getTransaction", params: ["a"] }, { jsonrpc: "2.0", id: 1, method: "getTransaction", params: ["b"] }]);
    expect(rpcLane(helius, 2, batch)?.id).toBe("helius");
    expect(rpcLane(helius, -1, batch, true)?.id).toBe("helius");
  });
});
