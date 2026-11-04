/**
 * Graduation sniper worker. It watches a curve past ~90% and, once the
 * canonical PumpSwap pool has liquidity, prepares one unsigned market buy.
 * The process never signs, never sends, and never prepares a second time.
 * Simulate-only unless the core ArmSession is armed. Caps apply.
 */
import { randomUUID } from "node:crypto";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { PUMP_SWAP_PROGRAM } from "../constants.js";
import type { PumpFeatureHost } from "../features/host.js";
import { buildIntent, serializeUnsigned } from "../intents.js";
import { isCanonicalPumpPool } from "../migration/lp.js";
import { LIQUIDITY_WINDOW_MS } from "../migration/tracker.js";
import { decodePoolAccount } from "../pumpswap.js";
import type { PumpConnection } from "../rpc.js";
import { CapError } from "../safety.js";
import { canonicalPumpPoolPda } from "../sdk.js";
import type { TradeIntent } from "../types.js";
import { createJob, reduceSniper, type SniperEvent, type SniperJob } from "./state.js";

export const SNIPER_ROUTES = ["/api/pump/sniper", "/api/pump/sniper/watch", "/api/pump/sniper/toggle", "/api/pump/sniper/ack"] as const;

/** Poll well under the 1s ready budget once the pool account is visible. */
export const SNIPER_POLL_MS = 250;

export interface PoolObservation {
  address: string;
  canonical: boolean;
  quoteLamports: string;
  baseRaw: string;
  /** When the pool became visible. The ready clock is the worker's now. */
  at?: number;
  /** Cumulative sells observed for this mint. Buys are not included. */
  cumulativeSellLamports?: string;
}

export interface PreparedBuy {
  intentId: string;
  unsignedTx: string;
  simulateOnly: boolean;
}

export interface SniperOptions {
  host?: PumpFeatureHost;
  now?: () => number;
  pollMs?: number;
  readPool?: (mint: string) => Promise<PoolObservation | null>;
  prepare?: (job: SniperJob) => Promise<PreparedBuy>;
  onPool?: (job: SniperJob, observation: PoolObservation) => void;
}

