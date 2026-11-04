import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  GLOBAL_PDA,
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  computeFeesBps,
  getBuyTokenAmountFromSolAmount,
  poolMarketCap,
  pumpIdl,
  type BondingCurve,
  type Global
} from "../../src/pump/sdk.js";
import { EventBus } from "../../src/bus.js";
import { Scout } from "../../src/agents/scout.js";
import type { DeskEvents } from "../../src/types.js";
import { ChainStream } from "../../src/market/chain-stream.js";
import {
  CURVE_FEE_CONFIG,
  PUMP_FEE_PROGRAM,
  PUMP_PROGRAM,
  PUMP_SWAP_PROGRAM,
  SPL_TOKEN_2022_PROGRAM,
  SPL_TOKEN_PROGRAM,
  SWAP_FEE_CONFIG
} from "../../src/pump/constants.js";
import {
  CANONICAL_SOL_CURVE,
  buyTokens,
  curveState,
  graduationMarketCapLamports,
  marketCapLamports,
  quoteCurve,
  solRemaining,
  solToReachMarketCap,
  tokensForCurveSol,
  type FeeBps
} from "../../src/pump/curve.js";
import { decodePumpPortalFrame, decodeTradeEventLog } from "../../src/pump/events.js";
import { PumpFeed } from "../../src/pump/feed.js";
import { readCurveFees } from "../../src/pump/fees.js";
import { PumpCore } from "../../src/pump/index.js";
import { buildIntent, serializeUnsigned } from "../../src/pump/intents.js";
import { decodePoolAccount, poolStateFromParts } from "../../src/pump/pumpswap.js";
import type { PumpConnection } from "../../src/pump/rpc.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAMPORT = 1_000_000_000n;
const TRADE_LOCAL_PROGRAM = "FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe";

function fixture(name: string): { base64: string } & Record<string, string> {
  return JSON.parse(readFileSync(path.join(root, "test/fixtures/pump", name), "utf8"));
}

function account(data: Buffer, owner: PublicKey): { data: Buffer; executable: false; lamports: number; owner: PublicKey } {
  return { data, executable: false, lamports: 0, owner };
}

function feeDisc(): Buffer {
  const idl = pumpIdl as { accounts: Array<{ name: string; discriminator: number[] }> };
  return Buffer.from(idl.accounts.find((item) => item.name === "FeeConfig")!.discriminator);
}

/** One SOL-curve tier below `thresholdLamports`, then a second tier. Layout matches the SDK's versioned reader. */
function feeConfigBytes(first: { protocol: bigint; creator: bigint }, second: { protocol: bigint; creator: bigint }, thresholdLamports: bigint): Buffer {
  const data = Buffer.alloc(2512);
  feeDisc().copy(data, 0);
  data[8] = 1;
  data.writeUInt32LE(2, 65);
  const writeTier = (offset: number, threshold: bigint, protocol: bigint, creator: bigint) => {
    data.writeBigUInt64LE(threshold, offset);
    data.writeBigUInt64LE(0n, offset + 16);
    data.writeBigUInt64LE(protocol, offset + 24);
    data.writeBigUInt64LE(creator, offset + 32);
  };
  writeTier(69, thresholdLamports, first.protocol, first.creator);
  writeTier(109, thresholdLamports, second.protocol, second.creator);
  return data;
}

function canonicalCurve(): BondingCurve {
  const raw = Buffer.from(fixture("curve.json").base64, "base64");
  return PUMP_SDK.decodeBondingCurve(account(raw, PUMP_PROGRAM));
}

function globalAccount(): Global {
  const raw = Buffer.from(fixture("global.json").base64, "base64");
  return PUMP_SDK.decodeGlobal(account(raw, PUMP_PROGRAM));
}

