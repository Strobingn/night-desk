import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { decodePool, parsePumpSwapPool, pumpSwapNative, PUMPSWAP_PROGRAM, type PoolInfo } from "../../src/market/chain-marks.js";
import { PUMP_SWAP_PROGRAM } from "../../src/pump/constants.js";
import { PumpCore } from "../../src/pump/index.js";
import { LP_LOCKERS, assessLp, stillLocked } from "../../src/pump/migration/lp.js";
import { MigrationTracker, displayVenue, liquidityDrop } from "../../src/pump/migration/tracker.js";
import { GraduationSniper, canonicalObservation } from "../../src/pump/sniper/sniper.js";
import { POOL_WAIT_MS, SNIPER_PHASES, VOLUME_WINDOW_MS, createJob, reduceSniper, type SniperJob } from "../../src/pump/sniper/state.js";
import { CapError } from "../../src/pump/safety.js";
import { canonicalPumpPoolPda } from "../../src/pump/sdk.js";
import type { PumpConnection } from "../../src/pump/rpc.js";
import type { AlertEvent, AlertKind } from "../../src/pump/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(name: string): { base64: string } {
  return JSON.parse(readFileSync(path.join(root, "test/fixtures/pump", name), "utf8")) as { base64: string };
}

describe("graduation sniper state machine", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();

  it("covers watching, ready, sent, filled, expired, and failed, and does not resubmit", () => {
    expect(SNIPER_PHASES).toEqual(["watching", "ready", "sent", "filled", "expired", "failed"]);
    let now = 1_000;
    let job = createJob(mint, now, { wallet, buyArmed: false, solLamports: "5000000" });
    expect(job.phase).toBe("watching");

    job = reduceSniper(job, { type: "curve", progressPct: 89, complete: false }, now).job;
    expect(job.hunting).toBe(false);
    job = reduceSniper(job, { type: "pool", address: "other", canonical: true, quoteLamports: "10", baseRaw: "10", at: now }, now).job;
    expect(job.phase).toBe("watching");

    now = 2_000;
    job = reduceSniper(job, { type: "curve", progressPct: 90, complete: false }, now).job;
    expect(job.phase).toBe("ready");
    expect(job.history).toContain("ready");

    now = 2_500;
    const armed = reduceSniper(job, { type: "arm", buyArmed: true }, now);
    expect(armed.prepare).toBe(true);
    expect(armed.job.prepareRequested).toBe(true);
    const again = reduceSniper(armed.job, { type: "tick" }, now);
    expect(again.prepare).toBe(false);

    job = reduceSniper(armed.job, { type: "prepared", intentId: "one", unsignedTx: "AQID", simulateOnly: false }, now).job;
    expect(job.phase).toBe("sent");
    expect(job.intentId).toBe("one");
    const resent = reduceSniper(job, { type: "prepared", intentId: "two", unsignedTx: "AQID", simulateOnly: false }, now).job;
    expect(resent.intentId).toBe("one");
    expect(resent.phase).toBe("sent");

    job = reduceSniper(job, { type: "ack", result: "filled", reason: "wallet signed" }, now).job;
    expect(job.phase).toBe("filled");
    const ignored = reduceSniper(job, { type: "ack", result: "failed" }, now + 1).job;
    expect(ignored.phase).toBe("filled");
    expect(ignored.history).toEqual(["watching", "ready", "sent", "filled"]);

    let expired = createJob(mint, 0, { minVolumeLamports: "10" });
    expired = reduceSniper(expired, { type: "curve", progressPct: 95, complete: false }, 0).job;
    expired = reduceSniper(expired, { type: "pool", address: "pool", canonical: true, quoteLamports: "5", baseRaw: "1", at: 0 }, 0).job;
    expect(expired.phase).toBe("watching");
    expired = reduceSniper(expired, { type: "tick" }, VOLUME_WINDOW_MS + 1).job;
    expect(expired.phase).toBe("expired");

    let failed = createJob(mint, 0, { buyArmed: true, wallet: "" });
    failed = reduceSniper(failed, { type: "curve", progressPct: 100, complete: true }, 0).job;
    failed = reduceSniper(failed, { type: "pool", address: "pool", canonical: true, quoteLamports: "5", baseRaw: "1", at: 0 }, 0).job;
    expect(failed.phase).toBe("failed");
    expect(failed.reason).toMatch(/wallet/i);
    const stuck = reduceSniper(failed, { type: "prepared", intentId: "nope", unsignedTx: "x", simulateOnly: true }, 5).job;
    expect(stuck.phase).toBe("failed");
    expect(stuck.intentId).toBeNull();
  });

  it("labels a non-canonical pool and never snipes it", () => {
    let job = createJob(mint, 0, { wallet, buyArmed: true });
    job = reduceSniper(job, { type: "curve", progressPct: 97, complete: false }, 0).job;
    const reduced = reduceSniper(
      job,
      { type: "pool", address: Keypair.generate().publicKey.toBase58(), canonical: false, quoteLamports: "999", baseRaw: "999", at: 0 },
      0
    );
    expect(reduced.prepare).toBe(false);
    expect(reduced.job.phase).toBe("watching");
    expect(reduced.job.poolClass).toBe("non-canonical");
    expect(reduced.job.reason).toMatch(/non-canonical/);
  });

  it("expires a hunt that never sees a canonical pool", () => {
    let job = createJob(mint, 0);
    job = reduceSniper(job, { type: "curve", progressPct: 90, complete: false }, 0).job;
    job = reduceSniper(job, { type: "tick" }, POOL_WAIT_MS).job;
    expect(job.phase).toBe("expired");
  });
});

