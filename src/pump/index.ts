import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { DatabaseSync } from "node:sqlite";
import { CANONICAL_SOL_CURVE, curveState, reservesOf, solToReachMarketCap } from "./curve.js";
import { tradeId } from "./events.js";
import { PUMP_FEATURES } from "./features/index.js";
import { PumpFeed, type StreamKeys } from "./feed.js";
import { IntentError, buildIntent, clampSlippageBps, quoteMint, serializeUnsigned } from "./intents.js";
import { solanaConnection, type PumpConnection } from "./rpc.js";
import { CapError, PumpSafety } from "./safety.js";
import { PumpStore } from "./store.js";
import type { AlertEvent, AlertKind, PumpCoin, TradeEvent, TradeIntent } from "./types.js";
import { PumpTopics, type TopicSocket } from "./ws-topics.js";

export interface PumpHttpResult {
  status: number;
  body: unknown;
}

export class PumpCore {
  readonly store: PumpStore;
  readonly safety: PumpSafety;
  readonly topics = new PumpTopics();
  readonly feed: PumpFeed;
  private readonly connection: PumpConnection;
  private readonly now: () => number;

  constructor(opts: {
    db: DatabaseSync;
    rpcUrl: string;
    stream?: StreamKeys | null;
    connection?: PumpConnection;
    now?: () => number;
    /** Mints the feed is watching. Scout sends `subscribeTokenTrade` for these on its one socket. */
    subscribeTrades?: (mints: readonly string[]) => void;
  }) {
    this.now = opts.now ?? Date.now;
    this.store = new PumpStore(opts.db);
    this.safety = new PumpSafety(this.store, this.now);
    this.connection = opts.connection ?? solanaConnection(opts.rpcUrl);
    this.feed = new PumpFeed({
      stream: opts.stream,
      subscribeTrades: opts.subscribeTrades,
      now: this.now,
      onTrade: (event) => this.ingestTrade(event),
      onCoin: (info) => this.ingestCoin(info),
      onPool: (mint, pool) => {
        this.store.upsertCoin(this.coinFrom(mint, { pool }));
        this.topics.publish(`pump.coin:${mint}`, pool);
      },
      onCurve: (state) => {
        const prev = this.store.getCoin(state.mint);
        const coin = this.coinFrom(state.mint, { curve: state, complete: state.complete, creator: state.creator });
        this.store.upsertCoin(coin);
        if (state.complete && !prev?.complete) {
          this.emitAlert({ kind: "graduation", mint: state.mint, message: `${state.mint} graduated`, data: { marketCapLamports: state.graduationMarketCapLamports } });
        }
        this.topics.publish(`pump.coin:${state.mint}`, state);
      }
    });
  }

  onPumpFrame(text: string): void {
    this.feed.onPumpFrame(text);
  }

  onAccount(account: string, data: Uint8Array): void {
    this.feed.onAccount(account, data);
  }

  onClientMessage(socket: TopicSocket, text: string): void {
    this.topics.onClientMessage(socket, text);
  }

  detachSocket(socket: TopicSocket): void {
    this.topics.detach(socket);
  }

  emitAlert(input: { kind: AlertKind; mint?: string; message: string; data?: Record<string, unknown> }): AlertEvent {
    const event: AlertEvent = { id: randomUUID(), kind: input.kind, mint: input.mint, at: this.now(), message: input.message, data: input.data };
    this.store.insertAlert(event);
    this.topics.publish("pump.alerts", event);
    return event;
  }

  async handle(method: string, url: URL, body: unknown): Promise<PumpHttpResult> {
    try {
      return await this.route(method, url, asRecord(body));
    } catch (err) {
      if (err instanceof CapError) return { status: 409, body: { ok: false, error: err.message, code: err.code } };
      if (err instanceof IntentError) return { status: err.status, body: { ok: false, error: err.message, code: err.code } };
      const message = err instanceof Error ? err.message : "pump error";
      return { status: 400, body: { ok: false, error: message, code: "BAD_REQUEST" } };
    }
  }