describe("pump curve", () => {
  it("matches the canonical start mcap, SOL to graduate, and graduation mcap", () => {
    const curve = canonicalCurve();
    const sdkMcap = bondingCurveMarketCap({
      mintSupply: curve.tokenTotalSupply,
      virtualQuoteReserves: curve.virtualQuoteReserves,
      virtualTokenReserves: curve.virtualTokenReserves
    });
    const mcap = marketCapLamports(CANONICAL_SOL_CURVE);
    expect(mcap).toBe(BigInt(sdkMcap.toString(10)));
    expect(Number(mcap) / 1e9).toBeCloseTo(27.96, 2);

    const remaining = solRemaining(CANONICAL_SOL_CURVE);
    expect(remaining).toBe(85_005_359_057n);
    expect(Number(remaining) / 1e9).toBeCloseTo(85.005, 3);

    const grad = graduationMarketCapLamports(CANONICAL_SOL_CURVE);
    const endToken = CANONICAL_SOL_CURVE.virtualTokenReserves - CANONICAL_SOL_CURVE.realTokenReserves;
    const endQuote = (CANONICAL_SOL_CURVE.virtualTokenReserves * CANONICAL_SOL_CURVE.virtualQuoteReserves) / endToken;
    const sdkGrad = bondingCurveMarketCap({
      mintSupply: curve.tokenTotalSupply,
      virtualQuoteReserves: new BN(endQuote.toString(10)),
      virtualTokenReserves: new BN(endToken.toString(10))
    });
    expect(grad).toBe(BigInt(sdkGrad.toString(10)));
    expect(Number(grad) / 1e9).toBeCloseTo(410.9, 1);
    expect(curveState("canonical", CANONICAL_SOL_CURVE).progressPct).toBe(0);
  });

  it("reverse-quotes a target mcap within 0.1%", () => {
    const target = marketCapLamports(CANONICAL_SOL_CURVE) * 2n;
    const quote = solToReachMarketCap(CANONICAL_SOL_CURVE, target);
    expect(quote.reachable).toBe(true);
    const solIn = BigInt(quote.solNeededLamports);
    const tokens = tokensForCurveSol(CANONICAL_SOL_CURVE, solIn);
    const nextToken = CANONICAL_SOL_CURVE.virtualTokenReserves - tokens;
    const nextQuote = CANONICAL_SOL_CURVE.virtualQuoteReserves + solIn;
    const achieved = (nextQuote * CANONICAL_SOL_CURVE.tokenTotalSupply) / nextToken;
    expect(achieved >= target).toBe(true);
    const gap = Number(achieved - target) / Number(target);
    expect(gap).toBeLessThan(0.001);
    const oneLess = tokensForCurveSol(CANONICAL_SOL_CURVE, solIn - 1n);
    const under = ((CANONICAL_SOL_CURVE.virtualQuoteReserves + solIn - 1n) * CANONICAL_SOL_CURVE.tokenTotalSupply) / (CANONICAL_SOL_CURVE.virtualTokenReserves - oneLess);
    expect(under < target).toBe(true);
  });

  it("applies fee bps from a decoded fee config, not a baked-in rate", async () => {
    const bytes = feeConfigBytes({ protocol: 95n, creator: 30n }, { protocol: 20n, creator: 5n }, 420n * LAMPORT);
    const decoded = PUMP_SDK.decodeFeeConfig(account(bytes, PUMP_FEE_PROGRAM));
    const curve = canonicalCurve();
    const creator = Keypair.generate().publicKey;
    curve.creator = creator;
    const global = globalAccount();
    global.creatorFeeConfigurable = false;
    const rates = computeFeesBps({
      global,
      feeConfig: decoded,
      mintSupply: curve.tokenTotalSupply,
      virtualQuoteReserves: curve.virtualQuoteReserves,
      virtualTokenReserves: curve.virtualTokenReserves,
      quoteMint: PublicKey.default,
      creatorFeeBps: new BN(0)
    });
    expect(rates.protocolFeeBps.toString(10)).toBe("95");
    expect(rates.creatorFeeBps.toString(10)).toBe("30");

    const fees: FeeBps = { protocolFeeBps: 95n, creatorFeeBps: 30n };
    const reserves = { ...CANONICAL_SOL_CURVE, creator: creator.toBase58() };
    const budget = 1_000_000n;
    const ours = buyTokens(reserves, budget, fees);
    const sdkTokens = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig: decoded,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: new BN(budget.toString(10)),
      quoteMint: PublicKey.default
    });
    expect(ours.tokens).toBe(BigInt(sdkTokens.toString(10)));
    expect(ours.feeBps).toBe(125n);
    const quoted = quoteCurve(reserves, "buy", budget, fees);
    expect(quoted.feeSource).toBe("chain");
    expect(quoted.feeBps).toBe(125);

    const coreFees = await readCurveFees(
      {
        async getAccountInfo(address: string) {
          if (address === CURVE_FEE_CONFIG.toBase58()) return { data: bytes, owner: PUMP_FEE_PROGRAM.toBase58() };
          if (address === GLOBAL_PDA.toBase58()) return { data: Buffer.from(fixture("global.json").base64, "base64"), owner: PUMP_PROGRAM.toBase58() };
          return null;
        },
        async getLatestBlockhash() {
          return PublicKey.default.toBase58();
        },
        async simulateTransaction() {
          return { err: null, units: 0, logs: [] };
        }
      },
      curve
    );
    expect(coreFees).toEqual({ protocolFeeBps: 95n, creatorFeeBps: 30n });
  });
});