describe("graduation sniper worker", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();

  it("replayed migration reaches ready within 1s of the pool appearing", async () => {
    const appeared = 10_000;
    let now = appeared + 800;
    const sniper = new GraduationSniper({
      now: () => now,
      pollMs: 0,
      readPool: async () => (now < appeared ? null : canonicalObservation(mint, appeared))
    });
    sniper.watch({ mint, wallet });
    sniper.onCurve({ mint, progressPct: 50, complete: false });
    now = appeared - 1;
    await sniper.poll();
    expect(sniper.get(mint)?.phase).toBe("watching");
    sniper.onCurve({ mint, progressPct: 91, complete: false });
    now = appeared + 800;
    await sniper.poll();
    const job = sniper.get(mint)!;
    expect(job.phase).toBe("ready");
    expect(job.poolClass).toBe("canonical");
    expect(job.readyAt! - appeared).toBeLessThan(1_000);
    expect(job.readyAt! - appeared).toBeGreaterThanOrEqual(0);
    sniper.stop();
  });

  it("prepares one simulate-only buy unless the session is armed, then waits for the wallet", async () => {
    let prepares = 0;
    const simulated = await runToBuy(mint, wallet, async () => {
      prepares += 1;
      return { intentId: "sim", unsignedTx: "c2lt", simulateOnly: true };
    });
    expect(prepares).toBe(1);
    expect(simulated.phase).toBe("filled");
    expect(simulated.simulateOnly).toBe(true);
    expect(simulated.history).toEqual(["watching", "ready", "sent", "filled"]);

    prepares = 0;
    const sniper = buyer(mint, wallet, async () => {
      prepares += 1;
      return { intentId: "live", unsignedTx: "bGl2ZQ==", simulateOnly: false };
    });
    await armAndPool(sniper, mint);
    expect(sniper.get(mint)?.phase).toBe("sent");
    expect(sniper.get(mint)?.unsignedTx).toBe("bGl2ZQ==");
    await sniper.poll();
    sniper.observePool(mint, canonicalObservation(mint, 5_000));
    await sniper.idle();
    expect(prepares).toBe(1);
    sniper.ack(mint, "filled", "signed");
    expect(sniper.get(mint)?.phase).toBe("filled");
    sniper.ack(mint, "failed");
    expect(sniper.get(mint)?.phase).toBe("filled");
    sniper.stop();
  });

  it("a cap failure is failed, and a volume miss expires, each without a second prepare", async () => {
    let prepares = 0;
    const sniper = buyer(mint, wallet, async () => {
      prepares += 1;
      throw new CapError("CAP_TRADE", "over the per-trade cap");
    });
    await armAndPool(sniper, mint);
    expect(sniper.get(mint)?.phase).toBe("failed");
    expect(sniper.get(mint)?.reason).toMatch(/cap/i);
    await sniper.poll();
    await sniper.idle();
    expect(prepares).toBe(1);

    let now = 1_000;
    const filtered = new GraduationSniper({ now: () => now, pollMs: 0, readPool: async () => null });
    filtered.watch({ mint, wallet, buyArmed: true, minVolumeLamports: "2000000000" });
    filtered.onCurve({ mint, progressPct: 96, complete: false });
    filtered.observePool(mint, canonicalObservation(mint, now, "1000", "1000"));
    expect(filtered.get(mint)?.phase).toBe("watching");
    filtered.onTrade({ mint, solAmountLamports: "1000", timestamp: now + 1_000 });
    expect(filtered.get(mint)?.phase).toBe("watching");
    now = 1_000 + VOLUME_WINDOW_MS + 1;
    await filtered.poll();
    expect(filtered.get(mint)?.phase).toBe("expired");
    filtered.stop();
    sniper.stop();
  });

  it("does not snipe when the discovered pool is not the canonical PumpSwap pool", async () => {
    let prepares = 0;
    const other = Keypair.generate().publicKey.toBase58();
    const sniper = new GraduationSniper({
      now: () => 5_000,
      pollMs: 0,
      readPool: async () => ({ address: other, canonical: false, quoteLamports: "50", baseRaw: "50", at: 4_000 }),
      prepare: async () => {
        prepares += 1;
        return { intentId: "no", unsignedTx: "no", simulateOnly: true };
      }
    });
    sniper.watch({ mint, wallet, buyArmed: true });
    sniper.onCurve({ mint, progressPct: 99, complete: true });
    await sniper.poll();
    expect(sniper.get(mint)?.poolClass).toBe("non-canonical");
    expect(sniper.get(mint)?.phase).toBe("watching");
    expect(prepares).toBe(0);
    sniper.stop();
  });
});

