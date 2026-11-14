import { describe, expect, it } from "vitest";
import { BUCKETS, HELIUS_EXIT_RESERVE, NetLimiter, rpcLane } from "../src/market/net.js";
import { PROTOCOL_WARM_MS, forgetFixedAccounts, protocolWarmDue, rememberMintAccount, swapConnection, warmProtocolAccounts } from "../src/market/pump-live.js";
import { CURVE_FEE_CONFIG } from "../src/pump/constants.js";
import { GLOBAL_PDA } from "../src/pump/sdk.js";
import type { PumpConnection } from "../src/pump/rpc.js";

const HELIUS = "https://mainnet.helius-rpc.com/?api-key=test";
const rpc = (id: number, method: string) => JSON.stringify({ jsonrpc: "2.0", id, method, params: [`p${id}`] });

function counting(): { base: PumpConnection; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    base: {
      async getAccountInfo(address: string) {
        reads.push(address);
        return { data: Buffer.from([1, 2, 3]), owner: "Owner" };
      },
      getLatestBlockhash: async () => "hash",
      simulateTransaction: async () => ({ err: null, units: 1, logs: [] })
    }
  };
}

describe("v13.53 a swap reads each account once and keeps the fixed ones", () => {
  const MINT = "Mint1111111111111111111111111111111111111111";
  const CURVE = "Curve111111111111111111111111111111111111111";
  const GLOBAL = GLOBAL_PDA.toBase58();
  const FEES = CURVE_FEE_CONFIG.toBase58();

  it("reads an address once inside one swap, however many times the builder asks", async () => {
    forgetFixedAccounts();
    const { base, reads } = counting();
    const conn = swapConnection(base, MINT);
    await Promise.all([conn.getAccountInfo(GLOBAL), conn.getAccountInfo(GLOBAL), conn.getAccountInfo(CURVE)]);
    await conn.getAccountInfo(CURVE);
    expect(reads).toEqual([GLOBAL, CURVE]);
  });

  it("the next swap reads only the price account: the fixed accounts and the mint are kept", async () => {
    forgetFixedAccounts();
    const { base, reads } = counting();
    for (const address of [MINT, CURVE, GLOBAL, FEES]) await swapConnection(base, MINT).getAccountInfo(address);
    reads.length = 0;
    const second = swapConnection(base, MINT);
    for (const address of [MINT, CURVE, GLOBAL, FEES]) await second.getAccountInfo(address);
    expect(reads).toEqual([CURVE]);
  });

  it("reads the fixed accounts again after ten minutes, and after a failed swap", async () => {
    forgetFixedAccounts();
    const { base, reads } = counting();
    let now = 0;
    await swapConnection(base, MINT, () => now).getAccountInfo(GLOBAL);
    now = 9 * 60_000;
    await swapConnection(base, MINT, () => now).getAccountInfo(GLOBAL);
    expect(reads).toEqual([GLOBAL]);
    now = 11 * 60_000;
    await swapConnection(base, MINT, () => now).getAccountInfo(GLOBAL);
    expect(reads).toEqual([GLOBAL, GLOBAL]);
    forgetFixedAccounts();
    await swapConnection(base, MINT, () => now).getAccountInfo(GLOBAL);
    expect(reads).toHaveLength(3);
  });

  it("a mint the safety check already read is not read again by the swap", async () => {
    forgetFixedAccounts();
    const { base, reads } = counting();
    rememberMintAccount(MINT, { data: Buffer.from([9]), owner: "TokenProgram" });
    const got = await swapConnection(base, MINT).getAccountInfo(MINT);
    expect(got?.owner).toBe("TokenProgram");
    expect(reads).toEqual([]);
  });

  it("the background warm reads the four fixed accounts, so a swap reads none of them", async () => {
    forgetFixedAccounts();
    const { base, reads } = counting();
    expect(protocolWarmDue(1_000_000)).toBe(true);
    expect(await warmProtocolAccounts(base, () => 1_000_000)).toBe(4);
    expect(reads).toHaveLength(4);
    expect(protocolWarmDue(1_000_000 + PROTOCOL_WARM_MS - 1)).toBe(false);
    expect(protocolWarmDue(1_000_000 + PROTOCOL_WARM_MS)).toBe(true);
    reads.length = 0;
    const conn = swapConnection(base, MINT, () => 1_000_000);
    await conn.getAccountInfo(GLOBAL);
    await conn.getAccountInfo(FEES);
    expect(reads).toEqual([]);
  });

  it("never keeps a missing account", async () => {
    forgetFixedAccounts();
    let calls = 0;
    const base: PumpConnection = { getAccountInfo: async () => (calls += 1, null), getLatestBlockhash: async () => "h", simulateTransaction: async () => ({ err: null, units: 1, logs: [] }) };
    await swapConnection(base, MINT).getAccountInfo(GLOBAL);
    await swapConnection(base, MINT).getAccountInfo(GLOBAL);
    expect(calls).toBe(2);
  });
});

