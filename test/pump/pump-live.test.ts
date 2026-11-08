import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { GLOBAL_PDA, bondingCurvePda } from "../../src/pump/sdk.js";
import { PUMP_PROGRAM } from "../../src/pump/constants.js";
import { quoteIsSolMint } from "../../src/pump/curve.js";
import type { PumpConnection } from "../../src/pump/rpc.js";
import { executePumpLiveSwap, usesPumpRoute } from "../../src/market/pump-live.js";

const root = path.resolve(".");

function fixture(name: string): { base64: string } {
  return JSON.parse(readFileSync(path.join(root, "test/fixtures/pump", name), "utf8"));
}

function mintData(): Buffer {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default
    },
    data
  );
  return data;
}

function world(mint: PublicKey, simErr: string | null = null): PumpConnection {
  const curve = Buffer.from(fixture("curve.json").base64, "base64");
  const global = Buffer.from(fixture("global.json").base64, "base64");
  const map = new Map<string, { data: Buffer; owner: string }>([
    [mint.toBase58(), { data: mintData(), owner: TOKEN_PROGRAM_ID.toBase58() }],
    [bondingCurvePda(mint).toBase58(), { data: curve, owner: PUMP_PROGRAM.toBase58() }]
  ]);
  return {
    async getAccountInfo(address: string) {
      const hit = map.get(address);
      if (hit) return hit;
      if (address === GLOBAL_PDA.toBase58()) return { data: global, owner: PUMP_PROGRAM.toBase58() };
      return null;
    },
    async getLatestBlockhash() {
      return PublicKey.default.toBase58();
    },
    async simulateTransaction() {
      return { err: simErr, units: 20, logs: ["simulated"] };
    }
  };
}

describe("pump live route", () => {
  it("builds, simulates, and signs a curve buy, and the test broadcast is the only send", async () => {
    const signer = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const sent: Uint8Array[] = [];
    const fill = await executePumpLiveSwap({
      side: "buy",
      mint: mint.toBase58(),
      sizeUsd: 5,
      decimals: 6,
      solPriceUsd: 150,
      markPriceUsd: 0.00000419851,
      slippageFraction: 0.03,
      readEnvSecret: () => JSON.stringify(Array.from(signer.secretKey)),
      rpcUrl: "http://127.0.0.1",
      connection: world(mint),
      broadcast: async (raw) => {
        sent.push(raw);
        return { signature: "sig-pump-buy", err: null };
      }
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.length).toBeGreaterThan(64);
    expect(fill.signature).toBe("sig-pump-buy");
    expect(fill.qty).toBeGreaterThan(0);
    expect(fill.notionalUsd).toBe(5);
    expect(fill.fillPriceUsd).toBeGreaterThan(0);
  });

  it("does not broadcast when simulation fails or the quote is not SOL", async () => {
    const signer = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    let calls = 0;
    await expect(
      executePumpLiveSwap({
        side: "buy",
        mint: mint.toBase58(),
        sizeUsd: 5,
        solPriceUsd: 150,
        markPriceUsd: 0.000001,
        slippageFraction: 0.03,
        readEnvSecret: () => JSON.stringify(Array.from(signer.secretKey)),
        rpcUrl: "http://127.0.0.1",
        connection: world(mint),
        broadcast: async () => {
          calls += 1;
          return { signature: "nope", err: null };
        }
      })
    ).rejects.toThrow(/Entry slippage/);
    expect(calls).toBe(0);
    await expect(
      executePumpLiveSwap({
        side: "buy",
        mint: mint.toBase58(),
        sizeUsd: 5,
        solPriceUsd: 150,
        markPriceUsd: 0.00000419851,
        slippageFraction: 0.5,
        readEnvSecret: () => JSON.stringify(Array.from(signer.secretKey)),
        rpcUrl: "http://127.0.0.1",
        connection: world(mint, "BlockhashNotFound"),
        broadcast: async () => {
          calls += 1;
          return { signature: "nope", err: null };
        }
      })
    ).rejects.toThrow(/simulation BlockhashNotFound/);
    expect(calls).toBe(0);
    await expect(
      executePumpLiveSwap({
        side: "buy",
        mint: mint.toBase58(),
        sizeUsd: 5,
        solPriceUsd: 150,
        readEnvSecret: () => JSON.stringify(Array.from(signer.secretKey)),
        rpcUrl: ""
      })
    ).rejects.toThrow(/SOLANA_RPC_URL is missing/);
    expect(quoteIsSolMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false);
    expect(usesPumpRoute({ dex: "pump.fun curve", priceFeed: "chain" })).toBe(true);
    expect(usesPumpRoute({ dex: "raydium", priceFeed: "dexscreener" })).toBe(false);
  });
});