  private async route(method: string, url: URL, body: Record<string, unknown>): Promise<PumpHttpResult> {
    const path = url.pathname.replace(/\/$/, "");
    if (path === "/api/pump/status" && method === "GET") {
      const arm = this.safety.session();
      return { status: 200, body: { ok: true, armed: arm.armed, arm, caps: this.safety.caps(), mode: arm.armed ? "armed" : "simulate", features: PUMP_FEATURES } };
    }
    if (path === "/api/pump/features" && method === "GET") return { status: 200, body: { ok: true, features: PUMP_FEATURES } };
    if (path === "/api/pump/caps" && method === "GET") return { status: 200, body: { ok: true, caps: this.safety.caps() } };
    if (path === "/api/pump/caps" && method === "POST") {
      const caps = this.safety.setCaps({
        tradeLamports: lamportsField(body.tradeLamports ?? body.tradeSol),
        dayLamports: lamportsField(body.dayLamports ?? body.daySol)
      });
      return { status: 200, body: { ok: true, caps } };
    }
    if (path === "/api/pump/arm" && method === "POST") {
      const arm = this.safety.armLive({ confirm: body.confirm === true, wallet: typeof body.wallet === "string" ? body.wallet : null }, (value) => {
        try {
          return new PublicKey(value).toBytes().length === 32;
        } catch {
          return false;
        }
      });
      this.topics.publish("pump.status", arm);
      return { status: 200, body: { ok: true, arm, mode: "armed" } };
    }
    if (path === "/api/pump/disarm" && method === "POST") {
      const arm = this.safety.disarm();
      this.topics.publish("pump.status", arm);
      return { status: 200, body: { ok: true, arm, mode: "simulate" } };
    }
    if (path === "/api/pump/pool" && method === "GET") {
      const mint = url.searchParams.get("mint");
      const coin = mint ? this.store.getCoin(mint) : null;
      if (!coin?.pool) return { status: 404, body: { ok: false, error: "No pool cached for that mint.", code: "NOT_FOUND" } };
      return { status: 200, body: { ok: true, pool: coin.pool } };
    }
    if (path === "/api/pump/curve" && method === "GET") {
      const mint = url.searchParams.get("mint");
      if (mint === "canonical" || !mint) return { status: 200, body: { ok: true, curve: curveState("canonical", CANONICAL_SOL_CURVE) } };
      const coin = this.store.getCoin(mint);
      if (!coin?.curve) return { status: 404, body: { ok: false, error: "No curve cached for that mint.", code: "NOT_FOUND" } };
      return { status: 200, body: { ok: true, curve: coin.curve } };
    }
    if (path === "/api/pump/reverse" && method === "POST") {
      const curve = body.curve ? reservesOf(body.curve as never) : CANONICAL_SOL_CURVE;
      const target = requiredLamports(body.targetMarketCapLamports ?? body.targetLamports, "targetMarketCapLamports");
      return { status: 200, body: { ok: true, reverse: solToReachMarketCap(curve, target) } };
    }
    if (path === "/api/pump/quote" && (method === "GET" || method === "POST")) {
      const mint = str(body.mint) || url.searchParams.get("mint") || "";
      const side = (str(body.side) || url.searchParams.get("side") || "buy") as "buy" | "sell";
      if (side !== "buy" && side !== "sell") return { status: 400, body: { ok: false, error: "side must be buy or sell", code: "BAD_REQUEST" } };
      if (!mint) return { status: 400, body: { ok: false, error: "mint is required", code: "BAD_REQUEST" } };
      const quoted = await quoteMint(this.connection, {
        mint,
        side,
        solLamports: optionalLamports(body.solLamports ?? url.searchParams.get("solLamports")),
        tokenAmount: optionalLamports(body.tokenAmount ?? url.searchParams.get("tokenAmount")),
        venue: body.venue === "pumpswap" || body.venue === "curve" ? body.venue : undefined
      });
      return { status: 200, body: { ok: true, ...quoted } };
    }
    if (path === "/api/pump/prepare" && method === "POST") return { status: 200, body: { ok: true, intent: await this.prepare(body) } };
    if (path === "/api/pump/coins" && method === "GET") return { status: 200, body: { ok: true, coins: this.store.listCoins(limitOf(url)) } };
    if (path === "/api/pump/trades" && method === "GET") {
      return { status: 200, body: { ok: true, trades: this.store.recentTrades(limitOf(url), url.searchParams.get("mint") ?? undefined) } };
    }
    if (path === "/api/pump/alerts" && method === "GET") return { status: 200, body: { ok: true, alerts: this.store.recentAlerts(limitOf(url)) } };
    if (path === "/api/pump/watch" && method === "POST") {
      const mint = str(body.mint);
      if (!mint) return { status: 400, body: { ok: false, error: "mint is required", code: "BAD_REQUEST" } };
      this.feed.watchMint(mint);
      return { status: 200, body: { ok: true, mint } };
    }
    return { status: 404, body: { ok: false, error: "Unknown pump route.", code: "NOT_FOUND" } };
  }