export class GraduationSniper {
  private readonly jobs = new Map<string, SniperJob>();
  private readonly sellLamports = new Map<string, bigint>();
  private readonly inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SniperOptions = {}) {}

  now(): number {
    return this.opts.now?.() ?? this.opts.host?.now() ?? Date.now();
  }

  list(): SniperJob[] {
    return [...this.jobs.values()];
  }

  get(mint: string): SniperJob | null {
    return this.jobs.get(mint) ?? null;
  }

  /** Resolves when in-flight prepares have finished. Tests use this. */
  idle(): Promise<void> {
    return this.tail;
  }

  watch(input: {
    mint: string;
    wallet?: string;
    solLamports?: string;
    slippageBps?: number;
    priorityFeeMicroLamports?: number;
    minVolumeLamports?: string | null;
    buyArmed?: boolean;
  }): SniperJob {
    const mint = input.mint.trim();
    const existing = this.jobs.get(mint);
    const now = this.now();
    if (existing && (existing.phase === "filled" || existing.phase === "expired" || existing.phase === "failed" || existing.phase === "sent")) {
      return existing;
    }
    if (!existing) {
      const job = createJob(mint, now, {
        wallet: input.wallet,
        solLamports: input.solLamports,
        slippageBps: clampSlip(input.slippageBps),
        priorityFeeMicroLamports: clampFee(input.priorityFeeMicroLamports),
        minVolumeLamports: input.minVolumeLamports ?? null,
        buyArmed: input.buyArmed
      });
      this.jobs.set(mint, job);
      this.ensureTimer();
      return job;
    }
    const configured = reduceSniper(
      existing,
      {
        type: "config",
        wallet: input.wallet,
        solLamports: input.solLamports,
        slippageBps: input.slippageBps == null ? undefined : clampSlip(input.slippageBps),
        priorityFeeMicroLamports: input.priorityFeeMicroLamports == null ? undefined : clampFee(input.priorityFeeMicroLamports),
        minVolumeLamports: input.minVolumeLamports
      },
      now
    );
    const armed = input.buyArmed == null ? configured : reduceSniper(configured.job, { type: "arm", buyArmed: input.buyArmed }, now);
    this.jobs.set(mint, armed.job);
    this.ensureTimer();
    if (armed.prepare) this.queuePrepare(armed.job);
    return this.jobs.get(mint)!;
  }

  /** The market-buy toggle. Off leaves a ready job sitting. On prepares once. */
  setBuyArmed(armed: boolean): SniperJob[] {
    const now = this.now();
    for (const job of this.jobs.values()) {
      const reduced = reduceSniper(job, { type: "arm", buyArmed: armed }, now);
      this.jobs.set(job.mint, reduced.job);
      if (reduced.prepare) this.queuePrepare(reduced.job);
    }
    return this.list();
  }

  onCurve(state: { mint: string; progressPct: number; complete: boolean }): void {
    const job = this.jobs.get(state.mint);
    if (!job) return;
    this.apply(job, { type: "curve", progressPct: state.progressPct, complete: state.complete });
  }

  onTrade(event: { mint: string; solAmountLamports: string; timestamp: number; isBuy?: boolean }): void {
    const job = this.jobs.get(event.mint);
    if (!job) return;
    if (event.isBuy === false) this.addSell(event.mint, event.solAmountLamports);
    this.apply(job, { type: "trade", solLamports: event.solAmountLamports, at: event.timestamp });
  }

  observePool(mint: string, observation: PoolObservation): SniperJob | null {
    const job = this.jobs.get(mint);
    if (!job) return null;
    this.opts.onPool?.(job, this.withSells(mint, observation));
    this.apply(job, {
      type: "pool",
      address: observation.address,
      canonical: observation.canonical,
      quoteLamports: observation.quoteLamports,
      baseRaw: observation.baseRaw,
      at: observation.at ?? this.now()
    });
    return this.jobs.get(mint) ?? null;
  }

  ack(mint: string, result: "filled" | "failed", reason?: string): SniperJob | null {
    const job = this.jobs.get(mint);
    if (!job) return null;
    this.apply(job, { type: "ack", result, reason });
    return this.jobs.get(mint) ?? null;
  }

  async poll(): Promise<void> {
    const mints = [...this.jobs.keys()];
    for (const mint of mints) {
      let job = this.jobs.get(mint);
      if (!job) continue;
      if (this.shouldReadPool(job)) {
        try {
          const seen = await this.readPool(mint);
          job = this.jobs.get(mint) ?? job;
          if (seen && job.phase === "watching" && job.poolSeenAt == null) {
            this.observePool(mint, seen);
          } else if (seen) {
            // Later quotes feed the liquidity watcher. They do not rebuild the snipe.
            this.opts.onPool?.(job, this.withSells(mint, seen));
          }
        } catch {
          /* The next poll tries again. A read error is not a failed snipe. */
        }
      }
      job = this.jobs.get(mint);
      if (job) this.apply(job, { type: "tick" });
    }
  }

  /** First liquidity, then one window of later quotes so a drop can be seen. */
  private shouldReadPool(job: SniperJob): boolean {
    if (job.phase === "watching" && job.hunting && job.poolSeenAt == null) return true;
    return job.poolSeenAt != null && this.now() - job.poolSeenAt <= LIQUIDITY_WINDOW_MS;
  }

  private addSell(mint: string, raw: string): void {
    let add = 0n;
    try {
      add = BigInt(raw);
    } catch {
      return;
    }
    if (add <= 0n) return;
    this.sellLamports.set(mint, (this.sellLamports.get(mint) ?? 0n) + add);
  }

  private withSells(mint: string, observation: PoolObservation): PoolObservation {
    return {
      ...observation,
      cumulativeSellLamports: observation.cumulativeSellLamports ?? (this.sellLamports.get(mint) ?? 0n).toString()
    };
  }

  private apply(job: SniperJob, event: SniperEvent): void {
    const reduced = reduceSniper(this.jobs.get(job.mint) ?? job, event, this.now());
    this.jobs.set(job.mint, reduced.job);
    if (reduced.prepare) this.queuePrepare(reduced.job);
  }

  private queuePrepare(job: SniperJob): void {
    if (this.inflight.has(job.mint)) return;
    this.inflight.add(job.mint);
    const run = this.tail.then(async () => {
      try {
        const current = this.jobs.get(job.mint) ?? job;
        const prepared = await this.prepare(current);
        const after = reduceSniper(this.jobs.get(job.mint) ?? current, { type: "prepared", ...prepared }, this.now());
        let stored = after.job;
        if (prepared.simulateOnly && stored.phase === "sent") {
          stored = reduceSniper(stored, { type: "ack", result: "filled", reason: "simulated. Nothing was sent." }, this.now()).job;
        }
        this.jobs.set(job.mint, stored);
        this.opts.host?.publish("pump.status", { sniper: publicJob(stored) });
      } catch (err) {
        const reason = err instanceof Error ? err.message : "prepare failed";
        const failed = reduceSniper(this.jobs.get(job.mint) ?? job, { type: "prepare-failed", reason }, this.now());
        this.jobs.set(job.mint, failed.job);
      } finally {
        this.inflight.delete(job.mint);
      }
    });
    this.tail = run.catch(() => undefined);
  }

  private async readPool(mint: string): Promise<PoolObservation | null> {
    if (this.opts.readPool) return this.opts.readPool(mint);
    if (!this.opts.host) return null;
    return readCanonicalPool(this.opts.host.connection, mint, this.now());
  }

  private async prepare(job: SniperJob): Promise<PreparedBuy> {
    if (this.opts.prepare) return this.opts.prepare(job);
    if (!this.opts.host) throw new Error("Sniper has no host to prepare against.");
    return prepareBuy(this.opts.host, job);
  }

  private ensureTimer(): void {
    if (this.timer || this.opts.pollMs === 0) return;
    const timer = setInterval(() => {
      void this.poll();
    }, this.opts.pollMs ?? SNIPER_POLL_MS);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export async function readCanonicalPool(connection: PumpConnection, mint: string, at: number): Promise<PoolObservation | null> {
  let address: string;
  try {
    address = canonicalPumpPoolPda(new PublicKey(mint)).toBase58();
  } catch {
    return null;
  }
  const raw = await connection.getAccountInfo(address);
  if (!raw) return null;
  try {
    const pool = decodePoolAccount(raw.data);
    const canonical = raw.owner === PUMP_SWAP_PROGRAM.toBase58() && pool.baseMint.toBase58() === mint;
    const base = await vaultBalance(connection, pool.poolBaseTokenAccount.toBase58());
    const quote = await vaultBalance(connection, pool.poolQuoteTokenAccount.toBase58());
    return { address, canonical, quoteLamports: quote.toString(), baseRaw: base.toString(), at };
  } catch {
    return { address, canonical: false, quoteLamports: "0", baseRaw: "0", at };
  }
}

export async function prepareBuy(host: PumpFeatureHost, job: SniperJob): Promise<PreparedBuy> {
  const sol = BigInt(job.solLamports);
  if (sol <= 0n) throw new Error("Buy size is empty.");
  host.safety.assertRoom(sol);
  const live = host.safety.liveAllowed(true, job.wallet);
  const built = await buildIntent(host.connection, {
    wallet: job.wallet,
    mint: job.mint,
    side: "buy",
    solLamports: sol,
    slippageBps: job.slippageBps,
    venue: "pumpswap"
  });
  const instructions = [];
  if (job.priorityFeeMicroLamports > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: job.priorityFeeMicroLamports }));
  }
  instructions.push(...built.instructions);
  const blockhash = await host.connection.getLatestBlockhash();
  const unsigned = serializeUnsigned(job.wallet, blockhash, instructions);
  const simulation = await host.connection.simulateTransaction(unsigned.tx);
  if (simulation.err) throw new Error(simulation.err);
  const intent: TradeIntent = {
    id: randomUUID(),
    mint: job.mint,
    side: "buy",
    venue: "pumpswap",
    wallet: job.wallet,
    solLamports: sol.toString(),
    tokenAmount: built.tokenAmount.toString(),
    mode: live ? "live" : "simulate",
    simulateOnly: !live,
    unsignedTx: unsigned.base64,
    feePayer: job.wallet,
    simulation: { ok: true, units: simulation.units, logs: simulation.logs },
    createdAt: host.now(),
    status: "reserved"
  };
  host.store.insertIntent(intent);
  return { intentId: intent.id, unsignedTx: unsigned.base64, simulateOnly: !live };
}

