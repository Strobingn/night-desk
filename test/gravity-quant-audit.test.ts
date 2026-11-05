import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, beforeEach } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { NextRequest } from "next/server";

import {
  INITIAL_REAL_TOKEN_RESERVES,
  LAMPORTS_PER_SOL,
  decodePumpCurveBinary,
  quoteBondingCurveBuy,
  evaluateGraduationSweep,
  GeyserBondingCurveTracker,
} from "../lib/indexer/geyser.js";
import {
  calculateOptimalJitoTip,
  calculateDynamicSlippageBps,
  executeAtomicProfitSwap,
  getFastBlockhash,
  resetBlockhashCache,
} from "../lib/sniper.js";
import {
  calculatePlatformFeeLamports,
  injectAtomicPlatformFee,
  sweepSubWalletsToTreasury,
} from "../lib/solana.js";
import {
  analyzeMemeCoinSafety,
  calculateNormalizedShannonEntropy,
  detectCommonFundingAncestor,
} from "../lib/risk/analyzer.js";
import {
  evaluateAlphaWallet,
  calculateClusterConvergenceSignal,
  calculateFractionalKellyAllocationSol,
  type HistoricalTrade,
} from "../lib/quant/copyScorer.js";
import { POST as mcpPost } from "../app/[transport]/route.js";
import {
  POST as webhookPost,
  resetProcessedWebhookSignatures,
} from "../app/api/webhooks/solana/route.js";
import { evaluateFilter } from "../src/agents/filter.js";
import { makeToken } from "../src/demo/tokens.js";
import { parseMintAccount, parseTop10Pct } from "../src/market/parsers.js";
import { resolveRules } from "../src/rules.js";
import { startServer } from "../src/server/http.js";
import { resetServerWebhookSignatures } from "../src/server/mcp-webhook.js";
import { testDesk } from "./helpers.js";

function buildPumpCurveBuffer(params: {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply?: bigint;
  complete?: boolean;
}): Uint8Array {
  const buf = new Uint8Array(49);
  const view = new DataView(buf.buffer);
  // 8-byte discriminator
  view.setBigUint64(0, 0x17b7f83760d8ac60n, true);
  view.setBigUint64(8, params.virtualTokenReserves, true);
  view.setBigUint64(16, params.virtualSolReserves, true);
  view.setBigUint64(24, params.realTokenReserves, true);
  view.setBigUint64(32, params.realSolReserves, true);
  view.setBigUint64(40, params.tokenTotalSupply ?? 1_000_000_000_000_000n, true);
  view.setUint8(48, params.complete ? 1 : 0);
  return buf;
}

function buildRawMintAccountBuffer(params: {
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
  supply: bigint;
  decimals?: number;
}): Buffer {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: params.mintAuthority ? 1 : 0,
      mintAuthority: params.mintAuthority ?? PublicKey.default,
      supply: params.supply,
      decimals: params.decimals ?? 6,
      isInitialized: true,
      freezeAuthorityOption: params.freezeAuthority ? 1 : 0,
      freezeAuthority: params.freezeAuthority ?? PublicKey.default,
    },
    data
  );
  return data;
}