describe("v13.53 a live sell goes first on the Helius swap lane", () => {
  function limiter() {
    const sent: number[] = [];
    const net = new NetLimiter({
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent.push(Number(JSON.parse(String(init?.body)).id));
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });
    const buy = (id: number) => void net.fetch(HELIUS, { method: "POST", body: rpc(id, "getAccountInfo"), ndPriority: 1 }).catch(() => null);
    const sell = (id: number, method = "getAccountInfo") => net.fetch(HELIUS, { method: "POST", body: rpc(id, method), ndPriority: -1 });
    const lane = () => net.stats().find((row) => row.id === "helius:exec")!;
    return { net, sent, buy, sell, lane };
  }

  it("sends a sell's three calls at once with the token bucket empty and buys queued", async () => {
    const { sent, buy, sell, lane } = limiter();
    for (let i = 1; i <= 6; i += 1) buy(i);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([1, 2]); // burst 2, four buy calls still waiting
    const started = Date.now();
    await sell(101);
    await sell(102, "getLatestBlockhash");
    await sell(103, "simulateTransaction");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sent.slice(-3)).toEqual([101, 102, 103]);
    expect(lane().queued).toBe(4);
  });

  it("buys stop short of the 8 a minute ceiling by the exit reserve; sells may use all of it", () => {
    let now = 0;
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: ((fn: () => void, ms: number) => {
          if (now + ms >= 59_000) return 0;
          now += ms;
          fn();
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch
    });
    const ceiling = BUCKETS.find((b) => b.id === "helius:exec")!.budgetPerMin;
    for (let i = 1; i <= 20; i += 1) void net.fetch(HELIUS, { method: "POST", body: rpc(i, "getAccountInfo"), ndPriority: 1 }).catch(() => null);
    const lane = () => net.stats().find((row) => row.id === "helius:exec")!;
    expect(lane().reqLastMin).toBe(ceiling - HELIUS_EXIT_RESERVE);
    for (let i = 101; i <= 110; i += 1) void net.fetch(HELIUS, { method: "POST", body: rpc(i, "getAccountInfo"), ndPriority: -1 }).catch(() => null);
    expect(lane().reqLastMin).toBe(ceiling);
  });
});

describe("v13.53 swap sends stay on the swap lane", () => {
  it("routes a sell's token-account read to the swap lane, not the read lane", () => {
    const helius = BUCKETS.find((b) => b.id === "helius")!;
    const body = rpc(1, "getTokenAccountsByOwner");
    expect(rpcLane(helius, -1, body)?.id).toBe("helius"); // a wallet poll
    expect(rpcLane(helius, -1, body, false, true)?.id).toBe("helius:exec"); // a sell
    expect(rpcLane(helius, 1, rpc(2, "getAccountInfo"), false, true)?.id).toBe("helius:exec");
  });

  it("fetchAt with swapLane sends on the swap lane", async () => {
    const net = new NetLimiter({ fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    await net.fetchAt(-1, { swapLane: true })(HELIUS, { method: "POST", body: rpc(1, "getTokenAccountsByOwner") });
    expect(net.stats().find((row) => row.id === "helius:exec")?.reqLastMin).toBe(1);
    expect(net.stats().find((row) => row.id === "helius")?.reqLastMin ?? 0).toBe(0);
  });
});

describe("v13.53 a real curve sell", () => {
  it("reads four accounts the first time and only the curve and the unset fee account after that", async () => {
    const { readFileSync } = await import("node:fs");
    const { Keypair, PublicKey } = await import("@solana/web3.js");
    const { MintLayout, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    const { bondingCurvePda } = await import("../src/pump/sdk.js");
    const { PUMP_PROGRAM } = await import("../src/pump/constants.js");
    const { executePumpLiveSwap } = await import("../src/market/pump-live.js");
    forgetFixedAccounts();
    const fixture = (name: string) => Buffer.from(JSON.parse(readFileSync(`test/fixtures/pump/${name}`, "utf8")).base64, "base64");
    const mint = Keypair.generate().publicKey;
    const signer = Keypair.generate();
    const mintData = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000_000_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
    const accounts = new Map<string, { data: Buffer; owner: string }>([
      [mint.toBase58(), { data: mintData, owner: TOKEN_PROGRAM_ID.toBase58() }],
      [bondingCurvePda(mint).toBase58(), { data: fixture("curve.json"), owner: PUMP_PROGRAM.toBase58() }],
      [GLOBAL_PDA.toBase58(), { data: fixture("global.json"), owner: PUMP_PROGRAM.toBase58() }]
    ]);
    const reads: string[] = [];
    const connection: PumpConnection = {
      async getAccountInfo(address: string) {
        reads.push(address);
        return accounts.get(address) ?? null;
      },
      getLatestBlockhash: async () => PublicKey.default.toBase58(),
      simulateTransaction: async () => ({ err: null, units: 20, logs: [] })
    };
    const sell = () =>
      executePumpLiveSwap({
        side: "sell",
        mint: mint.toBase58(),
        qty: 1_000_000,
        decimals: 6,
        solPriceUsd: 150,
        markPriceUsd: 0.00000419851,
        slippageFraction: 0.06,
        readEnvSecret: () => JSON.stringify(Array.from(signer.secretKey)),
        rpcUrl: "http://127.0.0.1",
        connection,
        broadcast: async () => ({ signature: "sig", err: null })
      });
    let simErr: string | null = "slippage";
    connection.simulateTransaction = async () => ({ err: simErr, units: 20, logs: [] });
    await expect(sell()).rejects.toThrow(/simulation/);
    expect(reads).toHaveLength(4);
    reads.length = 0;
    simErr = null;
    // The retry after a failed simulation is as short as any other sell: nothing was dropped.
    await sell();
    expect(reads).toHaveLength(2);
    reads.length = 0;
    forgetFixedAccounts();
    await sell();
    const curve = bondingCurvePda(mint).toBase58();
    // Mint, curve, Global, fee config. No token-account read on a sell, and Global once, not twice.
    expect(reads).toHaveLength(4);
    expect(reads.filter((address) => address === GLOBAL_PDA.toBase58())).toHaveLength(1);
    reads.length = 0;
    await sell();
    // The fee config is absent in this fixture, so it is asked for again. On chain it exists and is kept.
    expect(reads.sort()).toEqual([curve, CURVE_FEE_CONFIG.toBase58()].sort());
  });
});
