import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { DeskStore } from "../src/store/db.js";
import { ChainMarkReader, PUMPSWAP_PROGRAM, RAYDIUM_AMM_V4, WSOL_MINT, pumpSwapNative, tokenAmount } from "../src/market/chain-marks.js";
import { PositionPricer } from "../src/market/position-pricer.js";
import { NetLimiter, bucketFor } from "../src/market/net.js";
import { PumpFeed } from "../src/pump/feed.js";
import { testConfig, testDesk } from "./helpers.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/pepetide-pumpswap.json", import.meta.url), "utf8")) as {
  mint: string;
  pair: string;
  solVault: string;
  tokenVault: string;
  pool: string;
  mintAccount: string;
  solVaultAccount: string;
  tokenVaultAccount: string;
  poolOwner: string;
  mintOwner: string;
  solOwner: string;
  tokenOwner: string;
};

const ENTRY = 1.34e-5;
const BAD = 0.5319;

function accounts(): Record<string, { owner: string; data: string }> {
  return {
    [FIXTURE.pair]: { owner: FIXTURE.poolOwner, data: FIXTURE.pool },
    [FIXTURE.mint]: { owner: FIXTURE.mintOwner, data: FIXTURE.mintAccount },
    [FIXTURE.solVault]: { owner: FIXTURE.solOwner, data: FIXTURE.solVaultAccount },
    [FIXTURE.tokenVault]: { owner: FIXTURE.tokenOwner, data: FIXTURE.tokenVaultAccount }
  };
}

