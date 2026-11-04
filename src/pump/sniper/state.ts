/**
 * Graduation sniper state machine.
 * watching → ready → sent → filled, or expired / failed.
 * Terminal phases stay terminal: a later pool event cannot prepare a second transaction.
 */

export const SNIPER_PHASES = ["watching", "ready", "sent", "filled", "expired", "failed"] as const;
export type SniperPhase = (typeof SNIPER_PHASES)[number];

/** Curve progress that starts the migration watch. */
export const WATCH_PROGRESS_PCT = 90;
/** Volume filter clock, starting when canonical liquidity appears. */
export const VOLUME_WINDOW_MS = 60_000;
/** Hunting with no canonical pool by this time expires the watch. */
export const POOL_WAIT_MS = 10 * 60_000;

const TERMINAL: ReadonlySet<SniperPhase> = new Set(["filled", "expired", "failed"]);

export interface SniperJob {
  mint: string;
  phase: SniperPhase;
  progressPct: number;
  /** True once progress has crossed the watch line or the curve is complete. */
  hunting: boolean;
  huntStartedAt: number | null;
  pool: string | null;
  poolClass: "canonical" | "non-canonical" | null;
  /** Set when the canonical pool has non-zero liquidity. */
  poolSeenAt: number | null;
  readyAt: number | null;
  sentAt: number | null;
  volumeLamports: string;
  /** Null means the volume filter is off. */
  minVolumeLamports: string | null;
  buyArmed: boolean;
  /** Set the moment a prepare is requested. Blocks a second prepare. */
  prepareRequested: boolean;
  intentId: string | null;
  unsignedTx: string | null;
  simulateOnly: boolean | null;
  wallet: string;
  solLamports: string;
  slippageBps: number;
  priorityFeeMicroLamports: number;
  reason: string | null;
  updatedAt: number;
  history: SniperPhase[];
}

export type SniperEvent =
  | { type: "curve"; progressPct: number; complete: boolean }
  | { type: "pool"; address: string; canonical: boolean; quoteLamports: string; baseRaw: string; at: number }
  | { type: "trade"; solLamports: string; at: number }
  | { type: "tick" }
  | { type: "arm"; buyArmed: boolean }
  | { type: "config"; wallet?: string; solLamports?: string; slippageBps?: number; priorityFeeMicroLamports?: number; minVolumeLamports?: string | null }
  | { type: "prepared"; intentId: string; unsignedTx: string; simulateOnly: boolean }
  | { type: "prepare-failed"; reason: string }
  | { type: "ack"; result: "filled" | "failed"; reason?: string };

export interface ReduceResult {
  job: SniperJob;
  /** Ask the worker to build one unsigned transaction. Never set twice. */
  prepare: boolean;
}

export function createJob(
  mint: string,
  now: number,
  opts: {
    wallet?: string;
    solLamports?: string;
    slippageBps?: number;
    priorityFeeMicroLamports?: number;
    minVolumeLamports?: string | null;
    buyArmed?: boolean;
  } = {}
): SniperJob {
  return {
    mint,
    phase: "watching",
    progressPct: 0,
    hunting: false,
    huntStartedAt: null,
    pool: null,
    poolClass: null,
    poolSeenAt: null,
    readyAt: null,
    sentAt: null,
    volumeLamports: "0",
    minVolumeLamports: opts.minVolumeLamports ?? null,
    buyArmed: opts.buyArmed === true,
    prepareRequested: false,
    intentId: null,
    unsignedTx: null,
    simulateOnly: null,
    wallet: opts.wallet ?? "",
    solLamports: opts.solLamports ?? "5000000",
    slippageBps: opts.slippageBps ?? 100,
    priorityFeeMicroLamports: opts.priorityFeeMicroLamports ?? 0,
    reason: null,
    updatedAt: now,
    history: ["watching"]
  };
}

export function reduceSniper(job: SniperJob, event: SniperEvent, now: number): ReduceResult {
  if (TERMINAL.has(job.phase)) return { job, prepare: false };
  let next = job;
  if (event.type === "curve") next = onCurve(next, event, now);
  else if (event.type === "pool") next = onPool(next, event, now);
  else if (event.type === "trade") next = onTrade(next, event, now);
  else if (event.type === "tick") next = onTick(next, now);
  else if (event.type === "arm") next = { ...next, buyArmed: event.buyArmed, updatedAt: now };
  else if (event.type === "config") next = onConfig(next, event, now);
  else if (event.type === "prepared") next = onPrepared(next, event, now);
  else if (event.type === "prepare-failed") next = enter(next, "failed", now, event.reason);
  else if (event.type === "ack") next = onAck(next, event, now);
  return finish(next, now);
}

function onCurve(job: SniperJob, event: { progressPct: number; complete: boolean }, now: number): SniperJob {
  if (job.phase !== "watching" && job.phase !== "ready") return job;
  const progressPct = Math.max(0, Math.min(100, event.progressPct));
  const hunting = job.hunting || event.complete || progressPct >= WATCH_PROGRESS_PCT;
  return {
    ...job,
    progressPct,
    hunting,
    huntStartedAt: hunting ? (job.huntStartedAt ?? now) : job.huntStartedAt,
    updatedAt: now
  };
}