describe("1. Zero-RPC Binary Bonding Curve Decoder & Graduation Predictor (lib/indexer/geyser.ts)", () => {
  it("decodes a 49-byte Pump.fun bonding curve buffer and computes exact reserves, spot price, and graduation delta", () => {
    const raw = buildPumpCurveBuffer({
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualSolReserves: 30_000_000_000n, // 30 SOL
      realTokenReserves: INITIAL_REAL_TOKEN_RESERVES / 2n, // 50% sold
      realSolReserves: 25_000_000_000n,
      complete: false,
    });

    const state = decodePumpCurveBinary(raw);
    expect(state.virtualSolReserves).toBe(30_000_000_000n);
    expect(state.completionPercentage).toBeCloseTo(50, 2);
    expect(state.completionRatioGamma).toBeCloseTo(0.5, 4);
    expect(state.spotPriceSol).toBeCloseTo(30 / 1_073_000_000, 12);
    expect(state.lamportsRemainingToGraduate).toBeGreaterThan(0n);
    expect(state.complete).toBe(false);
  });

  it("throws on buffers shorter than 49 bytes", () => {
    expect(() => decodePumpCurveBinary(new Uint8Array(48))).toThrow(/Invalid bonding curve buffer length/);
  });

  it("quotes constant-product buy output, price impact bps, and tight slippage cap", () => {
    const state = decodePumpCurveBinary(
      buildPumpCurveBuffer({
        virtualTokenReserves: 800_000_000_000_000n,
        virtualSolReserves: 40_000_000_000n, // 40 SOL
        realTokenReserves: 400_000_000_000_000n,
        realSolReserves: 10_000_000_000n,
      })
    );
    const quote = quoteBondingCurveBuy(state, 2_000_000_000n); // 2 SOL buy
    expect(quote.tokensOut).toBeGreaterThan(0n);
    // Impact = 1 - 40/42 = 2/42 = 4.7619% -> ceil(476.19) = 477 bps
    expect(quote.priceImpactBps).toBe(477);
    expect(quote.effectiveSlippageBps).toBe(477 + 75);
  });

  it("triggers an atomic Graduation Sweep when Gamma is in [0.965, 0.998] and SOL velocity > 1.8 SOL/s", () => {
    const tracker = new GeyserBondingCurveTracker();
    const mint = "GradMint1111111111111111111111111111111111";

    // Remaining 2% of curve -> Gamma = 0.98
    const remainingTokens = (INITIAL_REAL_TOKEN_RESERVES * 2n) / 100n;
    const buf1 = buildPumpCurveBuffer({
      virtualTokenReserves: 295_000_000_000_000n,
      virtualSolReserves: 108_000_000_000n,
      realTokenReserves: remainingTokens,
      realSolReserves: 78_000_000_000n,
    });
    const buf2 = buildPumpCurveBuffer({
      virtualTokenReserves: 290_000_000_000_000n,
      virtualSolReserves: 111_000_000_000n,
      realTokenReserves: remainingTokens,
      realSolReserves: 81_000_000_000n, // +3 SOL in 1 second = 3.0 SOL/s > 1.8 SOL/s
    });

    const first = tracker.onAccountUpdate(mint, buf1, 1_000);
    expect(first.graduationSignal.shouldSweep).toBe(false);

    const second = tracker.onAccountUpdate(mint, buf2, 2_000);
    expect(second.graduationSignal.shouldSweep).toBe(true);
    expect(second.graduationSignal.solVelocityPerSec).toBeCloseTo(3.0, 2);
    expect(second.graduationSignal.sweepSolLamports).toBe(second.state.lamportsRemainingToGraduate);
  });
});