export function canonicalObservation(mint: string, at: number, quoteLamports = "1000000000", baseRaw = "1000000"): PoolObservation {
  return {
    address: canonicalPumpPoolPda(new PublicKey(mint)).toBase58(),
    canonical: isCanonicalPumpPool(mint, canonicalPumpPoolPda(new PublicKey(mint)).toBase58(), PUMP_SWAP_PROGRAM.toBase58()),
    quoteLamports,
    baseRaw,
    at
  };
}

const snipers = new WeakMap<PumpFeatureHost, GraduationSniper>();

export function attachSniper(host: PumpFeatureHost, hooks?: { onPool?: SniperOptions["onPool"] }): GraduationSniper {
  let sniper = snipers.get(host);
  if (!sniper) {
    sniper = new GraduationSniper({ host, now: () => host.now(), onPool: hooks?.onPool });
    snipers.set(host, sniper);
  }
  return sniper;
}

export function sniperFor(host: PumpFeatureHost): GraduationSniper {
  return attachSniper(host);
}

export async function handleSniper(host: PumpFeatureHost, method: string, url: URL, body: Record<string, unknown>): Promise<{ status: number; body: unknown } | null> {
  const path = url.pathname.replace(/\/$/, "");
  if (!path.startsWith("/api/pump/sniper")) return null;
  const sniper = sniperFor(host);
  try {
    if (path === "/api/pump/sniper" && method === "GET") {
      return { status: 200, body: { ok: true, jobs: sniper.list().map(publicJob) } };
    }
    if (path === "/api/pump/sniper/watch" && method === "POST") {
      const mint = str(body.mint);
      if (!mint || !isAddress(mint)) return { status: 400, body: { ok: false, error: "mint must be a Solana address", code: "BAD_REQUEST" } };
      const wallet = str(body.wallet);
      if (wallet && !isAddress(wallet)) return { status: 400, body: { ok: false, error: "wallet must be a Solana address", code: "BAD_REQUEST" } };
      const job = sniper.watch({
        mint,
        wallet,
        solLamports: amount(body.solLamports),
        slippageBps: num(body.slippageBps),
        priorityFeeMicroLamports: num(body.priorityFeeMicroLamports),
        minVolumeLamports: body.minVolumeLamports == null || body.minVolumeLamports === "" ? null : amount(body.minVolumeLamports) ?? null,
        buyArmed: typeof body.buyArmed === "boolean" ? body.buyArmed : undefined
      });
      await sniper.idle();
      const settled = sniper.get(mint) ?? job;
      host.publish("pump.status", { sniper: publicJob(settled) });
      return { status: 200, body: { ok: true, job: publicJob(settled) } };
    }
    if (path === "/api/pump/sniper/toggle" && method === "POST") {
      const jobs = sniper.setBuyArmed(body.armed === true || body.buyArmed === true);
      await sniper.idle();
      return { status: 200, body: { ok: true, jobs: (jobs.length ? sniper.list() : jobs).map(publicJob) } };
    }
    if (path === "/api/pump/sniper/ack" && method === "POST") {
      const mint = str(body.mint);
      const result = body.result === "failed" ? "failed" : body.result === "filled" ? "filled" : "";
      if (!mint || !result) return { status: 400, body: { ok: false, error: "mint and result are required", code: "BAD_REQUEST" } };
      const job = sniper.ack(mint, result, str(body.reason) || undefined);
      if (!job) return { status: 404, body: { ok: false, error: "No sniper job for that mint.", code: "NOT_FOUND" } };
      return { status: 200, body: { ok: true, job: publicJob(job) } };
    }
    return { status: 404, body: { ok: false, error: "Unknown sniper route.", code: "NOT_FOUND" } };
  } catch (err) {
    if (err instanceof CapError) return { status: 409, body: { ok: false, error: err.message, code: err.code } };
    const message = err instanceof Error ? err.message : "sniper error";
    return { status: 400, body: { ok: false, error: message, code: "BAD_REQUEST" } };
  }
}

