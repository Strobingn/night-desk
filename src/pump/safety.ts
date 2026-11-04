/**
 * Real-SOL path is simulate-only until this process is armed.
 * The arm lives in memory: a restart constructs a new session and it is disarmed.
 * Caps default to 0.005 SOL / trade and 0.025 SOL / day, and cannot exceed
 * 1 SOL / trade or 5 SOL / day. Unsigned intents reserve the day cap.
 */
import {
  DAY_CAP_CEILING_LAMPORTS,
  DAY_CAP_DEFAULT_LAMPORTS,
  DAY_WINDOW_MS,
  TRADE_CAP_CEILING_LAMPORTS,
  TRADE_CAP_DEFAULT_LAMPORTS
} from "./constants.js";
import type { PumpStore } from "./store.js";
import type { ArmSession, Caps } from "./types.js";

export class CapError extends Error {
  constructor(
    readonly code: "CAP_TRADE" | "CAP_DAY",
    message: string
  ) {
    super(message);
  }
}

interface SavedCaps {
  tradeLamports?: string;
  dayLamports?: string;
}

export class PumpSafety {
  private arm: ArmSession = { armed: false, armedAt: null, wallet: null };

  constructor(
    private readonly store: PumpStore,
    private readonly now: () => number = Date.now
  ) {}

  session(): ArmSession {
    return { ...this.arm };
  }

  armLive(input: { confirm?: boolean; wallet?: string | null }, isPubkey: (value: string) => boolean): ArmSession {
    if (input.confirm !== true) throw new Error('Send {"confirm": true} to arm real-SOL prepares for this process.');
    const wallet = input.wallet?.trim() || null;
    if (wallet && !isPubkey(wallet)) throw new Error("Arm wallet is not a Solana address.");
    this.arm = { armed: true, armedAt: this.now(), wallet };
    return this.session();
  }

  disarm(): ArmSession {
    this.arm = { armed: false, armedAt: null, wallet: null };
    return this.session();
  }

  /** Live only when this process is armed and the client asked for it. */
  liveAllowed(requested: boolean, wallet: string): boolean {
    if (!requested || !this.arm.armed) return false;
    if (this.arm.wallet && this.arm.wallet !== wallet) return false;
    return true;
  }

  caps(): Caps {
    const saved = this.read();
    const trade = saved.tradeLamports ? clamp(BigInt(saved.tradeLamports), 1n, TRADE_CAP_CEILING_LAMPORTS) : TRADE_CAP_DEFAULT_LAMPORTS;
    const day = saved.dayLamports ? clamp(BigInt(saved.dayLamports), 1n, DAY_CAP_CEILING_LAMPORTS) : DAY_CAP_DEFAULT_LAMPORTS;
    const used = this.store.reservedSince(this.now() - DAY_WINDOW_MS);
    return {
      tradeLamports: trade.toString(),
      dayLamports: day.toString(),
      tradeCeilingLamports: TRADE_CAP_CEILING_LAMPORTS.toString(),
      dayCeilingLamports: DAY_CAP_CEILING_LAMPORTS.toString(),
      tradeDefaultLamports: TRADE_CAP_DEFAULT_LAMPORTS.toString(),
      dayDefaultLamports: DAY_CAP_DEFAULT_LAMPORTS.toString(),
      dayUsedLamports: used.toString(),
      windowMs: DAY_WINDOW_MS
    };
  }

  /** SOL amounts, as lamports. Values above the ceiling clamp down. */
  setCaps(input: { tradeLamports?: string; dayLamports?: string }): Caps {
    const current = this.read();
    const next: SavedCaps = { ...current };
    if (input.tradeLamports != null) next.tradeLamports = clamp(BigInt(input.tradeLamports), 1n, TRADE_CAP_CEILING_LAMPORTS).toString();
    if (input.dayLamports != null) next.dayLamports = clamp(BigInt(input.dayLamports), 1n, DAY_CAP_CEILING_LAMPORTS).toString();
    this.store.db
      .prepare(`INSERT INTO kv (key, value) VALUES ('pumpCaps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(next));
    return this.caps();
  }

  /**
   * SOL already checked out by a prepare that has not inserted its row yet.
   * Concurrent prepares otherwise both read the same `dayUsedLamports`.
   */
  private pending = 0n;

  /** Throws CapError (HTTP 409) when the worst-case SOL outlay breaks a cap. Holds `pending` until `release`. */
  assertRoom(solLamports: bigint): void {
    const caps = this.caps();
    const trade = BigInt(caps.tradeLamports);
    const day = BigInt(caps.dayLamports);
    const used = BigInt(caps.dayUsedLamports) + this.pending;
    if (solLamports > trade) {
      throw new CapError("CAP_TRADE", `Trade is ${sol(solLamports)} SOL. The per-trade cap is ${sol(trade)} SOL.`);
    }
    if (used + solLamports > day) {
      throw new CapError("CAP_DAY", `That trade would put the rolling day at ${sol(used + solLamports)} SOL. The day cap is ${sol(day)} SOL.`);
    }
    this.pending += solLamports;
  }

  /** Drop a hold from `assertRoom` once the row is inserted (the table counts it) or the prepare fails. */
  release(solLamports: bigint): void {
    this.pending = this.pending > solLamports ? this.pending - solLamports : 0n;
  }

  private read(): SavedCaps {
    const row = this.store.db.prepare(`SELECT value FROM kv WHERE key = 'pumpCaps'`).get() as { value: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.value) as SavedCaps;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
}

function clamp(n: bigint, min: bigint, max: bigint): bigint {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function sol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