function onPool(
  job: SniperJob,
  event: { address: string; canonical: boolean; quoteLamports: string; baseRaw: string; at: number },
  now: number
): SniperJob {
  if (job.phase !== "watching") return job;
  if (!event.canonical) {
    return {
      ...job,
      pool: event.address,
      poolClass: "non-canonical",
      reason: "non-canonical pool — not sniped",
      updatedAt: now
    };
  }
  const liquid = positive(event.quoteLamports) || positive(event.baseRaw);
  const seen = liquid ? (job.poolSeenAt ?? event.at) : job.poolSeenAt;
  return {
    ...job,
    pool: event.address,
    poolClass: "canonical",
    poolSeenAt: seen,
    reason: job.poolClass === "non-canonical" ? null : job.reason,
    updatedAt: now
  };
}

function onTrade(job: SniperJob, event: { solLamports: string; at: number }, now: number): SniperJob {
  if (job.phase !== "watching" || job.poolSeenAt == null || job.poolClass !== "canonical") return job;
  if (event.at < job.poolSeenAt || event.at > job.poolSeenAt + VOLUME_WINDOW_MS) return job;
  let volume = 0n;
  try {
    volume = BigInt(job.volumeLamports) + BigInt(event.solLamports);
  } catch {
    return job;
  }
  if (volume < 0n) return job;
  return { ...job, volumeLamports: volume.toString(), updatedAt: now };
}

function onTick(job: SniperJob, now: number): SniperJob {
  if (job.phase !== "watching") return job;
  if (job.hunting && job.poolClass !== "canonical" && job.huntStartedAt != null && now - job.huntStartedAt >= POOL_WAIT_MS) {
    return enter(job, "expired", now, "canonical pool did not appear");
  }
  if (job.poolClass === "canonical" && job.poolSeenAt != null && job.minVolumeLamports != null && now > job.poolSeenAt + VOLUME_WINDOW_MS) {
    if (!volumeMet(job)) return enter(job, "expired", now, "volume filter missed in the first 60s");
  }
  return job;
}

function onConfig(job: SniperJob, event: Extract<SniperEvent, { type: "config" }>, now: number): SniperJob {
  if (job.phase !== "watching" && job.phase !== "ready") return job;
  return {
    ...job,
    wallet: event.wallet ?? job.wallet,
    solLamports: event.solLamports ?? job.solLamports,
    slippageBps: event.slippageBps ?? job.slippageBps,
    priorityFeeMicroLamports: event.priorityFeeMicroLamports ?? job.priorityFeeMicroLamports,
    minVolumeLamports: event.minVolumeLamports === undefined ? job.minVolumeLamports : event.minVolumeLamports,
    updatedAt: now
  };
}

function onPrepared(job: SniperJob, event: { intentId: string; unsignedTx: string; simulateOnly: boolean }, now: number): SniperJob {
  if (job.phase !== "ready" || job.intentId) return job;
  return {
    ...enter(job, "sent", now, event.simulateOnly ? "simulated unsigned buy" : "unsigned buy ready for the wallet"),
    intentId: event.intentId,
    unsignedTx: event.unsignedTx,
    simulateOnly: event.simulateOnly,
    sentAt: now
  };
}

function onAck(job: SniperJob, event: { result: "filled" | "failed"; reason?: string }, now: number): SniperJob {
  if (job.phase !== "sent") return job;
  return enter(job, event.result, now, event.reason ?? null);
}

/** Canonical liquidity is in, and the volume filter (if any) has passed. */
function maybeReady(job: SniperJob, now: number): SniperJob {
  if (job.phase !== "watching" || !job.hunting || job.poolClass !== "canonical" || job.poolSeenAt == null) return job;
  if (!volumeMet(job)) return job;
  return { ...enter(job, "ready", now, "canonical PumpSwap pool has liquidity"), readyAt: now };
}

function volumeMet(job: SniperJob): boolean {
  if (job.minVolumeLamports == null) return true;
  try {
    return BigInt(job.volumeLamports) > BigInt(job.minVolumeLamports);
  } catch {
    return false;
  }
}

function finish(job: SniperJob, now: number): ReduceResult {
  const progressed = maybeReady(job, now);
  if (progressed.phase !== "ready" || !progressed.buyArmed || progressed.prepareRequested || progressed.poolClass !== "canonical") {
    return { job: progressed, prepare: false };
  }
  if (!progressed.wallet) {
    return { job: enter(progressed, "failed", now, "Set a wallet before arming the buy. The wallet signs it."), prepare: false };
  }
  return { job: { ...progressed, prepareRequested: true, updatedAt: now }, prepare: true };
}

function enter(job: SniperJob, phase: SniperPhase, now: number, reason: string | null): SniperJob {
  if (job.phase === phase) return { ...job, reason: reason ?? job.reason, updatedAt: now };
  if (TERMINAL.has(job.phase)) return job;
  if (job.phase === "sent" && phase !== "filled" && phase !== "failed") return job;
  if (job.phase === "ready" && phase !== "sent" && phase !== "failed" && phase !== "expired") return job;
  if (job.phase === "watching" && phase === "sent") return job;
  return {
    ...job,
    phase,
    reason,
    updatedAt: now,
    history: [...job.history, phase]
  };
}

function positive(raw: string): boolean {
  try {
    return BigInt(raw) > 0n;
  } catch {
    return false;
  }
}