describe("migration tracker", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const pool = canonicalPumpPoolPda(new PublicKey(mint)).toBase58();

  it("a canonical PumpSwap pool shows 100% LP burned", () => {
    const view = assessLp({
      mint,
      pool,
      ownerProgram: PUMP_SWAP_PROGRAM.toBase58(),
      lpSupply: 1_000_000n,
      lpMintSupply: 0n,
      holders: []
    });
    expect(view.canonical).toBe(true);
    expect(view.venue).toBe("pumpswap");
    expect(view.poolClass).toBe("canonical");
    expect(view.lpBurnedPct).toBe(100);
    expect(view.locked).toBe(true);
    expect(stillLocked(null, view)).toBe(true);
    expect(LP_LOCKERS.map((locker) => locker.id)).toEqual([
      "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE",
      "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo",
      "UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN",
      "UNCXdvMRxvz91g3HqFmpZ5NgmL77UH4QRM4NfeL4mQB",
      "UNCXrB8cZXnmtYM1aSo1Wx3pQaeSZYuF2jCTesXvECs",
      "unCXpWPXnYnP9i6E8JeVy7nkv4B9PW9uvudakMLLzdQ",
      "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m"
    ]);
  });

  it("names locker ownership and reports when the lock is gone", () => {
    const locker = "unCXpWPXnYnP9i6E8JeVy7nkv4B9PW9uvudakMLLzdQ";
    const first = assessLp({
      mint,
      pool: Keypair.generate().publicKey.toBase58(),
      ownerProgram: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      lpSupply: 1_000n,
      lpMintSupply: 1_000n,
      holders: [
        { owner: locker, amount: "400" },
        { owner: "1nc1nerator11111111111111111111111111111111", amount: "100" }
      ]
    });
    expect(first.venue).toBe("raydium");
    expect(first.canonical).toBe(false);
    expect(first.poolClass).toBe("non-canonical");
    expect(first.lpBurnedPct).toBe(10);
    expect(first.owners.find((row) => row.owner === locker)?.label).toBe("UNCX PumpSwap");
    expect(first.locked).toBe(true);
    expect(stillLocked(null, first)).toBe(true);
    const dropped = assessLp({
      mint,
      pool: first.pool,
      ownerProgram: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      lpSupply: 1_000n,
      lpMintSupply: 1_000n,
      holders: [{ owner: locker, amount: "0" }]
    });
    expect(stillLocked(first, dropped)).toBe(false);
    expect(displayVenue({ complete: true, migration: first })).toBe("raydium");
    expect(displayVenue({ complete: false, migration: null })).toBe("curve");
    expect(displayVenue({ complete: true, migration: null })).toBe("pumpswap");
  });

  it("alerts when liquidity drops 30%+ within 5 min without matching sells", () => {
    const alerts: AlertEvent[] = [];
    const tracker = new MigrationTracker({
      now: () => 0,
      emitAlert: (input: { kind: AlertKind; mint?: string; message: string; data?: Record<string, unknown> }) => {
        const event: AlertEvent = { id: "drop", kind: input.kind, mint: input.mint, at: 0, message: input.message, data: input.data };
        alerts.push(event);
        return event;
      }
    } as unknown as ConstructorParameters<typeof MigrationTracker>[0]);
    expect(tracker.noteLiquidity({ mint, quoteLamports: 100n, cumulativeSellLamports: 0n, at: 0 }).alerted).toBe(false);
    expect(tracker.noteLiquidity({ mint, quoteLamports: 71n, cumulativeSellLamports: 0n, at: 60_000 }).alerted).toBe(false);
    const hit = tracker.noteLiquidity({ mint, quoteLamports: 70n, cumulativeSellLamports: 0n, at: 120_000 });
    expect(hit.alerted).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("custom");
    expect(alerts[0]?.message).toMatch(/without matching sells/);
    expect(alerts[0]?.data).toMatchObject({ type: "liquidity-drop" });
    expect(tracker.noteLiquidity({ mint, quoteLamports: 70n, cumulativeSellLamports: 0n, at: 130_000 }).alerted).toBe(false);

    const matched = liquidityDrop(
      [
        { at: 0, quote: 100n, sell: 0n },
        { at: 60_000, quote: 60n, sell: 40n }
      ],
      60_000,
      60n,
      40n
    );
    expect(matched.alert).toBe(false);
    const late = liquidityDrop([{ at: 0, quote: 100n, sell: 0n }], 6 * 60_000, 50n, 0n);
    expect(late.alert).toBe(false);
  });
});