describe("pump program ids and pool price", () => {
  it("uses the verified program ids and fee-config PDAs from the SDKs", () => {
    expect(PUMP_PROGRAM.toBase58()).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    expect(PUMP_SWAP_PROGRAM.toBase58()).toBe("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
    expect(PUMP_FEE_PROGRAM.toBase58()).toBe("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
    expect(CURVE_FEE_CONFIG.toBase58()).toBe("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
    expect(SWAP_FEE_CONFIG.toBase58()).toBe("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
    expect(SPL_TOKEN_PROGRAM.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(SPL_TOKEN_2022_PROGRAM.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it("prices a pool with quote vault + signed virtual reserves", () => {
    const raw = Buffer.from(fixture("pool.json").base64, "base64");
    const pool = decodePoolAccount(raw);
    const i128 = raw.subarray(245, 261);
    let hand = 0n;
    for (let i = 15; i >= 0; i -= 1) hand = (hand << 8n) + BigInt(i128[i] ?? 0);
    if (hand >= 1n << 127n) hand -= 1n << 128n;
    expect(pool.virtualQuoteReserves.toString(10)).toBe("-1500000");
    expect(hand).toBe(-1_500_000n);
    const base = 500_000_000_000_000n;
    const vault = 10_000_000n;
    const state = poolStateFromParts({
      address: PublicKey.default.toBase58(),
      pool,
      baseReserve: base,
      quoteReserve: vault,
      baseSupply: 1_000_000_000_000_000n
    });
    expect(state.effectiveQuoteReserve).toBe("8500000");
    expect(state.virtualQuoteReserves).toBe("-1500000");
    expect(state.isCashbackCoin).toBe(true);
    const priced = poolMarketCap({
      baseMintSupply: new BN("1000000000000000"),
      baseReserve: new BN(base.toString()),
      quoteReserve: new BN("8500000"),
      isMayhemMode: false
    });
    const vaultOnly = poolMarketCap({
      baseMintSupply: new BN("1000000000000000"),
      baseReserve: new BN(base.toString()),
      quoteReserve: new BN(vault.toString()),
      isMayhemMode: false
    });
    expect(state.marketCapLamports).toBe(priced.toString(10));
    expect(state.marketCapLamports).not.toBe(vaultOnly.toString(10));
  });
});

function mintData(supply: bigint): Buffer {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default
    },
    data
  );
  return data;
}

function world(mint: PublicKey, tokenProgram: PublicKey): PumpConnection {
  const curve = Buffer.from(fixture("curve.json").base64, "base64");
  const global = Buffer.from(fixture("global.json").base64, "base64");
  const map = new Map<string, { data: Buffer; owner: string }>([
    [mint.toBase58(), { data: mintData(1_000_000_000_000_000n), owner: tokenProgram.toBase58() }],
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
      return { err: null, units: 12, logs: ["simulated"] };
    }
  };
}

describe("pump intents", () => {
  it("prepares an unsigned simulate-only buy for both token programs, with no pump-suffix filter", async () => {
    const wallet = Keypair.generate().publicKey;
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      let mint = Keypair.generate().publicKey;
      while (mint.toBase58().toLowerCase().endsWith("pump")) mint = Keypair.generate().publicKey;
      const built = await buildIntent(world(mint, program), {
        wallet: wallet.toBase58(),
        mint: mint.toBase58(),
        side: "buy",
        solLamports: 5_000_000n
      });
      const unsigned = serializeUnsigned(wallet.toBase58(), PublicKey.default.toBase58(), built.instructions);
      expect(unsigned.tx.feePayer?.toBase58()).toBe(wallet.toBase58());
      expect(unsigned.tx.signatures.every((entry) => entry.signature == null)).toBe(true);
      const programs = built.instructions.map((ix) => ix.programId.toBase58());
      expect(programs).toContain(PUMP_PROGRAM.toBase58());
      expect(programs).not.toContain(TRADE_LOCAL_PROGRAM);
      expect(programs).not.toContain(PUMP_SWAP_PROGRAM.toBase58());
      expect(built.instructions.some((ix) => ix.keys.some((key) => key.pubkey.equals(program)))).toBe(true);
    }
  });

  it("stays simulate-only until armed, enforces caps, and a new core is disarmed", async () => {
    const db = new DatabaseSync(":memory:");
    const mint = Keypair.generate().publicKey;
    const wallet = Keypair.generate().publicKey;
    const connection = world(mint, TOKEN_PROGRAM_ID);
    let now = 1_700_000_000_000;
    const core = new PumpCore({ db, rpcUrl: "http://127.0.0.1", connection, now: () => now });
    const prepare = (sol: string, live = false) =>
      core.handle("POST", new URL("http://desk/api/pump/prepare"), {
        wallet: wallet.toBase58(),
        mint: mint.toBase58(),
        side: "buy",
        solLamports: sol,
        live
      });

    const over = await prepare(String(6_000_000));
    expect(over.status).toBe(409);
    expect((over.body as { code: string }).code).toBe("CAP_TRADE");

    const first = await prepare(String(5_000_000), true);
    expect(first.status).toBe(200);
    const intent = (first.body as { intent: { simulateOnly: boolean; unsignedTx: string; feePayer: string; mode: string } }).intent;
    expect(intent.simulateOnly).toBe(true);
    expect(intent.mode).toBe("simulate");
    expect(intent.feePayer).toBe(wallet.toBase58());
    const tx = Transaction.from(Buffer.from(intent.unsignedTx, "base64"));
    expect(tx.signatures.every((entry) => entry.signature == null)).toBe(true);
    expect(tx.instructions.some((ix) => ix.programId.equals(PUMP_PROGRAM))).toBe(true);
    expect(tx.instructions.some((ix) => ix.programId.toBase58() === TRADE_LOCAL_PROGRAM)).toBe(false);

    for (let i = 0; i < 4; i += 1) {
      const next = await prepare(String(5_000_000));
      expect(next.status).toBe(200);
    }
    const day = await prepare(String(5_000_000));
    expect(day.status).toBe(409);
    expect((day.body as { code: string }).code).toBe("CAP_DAY");

    const armed = await core.handle("POST", new URL("http://desk/api/pump/arm"), { confirm: true, wallet: wallet.toBase58() });
    expect(armed.status).toBe(200);
    const live = await prepare(String(1_000_000), true);
    expect(live.status).toBe(409);
    expect((live.body as { code: string }).code).toBe("CAP_DAY");

    const restarted = new PumpCore({ db, rpcUrl: "http://127.0.0.1", connection, now: () => now });
    const status = await restarted.handle("GET", new URL("http://desk/api/pump/status"), null);
    const body = status.body as { armed: boolean; caps: { dayUsedLamports: string } };
    expect(body.armed).toBe(false);
    expect(BigInt(body.caps.dayUsedLamports) > 0n).toBe(true);
    now += 24 * 60 * 60 * 1000 + 1;
    const again = await restarted.handle("POST", new URL("http://desk/api/pump/prepare"), {
      wallet: wallet.toBase58(),
      mint: mint.toBase58(),
      side: "buy",
      solLamports: "1000000",
      live: true
    });
    expect(again.status).toBe(200);
    expect((again.body as { intent: { simulateOnly: boolean } }).intent.simulateOnly).toBe(true);
  });
});

describe("pump feed", () => {
  it("reads PumpPortal frames from scout's socket and opens none of its own", async () => {
    const frames: string[] = [];
    const feed = new PumpFeed({
      onTrade: (event) => frames.push(event.mint),
      onCoin: () => {},
      onCurve: () => {}
    });
    expect(feed.socketsOpened).toBe(0);
    const portal = JSON.parse(readFileSync(path.join(root, "test/fixtures/pump/portal-buy.json"), "utf8"));
    const mint = Keypair.generate().publicKey.toBase58();
    portal.mint = mint;
    const decoded = decodePumpPortalFrame(JSON.stringify(portal), 1_700_000_000_000);
    expect(decoded?.kind).toBe("trade");
    if (decoded?.kind === "trade") {
      expect(decoded.event.solAmountLamports).toBe(String(20_000_000));
      expect(decoded.event.tokenAmount).toBe(String(1_500_000));
      expect(decoded.event.source).toBe("pumpportal");
    }

    let opened = 0;
    const handlers = new Map<string, (value?: unknown) => void>();
    const scout = new Scout({
      bus: new EventBus<DeskEvents>(),
      feedMode: "live",
      demo: false,
      pumpWsUrl: "ws://pump.example/socket",
      fetchImpl: async () => new Response("[]", { status: 200 }),
      onStatus: () => {},
      pumpSocketFactory: () => {
        opened += 1;
        return {
          on(event: string, fn: (...args: unknown[]) => void) {
            handlers.set(event, fn as (value?: unknown) => void);
            if (event === "open") fn();
          },
          send() {},
          close() {}
        } as import("../../src/agents/scout.js").PumpSocket;
      }
    });
    scout.setPumpFrameHook((text) => feed.onPumpFrame(text));
    scout.start();
    handlers.get("message")?.({ toString: () => JSON.stringify(portal) });
    expect(opened).toBe(1);
    expect(frames).toEqual([mint]);
    expect(feed.socketsOpened).toBe(0);
    scout.stop();
  });

  it("keeps pump watches when the pricer replaces its keys", () => {
    const sent: Array<{ method?: string; params?: unknown[] }> = [];
    const socket = { open: null as (() => void) | null };
    const stream = new ChainStream(
      "ws://rpc.example",
      () => {},
      {
        maxSubs: 60,
        connect: () =>
          ({
            readyState: 1,
            on(event: string, fn: () => void) {
              if (event === "open") socket.open = fn;
            },
            send(data: string) {
              sent.push(JSON.parse(data));
            },
            close() {}
          }) as unknown as import("ws").WebSocket
      }
    );
    const base = Keypair.generate().publicKey.toBase58();
    const extra = Keypair.generate().publicKey.toBase58();
    const replaced = Keypair.generate().publicKey.toBase58();
    stream.setKeys([base]);
    socket.open?.();
    const ack = () => {
      for (const msg of sent) {
        if (msg.method === "accountSubscribe" && typeof (msg as { id?: number }).id === "number") {
          stream.onMessage(JSON.stringify({ jsonrpc: "2.0", id: (msg as { id: number }).id, result: (msg as { id: number }).id }));
        }
      }
    };
    ack();
    stream.setExtraKeys([extra]);
    ack();
    const extraSub = sent.find((msg) => msg.method === "accountSubscribe" && msg.params?.[0] === extra) as { id: number };
    stream.setKeys([replaced]);
    const dropped = sent.filter((msg) => msg.method === "accountUnsubscribe").map((msg) => msg.params?.[0]);
    expect(dropped).not.toContain(extraSub.id);
    expect(stream.stats().wanted).toBe(2);
    stream.stop();
  });
});

describe("pump boundaries", () => {
  it("does not import the server signer or the PumpPortal local-transaction program", () => {
    const dir = path.join(root, "src/pump");
    const files = walk(dir).filter((file) => file.endsWith(".ts"));
    const banned = ["wallet-key", "executeLiveSwap", "trade-local", "tradeLocal", TRADE_LOCAL_PROGRAM, "endsWith(\"pump\")", "endsWith('pump')"];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const token of banned) expect(text, file).not.toContain(token);
    }
  });

  it("ignores a trade-event log that is not a pump trade", () => {
    expect(decodeTradeEventLog(Buffer.from("not-a-trade"))).toBeNull();
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