describe("2. ALT-Compressed Atomic Fee Router & Dynamic EV Jito Sniper (lib/sniper.ts & lib/solana.ts)", () => {
  beforeEach(() => {
    resetBlockhashCache();
  });

  it("caches blockhashes in memory for 400ms to eliminate synchronous RPC latency", async () => {
    let rpcCalls = 0;
    const mockConn = {
      getLatestBlockhash: async () => {
        rpcCalls += 1;
        return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 };
      },
    } as unknown as Connection;

    const bh1 = await getFastBlockhash(mockConn);
    const bh2 = await getFastBlockhash(mockConn);
    expect(bh1).toBe(bh2);
    expect(rpcCalls).toBe(1);
  });

  it("bounds Jito validator tips by 22% of expected profit and scales logarithmically with contention", () => {
    // High expected profit: 0.1 SOL (100,000,000 lamports), P95 = 1,000,000, contention = 4
    const tip = calculateOptimalJitoTip({
      expectedProfitLamports: 100_000_000,
      rollingP95TipLamports: 1_000_000,
      competingBundlesCount: 4,
    });
    const expectedDynamic = Math.floor(1_000_000 * (1 + 0.35 * Math.log(5)));
    expect(tip).toBe(expectedDynamic);

    // Low expected profit: 1,000,000 lamports -> 22% cap is 220,000 lamports
    const capped = calculateOptimalJitoTip({
      expectedProfitLamports: 1_000_000,
      rollingP95TipLamports: 2_000_000,
      competingBundlesCount: 10,
    });
    expect(capped).toBe(220_000);
  });

  it("builds and signs an ALT-compressed V0 bundle with atomic fee + Jito tip and fans out across regional engines", async () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const blockhash = Keypair.generate().publicKey.toBase58();
    const mockConn = {
      getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 999 }),
    } as unknown as Connection;

    const swapIx = SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: recipient,
      lamports: 10_000_000,
    });

    const hitEndpoints: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      hitEndpoints.push(String(input));
      return Response.json({ jsonrpc: "2.0", result: "bundle-xyz-123", id: 1 });
    };

    const res = await executeAtomicProfitSwap({
      connection: mockConn,
      signer,
      swapInstructions: [swapIx],
      tradeAmountLamports: 100_000_000, // 0.1 SOL
      expectedProfitLamports: 20_000_000,
      competingBundlesCount: 3,
      platformFeeBps: 85,
      fetchImpl: mockFetch,
    });

    expect(res.success).toBe(true);
    expect(res.bundleId).toBe("bundle-xyz-123");
    expect(res.feeCollectedLamports).toBe(850_000); // 0.85% of 100,000,000
    expect(res.jitoTipLamports).toBeGreaterThanOrEqual(100_000);
    expect(hitEndpoints.length).toBe(3);
  });

  it("injects atomic platform fee instructions and sweeps sub-wallets in lib/solana.ts", async () => {
    const payer = Keypair.generate();
    const injected = injectAtomicPlatformFee({
      instructions: [],
      payer: payer.publicKey,
      tradeAmountLamports: Number(LAMPORTS_PER_SOL),
      platformFeeBps: 85,
    });
    expect(injected.feeLamports).toBe(calculatePlatformFeeLamports(Number(LAMPORTS_PER_SOL), 85));
    expect(injected.instructions).toHaveLength(1);

    const subWallet = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const mockConn = {
      getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
      getBalance: async () => 5_000_000,
      sendRawTransaction: async () => "sweep-sig-1",
    } as unknown as Connection;

    const sweep = await sweepSubWalletsToTreasury({
      connection: mockConn,
      subWallets: [subWallet],
    });
    expect(sweep.sweptWallets).toBe(1);
    expect(sweep.totalSweptLamports).toBeGreaterThan(4_000_000);
    expect(sweep.signatures).toEqual(["sweep-sig-1"]);
  });

  it("computes volatility-adjusted dynamic slippage bps", () => {
    const bps = calculateDynamicSlippageBps({
      priceImpactRatio: 0.012, // 120 bps
      slotVolatilityBps: 40,
      targetBlocks: 4, // sqrt(4) = 2 -> +80 bps
    });
    expect(bps).toBe(200);
  });
});

describe("3. Shannon Entropy & Sybil Rug Analyzer (lib/risk/analyzer.ts & src/agents/filter.ts)", () => {
  it("flags active mint/freeze authorities, Sybil uniform distributions (H > 0.985), and Block-0 bundles", async () => {
    const mintKey = Keypair.generate().publicKey;
    const rawMint = buildRawMintAccountBuffer({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 1_000_000_000_000n,
      decimals: 6,
    });

    // 20 Sybil wallets each holding identical 10,000,000,000 units (1% each = 20% top 20, 10% top 10)
    const sybilAccounts = Array.from({ length: 20 }, () => ({
      address: Keypair.generate().publicKey,
      amount: "10000000000",
      decimals: 6,
      uiAmount: 10_000,
      uiAmountString: "10000",
    }));

    const mockConn = {
      getAccountInfo: async () => ({
        data: rawMint,
        executable: false,
        lamports: 1_461_600,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      }),
      getTokenLargestAccounts: async () => ({
        context: { slot: 1 },
        value: sybilAccounts,
      }),
    } as unknown as Connection;

    const report = await analyzeMemeCoinSafety(
      mockConn,
      mintKey.toBase58(),
      undefined,
      250_000_000_000 // 25% sniped in Block 0 (> 22% threshold)
    );

    expect(report.shannonEntropyNormalized).toBeCloseTo(1.0, 3);
    expect(report.blockZeroBundleRatio).toBeCloseTo(0.25, 3);
    expect(report.safe).toBe(false);
    expect(report.reasons.some((r) => /SYBIL BUNDLE DETECTED/.test(r))).toBe(true);
    expect(report.reasons.some((r) => /DEV BUNDLE/.test(r))).toBe(true);
  });

  it("detects 1-hop common funding ancestor across top holders", () => {
    const now = Date.now();
    const res = detectCommonFundingAncestor(
      [
        { holderAddress: "H1", funderAddress: "FunderA", timestampMs: now - 60_000 },
        { holderAddress: "H2", funderAddress: "FunderA", timestampMs: now - 120_000 },
        { holderAddress: "H3", funderAddress: "FunderA", timestampMs: now - 180_000 },
      ],
      now
    );
    expect(res.sybilClusterDetected).toBe(true);
    expect(res.dominantFunder).toBe("FunderA");
    expect(res.fundedHolderCount).toBe(3);
  });

  it("enforces freeze authority, Sybil entropy, and owner-aggregated concentration in Night Desk filter & parsers", () => {
    const rules = resolveRules({});
    const parsedMint = parseMintAccount({
      value: {
        data: {
          parsed: {
            info: {
              mintAuthority: null,
              freezeAuthority: "FreezeAttacker11111111111111111111111111111",
              supply: "1000000000",
              decimals: 6,
            },
          },
        },
      },
    });
    expect(parsedMint.mintAuthorityRevoked).toBe(true);
    expect(parsedMint.freezeAuthorityRevoked).toBe(false);

    const freezeKilled = evaluateFilter(
      makeToken({ freezeAuthorityRevoked: false }),
      { status: "clean" },
      rules
    );
    expect(freezeKilled.decision).toBe("reject");
    expect(freezeKilled.reasons[0]?.code).toBe("MINT_AUTHORITY_ACTIVE");

    const sybilKilled = evaluateFilter(
      makeToken({
        top10HolderPct: 0.12,
        holderCount: 25,
        shannonEntropyNormalized: 0.995,
      }),
      { status: "clean" },
      rules
    );
    expect(sybilKilled.decision).toBe("reject");
    expect(sybilKilled.reasons[0]?.code).toBe("HOLDER_CONCENTRATION");

    // Same owner across 3 token accounts (8% each = 24% total > 20% limit)
    const multiAccountWhale = parseTop10Pct(
      {
        value: [
          { address: "Acc1", owner: "SameWhale", uiAmount: 80 },
          { address: "Acc2", owner: "SameWhale", uiAmount: 80 },
          { address: "Acc3", owner: "SameWhale", uiAmount: 80 },
        ],
      },
      1_000
    );
    expect(multiAccountWhale.holderCount).toBe(1);
    expect(multiAccountWhale.top10HolderPct).toBeCloseTo(0.24, 5);
    expect(calculateNormalizedShannonEntropy([100, 100, 100, 100])).toBeCloseTo(1, 5);
  });
});