describe("graduation routes", () => {
  it("serves the sniper and pages a liquidity drop through the core alert log", async () => {
    const db = new DatabaseSync(":memory:");
    const connection: PumpConnection = {
      async getAccountInfo() {
        return null;
      },
      async getLatestBlockhash() {
        return PublicKey.default.toBase58();
      },
      async simulateTransaction() {
        return { err: null, units: 1, logs: [] };
      }
    };
    const core = new PumpCore({ db, rpcUrl: "http://127.0.0.1", connection, now: () => 0 });
    const mint = Keypair.generate().publicKey.toBase58();
    const pool = canonicalPumpPoolPda(new PublicKey(mint)).toBase58();
    const listed = await core.handle("GET", new URL("http://desk/api/pump/sniper"), {});
    expect(listed.status).toBe(200);
    const watched = await core.handle("POST", new URL("http://desk/api/pump/sniper/watch"), {
      mint,
      wallet: Keypair.generate().publicKey.toBase58(),
      slippageBps: 150,
      priorityFeeMicroLamports: 1000
    });
    expect(watched.status).toBe(200);
    expect((watched.body as { job: { phase: string } }).job.phase).toBe("watching");

    const first = await core.handle("POST", new URL("http://desk/api/pump/migration"), {
      mint,
      pool,
      ownerProgram: PUMPSWAP_PROGRAM,
      lpSupply: "1000000",
      lpMintSupply: "0",
      quoteLamports: "100",
      sellLamports: "0",
      at: 0
    });
    expect(first.status).toBe(200);
    expect((first.body as { migration: { lpBurnedPct: number; canonical: boolean } }).migration.lpBurnedPct).toBe(100);
    expect((first.body as { migration: { canonical: boolean } }).migration.canonical).toBe(true);
    expect((first.body as { venue: string }).venue).toBe("pumpswap");

    const second = await core.handle("POST", new URL("http://desk/api/pump/migration"), {
      mint,
      pool,
      ownerProgram: PUMPSWAP_PROGRAM,
      lpSupply: "1000000",
      lpMintSupply: "0",
      quoteLamports: "60",
      sellLamports: "0",
      at: 60_000
    });
    expect((second.body as { alerted: boolean }).alerted).toBe(true);
    const alerts = await core.handle("GET", new URL("http://desk/api/pump/alerts"), {});
    const rows = (alerts.body as { alerts: AlertEvent[] }).alerts;
    expect(rows.some((row) => row.kind === "custom" && row.message.includes("without matching sells"))).toBe(true);
  });
});