export function publicJob(job: SniperJob): Record<string, unknown> {
  return {
    mint: job.mint,
    phase: job.phase,
    progressPct: job.progressPct,
    hunting: job.hunting,
    pool: job.pool,
    poolClass: job.poolClass,
    poolSeenAt: job.poolSeenAt,
    readyAt: job.readyAt,
    sentAt: job.sentAt,
    volumeLamports: job.volumeLamports,
    minVolumeLamports: job.minVolumeLamports,
    buyArmed: job.buyArmed,
    intentId: job.intentId,
    unsignedTx: job.unsignedTx,
    simulateOnly: job.simulateOnly,
    wallet: job.wallet,
    solLamports: job.solLamports,
    slippageBps: job.slippageBps,
    priorityFeeMicroLamports: job.priorityFeeMicroLamports,
    reason: job.reason,
    updatedAt: job.updatedAt,
    history: job.history
  };
}

async function vaultBalance(connection: PumpConnection, address: string): Promise<bigint> {
  const raw = await connection.getAccountInfo(address);
  if (!raw || raw.data.length < 72) return 0n;
  return raw.data.readBigUInt64LE(64);
}

function clampSlip(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(5_000, Math.round(value)));
}

function clampFee(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10_000_000, Math.round(value)));
}

function isAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBytes().length === 32;
  } catch {
    return false;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function amount(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  return undefined;
}