describe("4. Smart-Money Cluster Scoring & Fractional Kelly Sizer (lib/quant/copyScorer.ts)", () => {
  it("computes time-decayed Sortino composite score and rewards consistent recent winners", () => {
    const now = Date.now();
    const trades: HistoricalTrade[] = [
      { pnlSol: 4.5, returnMultiple: 1.8, timestampMs: now - 1 * 3600_000 },
      { pnlSol: 3.2, returnMultiple: 1.2, timestampMs: now - 4 * 3600_000 },
      { pnlSol: -0.6, returnMultiple: -0.25, timestampMs: now - 8 * 3600_000 },
      { pnlSol: 6.0, returnMultiple: 2.4, timestampMs: now - 12 * 3600_000 },
      { pnlSol: 2.1, returnMultiple: 0.9, timestampMs: now - 24 * 3600_000 },
    ];

    const metrics = evaluateAlphaWallet("AlphaWallet111111111111111111111111111111", trades, now);
    expect(metrics.compositeScore).toBeGreaterThan(5);
    expect(metrics.weightedWinRate).toBeGreaterThan(0.75);
    expect(metrics.sortinoRatio).toBeGreaterThan(3);
  });

  it("computes multi-wallet convergence signal over a 90s rolling window and Quarter-Kelly allocation", () => {
    const now = Date.now();
    const cluster = calculateClusterConvergenceSignal(
      [
        { walletAddress: "W1", walletScore: 12.5, buyTimestampMs: now - 10_000, winProbability: 0.65, payoffRatio: 2.5 },
        { walletAddress: "W2", walletScore: 9.8, buyTimestampMs: now - 30_000, winProbability: 0.6, payoffRatio: 2.2 },
        { walletAddress: "W3_stale", walletScore: 20.0, buyTimestampMs: now - 120_000 }, // Outside 90s window
      ],
      now
    );

    expect(cluster.activeBuyerCount).toBe(2);
    expect(cluster.convergenceSignal).toBeGreaterThan(15);

    // Quarter-Kelly for p=0.60, b=2.0 -> fullKelly = 0.60 - 0.40/2.0 = 0.40 -> Quarter-Kelly = 0.10 -> capped at 8% (0.08)
    const allocSol = calculateFractionalKellyAllocationSol({
      bankrollSol: 50,
      winProbability: 0.6,
      payoffRatio: 2.0,
    });
    expect(allocSol).toBe(4); // 8% of 50 SOL = 4 SOL

    // Negative expectancy returns 0
    expect(
      calculateFractionalKellyAllocationSol({
        bankrollSol: 50,
        winProbability: 0.2,
        payoffRatio: 1.0,
      })
    ).toBe(0);
  });
});

