/**
 * Local armed desk for the APK gate. Temp ledger only. Live swaps are mocked and never signed.
 * Not part of `npm test`. Run: npx vitest run --config vitest.gate.config.ts
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { beforeAll, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { makeToken } from "../src/demo/tokens.js";
import { Desk } from "../src/desk/orchestrator.js";
import { startServer } from "../src/server/http.js";
import type { WalletBalances } from "../src/market/wallet-status.js";
import { testConfig } from "../test/helpers.js";

const DIR = "/tmp/nd-gate";
const LOG = `${DIR}/http.jsonl`;
const SWAPS = `${DIR}/swaps.jsonl`;
const MINT = "GateMint111111111111111111111111111111111";

const liveBroker = vi.hoisted(() => ({
  executeLiveSwap: vi.fn(async (req: { side: string; mint: string; sizeUsd?: number }) => {
    appendFileSync(SWAPS, JSON.stringify({ at: new Date().toISOString(), ...req }) + "\n");
    return new Promise(() => {
      /* hung on purpose: a live tap must time out, not fill */
    });
  })
}));
vi.mock("../src/market/live-broker.js", () => ({ executeLiveSwap: liveBroker.executeLiveSwap }));
vi.mock("../src/market/pump-live.js", () => ({
  usesPumpRoute: () => false,
  executePumpLiveSwap: async () => {
    throw new Error("pump live mock: nothing sent");
  }
}));

const rich = async (): Promise<WalletBalances> => ({ sol: 1, usdc: 25, at: Date.now(), error: null });

beforeAll(async () => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(LOG, "");
  writeFileSync(SWAPS, "");
  const orig = http.createServer.bind(http);
  (http as { createServer: typeof http.createServer }).createServer = ((handler: http.RequestListener) =>
    orig((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        appendFileSync(
          LOG,
          JSON.stringify({
            at: new Date().toISOString(),
            method: req.method,
            url: req.url,
            body: Buffer.concat(chunks).toString("utf8")
          }) + "\n"
        );
      });
      handler(req, res);
    })) as typeof http.createServer;

  const key = Keypair.generate();
  const desk = new Desk(
    testConfig({
      mode: "live",
      liveRequested: true,
      startingBalanceUsd: 1000,
      readWalletSecret: () => JSON.stringify(Array.from(key.secretKey))
    }),
    { walletBalances: rich }
  );
  desk.updateSettings({
    autoBuy: false,
    maxPositionPct: 0.1,
    positionSizeUsd: null,
    maxExposurePct: 0.25,
    maxOpenPositions: 2,
    liveTradeUsd: 5,
    liveDailyCapUsd: 20,
    liveAutoBuy: false
  });
  await desk.submitCandidate(
    makeToken({
      mint: MINT,
      symbol: "GATE",
      name: "Gate Coin",
      priceUsd: 1,
      liquidityUsd: 180_000,
      dex: "raydium",
      priceFeed: "jupiter"
    })
  );
  const server = startServer(desk, "127.0.0.1", 8791);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  writeFileSync(`${DIR}/ready`, JSON.stringify({ port, mint: MINT, symbol: "GATE", operatorReady: false }) + "\n");
  console.log(`apk-gate listening on ${port} mint ${MINT}`);
}, 30_000);

it("holds the armed desk until the process is stopped", () => new Promise(() => undefined));