describe("v13.21 Pepetide chain marks and Helius budget", () => {
  it("does not price the emptied Pepetide PumpSwap pool, whose vault ratio is not the Dex print", () => {
    const rows = accounts();
    const tokenRaw = tokenAmount(Buffer.from(rows[FIXTURE.tokenVault]!.data, "base64"));
    const solRaw = tokenAmount(Buffer.from(rows[FIXTURE.solVault]!.data, "base64"));
    expect(tokenRaw).toBe(14);
    expect(solRaw).toBe(30003);
    const ratio = solRaw / 1e9 / (tokenRaw / 1e6);
    expect(ratio).toBeGreaterThan(1);
    expect(ratio * 150).not.toBeCloseTo(BAD, 1);
    expect(Number.isNaN(pumpSwapNative(tokenRaw, solRaw, 6, 0n, false))).toBe(true);
    expect(rows[FIXTURE.pair]!.owner).toBe(PUMPSWAP_PROGRAM);
  });

  it("replays the Pepetide account bytes and does not emit a chain mark from them", async () => {
    const rows = accounts();
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; params: [string[]] };
      const value = body.params[0].map((key) => {
        const row = rows[key];
        return row ? { owner: row.owner, data: [row.data, "base64"] } : null;
      });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value } });
    }) as typeof fetch;
    const reader = new ChainMarkReader("http://rpc", fetchImpl, 0);
    const reads = await reader.read([{ mint: FIXTURE.mint, pair: FIXTURE.pair }], 1_000);
    expect(reads.get(FIXTURE.mint)).toBeUndefined();
    const subs = reader.subscriptions([FIXTURE.pair]);
    expect([...subs.keys()].sort()).toEqual([FIXTURE.solVault, FIXTURE.tokenVault].sort());
    reader.noteAccount(FIXTURE.tokenVault, Buffer.from(rows[FIXTURE.tokenVault]!.data, "base64"), 1_000);
    reader.noteAccount(FIXTURE.solVault, Buffer.from(rows[FIXTURE.solVault]!.data, "base64"), 1_100);
    expect(reader.decodeCached(FIXTURE.pair)).toBeNull();

    const lives: number[] = [];
    const pricer = new PositionPricer({
      heldMints: () => [FIXTURE.mint],
      pairFor: () => FIXTURE.pair,
      tick: () => {},
      live: (_mint, price) => lives.push(price),
      onStale: () => {},
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (String(url).includes("dexscreener")) {
          return Response.json([
            {
              baseToken: { address: FIXTURE.mint },
              priceUsd: String(BAD),
              liquidity: { usd: 25.68 },
              pairAddress: FIXTURE.pair,
              dexId: "pumpswap"
            }
          ]);
        }
        return fetchImpl(url, init);
      }) as typeof fetch,
      now: () => 5_000,
      chain: reader
    });
    await pricer.poll();
    expect(lives).toEqual([]);
  });

  it("drops a saved 0.5319 mark on boot and still stops a real crash", async () => {
    let dex = ENTRY;
    let jup = ENTRY;
    const priceFetch = (async (url: string) => {
      if (String(url).includes("dexscreener")) {
        return Response.json([
          {
            baseToken: { address: "PepeMint111111111111111111111111111111111" },
            priceUsd: String(dex),
            liquidity: { usd: 180_000 },
            pairAddress: FIXTURE.pair,
            dexId: "pumpswap"
          }
        ]);
      }
      return Response.json({ PepeMint111111111111111111111111111111111: { usdPrice: jup, liquidity: 180_000 } });
    }) as typeof fetch;
    const cfg = testConfig({ resetPaper: false });
    const desk = new Desk(cfg, { priceFetch });
    await desk.submitCandidate(
      makeToken({
        mint: "PepeMint111111111111111111111111111111111",
        symbol: "PEPETIDE",
        priceUsd: ENTRY,
        liquidityUsd: 180_000,
        source: "pumpfun",
        priceFeed: "dexscreener",
        pairAddress: FIXTURE.pair,
        dex: "pumpswap"
      })
    );
    const mint = "PepeMint111111111111111111111111111111111";
    const entry = desk.book.positions.get(mint)!.entryPrice;
    desk.stop();
    const store = new DeskStore(cfg.dbPath, cfg.jsonlPath, cfg.logPath);
    const saved = store.loadBook("book");
    expect(saved).toBeTruthy();
    saved!.lastPrices = [[mint, BAD]];
    saved!.markSeries = [[mint, [{ t: Date.now(), priceUsd: BAD }]]];
    const open = saved!.positions.find((p) => p.mint === mint)!;
    open.peakPrice = BAD;
    open.markPeak = BAD;
    open.entryMark = entry;
    store.saveBook(saved!, "book");
    store.close();

    const again = new Desk(cfg, { priceFetch });
    try {
      expect(again.book.positions.has(mint)).toBe(true);
      expect(again.book.price(mint)).toBeLessThan(entry * 2);
      const healed = again.book.positions.get(mint)!;
      expect(healed.peakPrice).toBeLessThan(entry * 2);
      expect(healed.markPeak ?? 0).toBeLessThan(entry * 2);
      expect(again.snapshot().equityUsd).toBeLessThan(20_000);
      const card = again.snapshot().positions.find((p) => p.mint === mint);
      expect(card?.markPrice ?? 0).toBeLessThan(entry * 2);
      expect(card?.peakPrice ?? 0).toBeLessThan(entry * 2);
      const before = again.snapshot().equityUsd;
      dex = BAD;
      jup = ENTRY;
      await again.repricePositions();
      expect(again.book.positions.has(mint)).toBe(true);
      expect(again.snapshot().equityUsd).toBeLessThan(before * 2);
      expect(again.snapshot().events.some((event) => event.code === "PRICE_OUTLIER")).toBe(true);

      dex = entry * 0.5;
      jup = entry * 0.5;
      await again.repricePositions();
      await again.repricePositions();
      expect(again.book.positions.has(mint)).toBe(false);
      expect(again.snapshot().events.some((event) => event.code === "STOP_LOSS" || event.code === "GAP_RUG")).toBe(true);
    } finally {
      again.stop();
    }
  });

  it("does not treat a Raydium quote as proof of the chain mark copied from it", async () => {
    const mintKey = Keypair.generate().publicKey;
    const pairKey = Keypair.generate().publicKey;
    const tokenVault = Keypair.generate().publicKey;
    const solVault = Keypair.generate().publicKey;
    const mint = mintKey.toBase58();
    const pair = pairKey.toBase58();
    const pool = Buffer.alloc(752);
    pool.set(tokenVault.toBytes(), 336);
    pool.set(solVault.toBytes(), 368);
    pool.set(mintKey.toBytes(), 400);
    pool.set(new PublicKey(WSOL_MINT).toBytes(), 432);
    const mintAcc = Buffer.alloc(82);
    mintAcc[44] = 6;
    const tokenAcc = (amount: bigint) => {
      const data = Buffer.alloc(165);
      data.writeBigUInt64LE(amount, 64);
      return data;
    };
    const rows: Record<string, { owner: string; data: string }> = {
      [pair]: { owner: RAYDIUM_AMM_V4, data: pool.toString("base64") },
      [mint]: { owner: RAYDIUM_AMM_V4, data: mintAcc.toString("base64") },
      [tokenVault.toBase58()]: { owner: RAYDIUM_AMM_V4, data: tokenAcc(1_000_000_000n).toString("base64") },
      [solVault.toBase58()]: { owner: RAYDIUM_AMM_V4, data: tokenAcc(1_000_000_000n).toString("base64") }
    };
    const chainFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; params: [string[]] };
      const value = body.params[0].map((key) => {
        const row = rows[key];
        return row ? { owner: row.owner, data: [row.data, "base64"] } : null;
      });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value } });
    }) as typeof fetch;
    const priceFetch = (async (url: string) => {
      if (String(url).includes("dexscreener")) {
        return Response.json([
          {
            baseToken: { address: mint },
            priceUsd: String(BAD),
            liquidity: { usd: 180_000 },
            pairAddress: pair,
            dexId: "raydium"
          }
        ]);
      }
      return Response.json({ [mint]: { usdPrice: BAD, liquidity: 180_000 } });
    }) as typeof fetch;
    const desk = new Desk(testConfig({}), { priceFetch, chainFetch });
    try {
      await desk.submitCandidate(
        makeToken({
          mint,
          symbol: "RAY",
          priceUsd: ENTRY,
          liquidityUsd: 180_000,
          source: "raydium",
          priceFeed: "dexscreener",
          pairAddress: pair,
          dex: "raydium"
        })
      );
      const entry = desk.book.positions.get(mint)!.entryPrice;
      await desk.repricePositions();
      await desk.repricePositions();
      const factor = (desk as unknown as { pricer: PositionPricer }).pricer.factor(mint, "raydium", Date.now());
      expect(factor).not.toBeNull();
      expect(desk.snapshot().markLoop?.chain.find((row) => row.mint === mint)?.kind).toBe("raydium");
      const card = desk.snapshot().positions.find((p) => p.mint === mint);
      expect(card?.markPrice ?? 0).toBeLessThan(entry * 2);
      expect(desk.snapshot().equityUsd).toBeLessThan(20_000);
      expect(desk.book.positions.has(mint)).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("caps Helius polls at 25/min with burst 8 and keeps swap calls on a separate lane", async () => {
    const read = bucketFor("https://mainnet.helius-rpc.com/?api-key=test");
    const exec = bucketFor("https://beta.helius-rpc.com/?api-key=test");
    expect(read?.id).toBe("helius");
    expect(exec?.id).toBe("helius");
    expect(read!.budgetPerMin).toBe(25);
    expect(read!.burst).toBeLessThanOrEqual(8);
    expect(read!.budgetPerMin + read!.burst).toBeLessThanOrEqual(read!.limitPerMin);
    expect(bucketFor("https://api.mainnet-beta.solana.com")?.budgetPerMin).toBe(9);
    const lane = bucketFor("https://helius-rpc.com/")!;
    expect(lane.id).toBe("helius");

    let calls = 0;
    let now = 0;
    const waits: number[] = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: ((fn: () => void, ms: number) => {
          waits.push(ms);
          now += ms;
          fn();
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async () => {
        calls += 1;
        return Response.json({ jsonrpc: "2.0", result: { value: 1 } });
      }) as typeof fetch
    });
    const url = "https://mainnet.helius-rpc.com/?api-key=test";
    for (let i = 0; i < 8; i += 1) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: i, method: "getBalance", params: [String(i)] });
      await net.fetchAt(0)(url, { method: "POST", body });
    }
    expect(calls).toBe(8);
    const sim = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "simulateTransaction", params: ["raw"] });
    await net.fetchAt(1)(url, { method: "POST", body: sim });
    expect(calls).toBe(9);
    expect(net.stats().find((row) => row.id === "helius")?.sent).toBe(8);
    expect(net.stats().find((row) => row.id === "helius:exec")?.sent).toBe(1);
    const ninth = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "getMultipleAccounts", params: [["a"]] });
    await net.fetchAt(0)(url, { method: "POST", body: ninth });
    expect(waits.length).toBeGreaterThan(0);
    expect(calls).toBe(10);
  });

  it("subscribes the stream to a held mint's pool accounts and not every scouted coin", () => {
    const seen: string[][] = [];
    const feed = new PumpFeed({
      stream: { setExtraKeys: (keys) => seen.push([...keys]) },
      onTrade: () => {},
      onCoin: () => {},
      onCurve: () => {}
    });
    const held = Keypair.generate().publicKey.toBase58();
    feed.watchMint(held);
    feed.setHeldMints([held]);
    const heldKeys = seen.at(-1);
    expect(heldKeys).toHaveLength(2);
    for (let i = 0; i < 30; i += 1) feed.watchMint(Keypair.generate().publicKey.toBase58());
    expect(seen.at(-1)).toEqual(heldKeys);
    feed.setHeldMints([]);
    expect(seen.at(-1)).toEqual([]);
    feed.watchMint(held);
    for (let i = 0; i < 30; i += 1) feed.watchMint(Keypair.generate().publicKey.toBase58());
    feed.setHeldMints([held]);
    expect(seen.at(-1)).toEqual(heldKeys);
  });
});