describe("5. Hardened Cryptographic MCP Transport & Idempotent Webhook Handler", () => {
  beforeEach(() => {
    resetProcessedWebhookSignatures();
    resetServerWebhookSignatures();
  });

  it("enforces Ed25519 signature verification and 60s replay protection on app/[transport]/route.ts", async () => {
    const kp = nacl.sign.keyPair();
    const pubKeyBase58 = bs58.encode(kp.publicKey);
    const body = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    const ts = String(Date.now());
    const messageBytes = new TextEncoder().encode(`${ts}.${body}`);
    const sigBase58 = bs58.encode(nacl.sign.detached(messageBytes, kp.secretKey));

    // 1. Missing headers -> 401
    const unauthReq = new NextRequest("http://localhost/mcp", { method: "POST", body });
    const unauthRes = await mcpPost(unauthReq);
    expect(unauthRes.status).toBe(401);

    // 2. Expired timestamp (>60s) -> 403
    const expiredTs = String(Date.now() - 120_000);
    const expiredReq = new NextRequest("http://localhost/mcp", {
      method: "POST",
      body,
      headers: {
        "x-wallet-pubkey": pubKeyBase58,
        "x-wallet-signature": sigBase58,
        "x-request-timestamp": expiredTs,
      },
    });
    const expiredRes = await mcpPost(expiredReq);
    expect(expiredRes.status).toBe(403);

    // 3. Valid Ed25519 signature -> 200
    const validReq = new NextRequest("http://localhost/mcp", {
      method: "POST",
      body,
      headers: {
        "x-wallet-pubkey": pubKeyBase58,
        "x-wallet-signature": sigBase58,
        "x-request-timestamp": ts,
      },
    });
    const validRes = await mcpPost(validReq);
    expect(validRes.status).toBe(200);
    const json = (await validRes.json()) as { result: { status: string; wallet: string } };
    expect(json.result).toEqual({ status: "authenticated", wallet: pubKeyBase58 });
  });

  it("deduplicates Helius webhook retries in O(1) time on app/api/webhooks/solana/route.ts", async () => {
    process.env.HELIUS_WEBHOOK_SECRET = "test-helius-secret";

    const payload = [{ signature: "sig-alpha-1" }, { signature: "sig-alpha-2" }, { signature: "sig-alpha-1" }];
    const req1 = new NextRequest("http://localhost/api/webhooks/solana", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { authorization: "Bearer test-helius-secret" },
    });
    const res1 = await webhookPost(req1);
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({
      status: "ok",
      processedCount: 2,
      signatures: ["sig-alpha-1", "sig-alpha-2"],
    });

    // Retry with same signatures + 1 new signature
    const req2 = new NextRequest("http://localhost/api/webhooks/solana", {
      method: "POST",
      body: JSON.stringify([{ signature: "sig-alpha-1" }, { signature: "sig-alpha-3" }]),
      headers: { authorization: "Bearer test-helius-secret" },
    });
    const res2 = await webhookPost(req2);
    expect(await res2.json()).toEqual({
      status: "ok",
      processedCount: 1,
      signatures: ["sig-alpha-3"],
    });
  });

  it("serves /api/mcp and /api/webhooks/solana on the Night Desk HTTP server and isolates paper/live books", async () => {
    process.env.HELIUS_WEBHOOK_SECRET = "http-webhook-secret";
    const desk = testDesk();
    const server = startServer(desk, "127.0.0.1", 0, "desk-secret");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const whRes = await fetch(`${base}/api/webhooks/solana`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer http-webhook-secret",
        },
        body: JSON.stringify([{ signature: "live-sig-1" }, { signature: "live-sig-1" }]),
      });
      expect(whRes.status).toBe(200);
      expect(await whRes.json()).toEqual({
        status: "ok",
        processedCount: 1,
        signatures: ["live-sig-1"],
      });

      // Verify paper vs live book isolation in DeskStore
      expect(desk.store.loadBook("paper")).not.toBeNull();
      expect(desk.store.loadBook("live")).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });
});