  private async prepare(body: Record<string, unknown>): Promise<TradeIntent> {
    const wallet = str(body.wallet);
    const mint = str(body.mint);
    const side = str(body.side) as "buy" | "sell";
    if (!wallet || !mint || (side !== "buy" && side !== "sell")) throw new IntentError(400, "BAD_REQUEST", "wallet, mint and side are required.");
    try {
      void new PublicKey(wallet);
      void new PublicKey(mint);
    } catch {
      throw new IntentError(400, "BAD_REQUEST", "wallet and mint must be Solana addresses.");
    }
    const idem = str(body.idemKey);
    if (idem) {
      const prior = this.store.findIntentByIdem(idem);
      if (prior) return prior;
    }
    const liveRequested = body.live === true;
    const simulateOnly = !this.safety.liveAllowed(liveRequested, wallet);
    const built = await buildIntent(this.connection, {
      wallet,
      mint,
      side,
      solLamports: optionalLamports(body.solLamports),
      tokenAmount: optionalLamports(body.tokenAmount),
      slippageBps: clampSlippageBps(body.slippageBps),
      venue: body.venue === "pumpswap" || body.venue === "curve" ? body.venue : undefined
    });
    // Sells return SOL. The cap is real-SOL outlay, including the buy's on-chain slippage ceiling.
    const spend = built.spendLamports;
    if (spend > 0n) this.safety.assertRoom(spend);
    try {
      const blockhash = await this.connection.getLatestBlockhash();
      const unsigned = serializeUnsigned(wallet, blockhash, built.instructions);
      const simulationRaw = await this.connection.simulateTransaction(unsigned.tx);
      const intent: TradeIntent = {
        id: randomUUID(),
        mint,
        side,
        venue: built.venue,
        wallet,
        solLamports: built.solLamports.toString(),
        tokenAmount: built.tokenAmount.toString(),
        mode: simulateOnly ? "simulate" : "live",
        simulateOnly,
        unsignedTx: unsigned.base64,
        feePayer: unsigned.tx.feePayer?.toBase58() ?? wallet,
        simulation: { ok: simulationRaw.err == null, err: simulationRaw.err ?? undefined, units: simulationRaw.units, logs: simulationRaw.logs },
        createdAt: this.now(),
        status: "reserved"
      };
      this.store.insertIntent(intent, idem || undefined, spend.toString());
      return intent;
    } finally {
      if (spend > 0n) this.safety.release(spend);
    }
  }

  private ingestTrade(event: TradeEvent): void {
    this.store.insertTrade(tradeId(event), event);
    const prev = this.store.getCoin(event.mint);
    this.store.upsertCoin(this.coinFrom(event.mint, { creator: prev?.creator, complete: prev?.complete ?? false, curve: prev?.curve ?? null, lastTradeAt: event.timestamp }));
    this.topics.publish("pump.trades", event);
    this.topics.publish(`pump.coin:${event.mint}`, event);
    this.emitAlert({ kind: "trade", mint: event.mint, message: `${event.isBuy ? "buy" : "sell"} ${event.solAmountLamports} lamports`, data: { signature: event.signature } });
  }

  private ingestCoin(info: { mint: string; name?: string; symbol?: string; creator?: string; txType: string }): void {
    const prev = this.store.getCoin(info.mint);
    const complete = info.txType === "migrate" ? true : (prev?.complete ?? false);
    this.store.upsertCoin(this.coinFrom(info.mint, { ...info, complete, curve: prev?.curve ?? null }));
    if (complete && !prev?.complete) this.emitAlert({ kind: "graduation", mint: info.mint, message: `${info.symbol ?? info.mint} migrated` });
  }

  private coinFrom(mint: string, patch: Partial<PumpCoin> & { complete?: boolean }): PumpCoin {
    const prev = this.store.getCoin(mint);
    return {
      mint,
      name: patch.name ?? prev?.name,
      symbol: patch.symbol ?? prev?.symbol,
      creator: patch.creator ?? prev?.creator,
      createdAt: prev?.createdAt ?? this.now(),
      complete: patch.complete ?? prev?.complete ?? false,
      tokenProgram: patch.tokenProgram ?? prev?.tokenProgram,
      curve: patch.curve === undefined ? (prev?.curve ?? null) : patch.curve,
      pool: patch.pool === undefined ? (prev?.pool ?? null) : patch.pool,
      lastTradeAt: patch.lastTradeAt ?? prev?.lastTradeAt,
      updatedAt: this.now()
    };
  }
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function limitOf(url: URL): number {
  const n = Number(url.searchParams.get("limit") ?? "50");
  return Number.isFinite(n) ? Math.min(200, Math.max(1, Math.floor(n))) : 50;
}

function optionalLamports(value: unknown): bigint | undefined {
  if (value == null || value === "") return undefined;
  return parseLamports(value);
}

function requiredLamports(value: unknown, name: string): bigint {
  if (value == null || value === "") throw new IntentError(400, "AMOUNT", `${name} is required.`);
  return parseLamports(value);
}

function parseLamports(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.round(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new IntentError(400, "AMOUNT", "Amounts are integer lamports.");
}

/** Accept lamports (integer) or a SOL decimal on the `*Sol` fields. */
function lamportsField(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string" && value.includes(".")) return solToLamports(value).toString();
  if (typeof value === "number" && !Number.isInteger(value)) return solToLamports(String(value)).toString();
  return parseLamports(value).toString();
}

function solToLamports(sol: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(sol)) throw new IntentError(400, "AMOUNT", "SOL amounts have at most 9 decimal places.");
  const [whole, frac = ""] = sol.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
}