describe("PumpSwap mark uses the signed virtual quote reserve", () => {
  it("prices 11% under the vault-only ratio when virtual_quote_reserves is -11% of the quote vault", () => {
    // The old decoder divided the raw quote vault by the base vault. PumpSwap's AMM price is
    // (quote vault + signed virtual_quote_reserves) / base. A reserve of -11% of the vault —
    // accrued protocol and creator fees — is an 11% under-price versus that vault-only mark.
    // Fixtures with a zero reserve keep the old number, which is why the v13.2 expectations stay.
    const coin = tokenAccount(1_000_000_000n);
    const sol = tokenAccount(100_000_000n);
    const info: PoolInfo = { kind: "pumpswap", pair: "p", mint: "m", decimals: 6, keys: ["coin", "sol"], virtualQuoteRaw: "-11000000", quoteIsSol: true };
    const priced = decodePool(info, [coin, sol]) as number;
    const vaultOnly = decodePool({ ...info, virtualQuoteRaw: "0" }, [coin, sol]) as number;
    expect(vaultOnly).toBeCloseTo(0.0001, 12);
    expect(priced / vaultOnly).toBeCloseTo(0.89, 8);
    expect(pumpSwapNative(1_000_000_000, 100_000_000, 6, -11_000_000n, true) / vaultOnly).toBeCloseTo(0.89, 8);

    const raw = Buffer.from(fixture("pool.json").base64, "base64");
    const parsed = parsePumpSwapPool(raw);
    expect(parsed?.virtualQuoteReserves).toBe(-1_500_000n);
  });
});

function tokenAccount(raw: bigint): Uint8Array {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, raw, true);
  return data;
}

function buyer(mint: string, wallet: string, prepare: (job: SniperJob) => Promise<{ intentId: string; unsignedTx: string; simulateOnly: boolean }>) {
  return new GraduationSniper({ now: () => 5_000, pollMs: 0, readPool: async () => null, prepare });
}

async function armAndPool(sniper: GraduationSniper, mint: string) {
  sniper.watch({ mint, wallet: Keypair.generate().publicKey.toBase58(), buyArmed: true });
  sniper.onCurve({ mint, progressPct: 93, complete: false });
  sniper.observePool(mint, canonicalObservation(mint, 4_200));
  await sniper.idle();
}

async function runToBuy(mint: string, wallet: string, prepare: (job: SniperJob) => Promise<{ intentId: string; unsignedTx: string; simulateOnly: boolean }>) {
  const sniper = new GraduationSniper({ now: () => 5_000, pollMs: 0, readPool: async () => null, prepare });
  sniper.watch({ mint, wallet, buyArmed: true });
  sniper.onCurve({ mint, progressPct: 93, complete: false });
  sniper.observePool(mint, canonicalObservation(mint, 4_200));
  await sniper.idle();
  const job = sniper.get(mint)!;
  sniper.stop();
  return job;
}
