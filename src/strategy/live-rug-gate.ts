/**
 * Engine live buys only. A coin that loses its pool inside a minute cannot finish this
 * window, so the buy never starts. Manual buys do not call it.
 *
 * N is 90s: the overnight rugs were dead inside about 60s of the buy, and 90s sits
 * inside the 60–120s range with room past that minute. Liquidity may not fall more
 * than 20% from the first sample. Anything unverified fails closed.
 */

export const LIVE_SURVIVAL_MS = 90_000;
export const LIVE_SURVIVAL_MAX_DROP = 0.2;
/** A live engine buy needs a real pool, not a dust print. */
export const LIVE_LIQUIDITY_FLOOR_USD = 10_000;
/** The sample that authorizes the swap has to be this fresh. */
export const LIVE_RECHECK_FRESH_MS = 15_000;
/** A watch with no new quote is abandoned so it does not hold a slot. */
export const LIVE_SURVIVAL_GIVE_UP_MS = 180_000;

export interface LiquiditySample {
  at: number;
  liquidityUsd: number | null;
}

export interface SurvivalTrack {
  startedAt: number;
  ageAtStart: number | null;
  samples: LiquiditySample[];
}

export type SurvivalStatus =
  | { status: "waiting" }
  | { status: "ready"; ageSeconds: number; liquidityUsd: number }
  | { status: "fail"; reason: string };

export function noteSurvival(
  track: SurvivalTrack | undefined,
  sample: { at: number; liquidityUsd: number | null; ageSeconds: number | null },
  now: number
): { track: SurvivalTrack; result: SurvivalStatus } {
  const next: SurvivalTrack = track
    ? { ...track, samples: [...track.samples, { at: sample.at, liquidityUsd: sample.liquidityUsd }] }
    : {
        startedAt: sample.at,
        ageAtStart: sample.ageSeconds != null && Number.isFinite(sample.ageSeconds) ? sample.ageSeconds : null,
        samples: [{ at: sample.at, liquidityUsd: sample.liquidityUsd }]
      };
  return { track: next, result: survivalStatus(next, now) };
}

export function survivalStatus(track: SurvivalTrack, now: number): SurvivalStatus {
  const last = track.samples[track.samples.length - 1];
  if (!last) return { status: "fail", reason: "Liquidity unverified." };
  if (now - track.startedAt > LIVE_SURVIVAL_GIVE_UP_MS) return { status: "fail", reason: "Liquidity was not rechecked." };
  for (const sample of track.samples) {
    if (sample.liquidityUsd == null || !Number.isFinite(sample.liquidityUsd)) return { status: "fail", reason: "Liquidity unverified." };
  }
  const first = track.samples[0]!;
  const start = first.liquidityUsd!;
  if (start < LIVE_LIQUIDITY_FLOOR_USD) return { status: "fail", reason: "Liquidity is under the live floor." };
  for (const sample of track.samples) {
    if (sample.liquidityUsd! < start * (1 - LIVE_SURVIVAL_MAX_DROP)) {
      return { status: "fail", reason: "Liquidity dropped during the survival window." };
    }
  }
  if (last.at - first.at < LIVE_SURVIVAL_MS) return { status: "waiting" };
  if (now - last.at > LIVE_RECHECK_FRESH_MS || last.at > now) return { status: "fail", reason: "Liquidity was not rechecked." };
  if (track.ageAtStart == null) return { status: "fail", reason: "Pool age unverified." };
  const ageSeconds = track.ageAtStart + (now - track.startedAt) / 1000;
  if (!(ageSeconds * 1000 >= LIVE_SURVIVAL_MS)) return { status: "fail", reason: "Pool is younger than the survival window." };
  if (last.liquidityUsd! < LIVE_LIQUIDITY_FLOOR_USD) return { status: "fail", reason: "Liquidity is under the live floor." };
  return { status: "ready", ageSeconds, liquidityUsd: last.liquidityUsd! };
}

export interface LiveEntryFacts {
  lpLockedOrBurned: boolean | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  /** Chain read. "safe" means mint and freeze authority are both revoked. */
  safety: "safe" | "unknown" | "blocked";
  /** "verified" is a completed bundle read that was not flagged. */
  bundle: "verified" | "unknown" | "flagged";
  sellRoute: "route" | "no_route" | "unknown";
  devWallet?: string | null;
}

/** Fail closed. A null LP, an unknown safety or bundle read, or a missing sell route is not a buy. */
export function liveEntryAllowed(facts: LiveEntryFacts, blacklist: ReadonlySet<string>): { ok: true } | { ok: false; reason: string } {
  if (facts.lpLockedOrBurned !== true) return { ok: false, reason: "LP lock unverified." };
  if (facts.mintAuthorityRevoked === false) return { ok: false, reason: "Mint authority is active." };
  if (facts.freezeAuthorityRevoked === false) return { ok: false, reason: "Freeze authority is active." };
  if (facts.safety !== "safe") return { ok: false, reason: facts.safety === "blocked" ? "Token safety blocked." : "Token safety unverified." };
  if (facts.bundle === "flagged") return { ok: false, reason: "Launch bundle flagged." };
  if (facts.bundle !== "verified") return { ok: false, reason: "Launch bundle unverified." };
  if (facts.sellRoute === "no_route") return { ok: false, reason: "No sell route." };
  if (facts.sellRoute !== "route") return { ok: false, reason: "Sell route unverified." };
  const dev = facts.devWallet?.trim();
  if (dev && blacklist.has(dev)) return { ok: false, reason: "Deployer is on the rug list." };
  return { ok: true };
}

export class SurvivalWindow<T> {
  private readonly rows = new Map<string, { track: SurvivalTrack; fired: T }>();

  has(mint: string): boolean {
    return this.rows.has(mint);
  }

  fired(mint: string): T | undefined {
    return this.rows.get(mint)?.fired;
  }

  holding(): string[] {
    return [...this.rows.keys()];
  }

  note(
    mint: string,
    sample: { at: number; liquidityUsd: number | null; ageSeconds: number | null },
    now: number,
    fired: T
  ): SurvivalStatus {
    const prev = this.rows.get(mint);
    const noted = noteSurvival(prev?.track, sample, now);
    if (noted.result.status === "fail") {
      this.rows.delete(mint);
      return noted.result;
    }
    this.rows.set(mint, { track: noted.track, fired });
    return noted.result;
  }

  release(mint: string): void {
    this.rows.delete(mint);
  }

  /** Watches that never got a fresh quote. The caller logs the skip and frees the slot. */
  expire(now: number): Array<{ mint: string; fired: T; reason: string }> {
    const out: Array<{ mint: string; fired: T; reason: string }> = [];
    for (const [mint, row] of this.rows) {
      const last = row.track.samples[row.track.samples.length - 1];
      const stale = last != null && now - last.at > LIVE_RECHECK_FRESH_MS && now - row.track.startedAt >= LIVE_SURVIVAL_MS;
      const abandoned = now - row.track.startedAt > LIVE_SURVIVAL_GIVE_UP_MS;
      if (!stale && !abandoned) continue;
      this.rows.delete(mint);
      out.push({ mint, fired: row.fired, reason: "Liquidity was not rechecked." });
    }
    return out;
  }
}

/**
 * The overnight set, modeled from the reported failure: the pool was gone within about 60s
 * of the buy, so a 90s stable-liquidity window cannot finish. The two that closed are the
 * survivors. Oracle did not serve the tape (401), so this is that failure shape, not a
 * replay of the host's quote log.
 */
export const OVERNIGHT_RUGS = [
  "CHARITY",
  "fomo",
  "RARECOIN",
  "Jevcraft",
  "Nutella",
  "Takes",
  "Mymo",
  "Mymo-2",
  "Avatars",
  "Avatars-2",
  "WATER",
  "LOUPE",
  "SWAMIS",
  "CI",
  "birds",
  "REKT",
  "overnight-17",
  "overnight-18"
] as const;

export const OVERNIGHT_SURVIVORS = ["CRED", "AntiTrump"] as const;

export interface OvernightCoin {
  symbol: string;
  kind: "rug" | "survivor";
  ageAtSignal: number;
  samples: Array<{ sec: number; liquidityUsd: number | null }>;
  facts: LiveEntryFacts;
}

/** A rug: the pool is gone before the window can close. Decision clock is 90s, last print is the collapse. */
export function overnightRug(symbol: string): OvernightCoin {
  return {
    symbol,
    kind: "rug",
    ageAtSignal: 12,
    samples: [
      { sec: 0, liquidityUsd: 25_000 },
      { sec: 45, liquidityUsd: 0 }
    ],
    facts: {
      lpLockedOrBurned: null,
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      safety: "unknown",
      bundle: "unknown",
      sellRoute: "no_route"
    }
  };
}

/** A survivor that is still tradable after 90s: locked LP, revoked authorities, sell route, flat liquidity. */
export function overnightSurvivor(symbol: string): OvernightCoin {
  return {
    symbol,
    kind: "survivor",
    ageAtSignal: 40,
    samples: [0, 30, 60, 90].map((sec) => ({ sec, liquidityUsd: 40_000 })),
    facts: {
      lpLockedOrBurned: true,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      safety: "safe",
      bundle: "verified",
      sellRoute: "route"
    }
  };
}

export function overnightCoins(): OvernightCoin[] {
  return [...OVERNIGHT_RUGS.map(overnightRug), ...OVERNIGHT_SURVIVORS.map(overnightSurvivor)];
}

/** Would this coin be bought at the end of its samples? Rugs are judged when the pool dies and again at 90s. */
export function overnightBlocked(coin: OvernightCoin, blacklist: ReadonlySet<string> = new Set()): { blocked: boolean; reason: string } {
  const start = 0;
  let track: SurvivalTrack | undefined;
  let result: SurvivalStatus = { status: "waiting" };
  for (const sample of coin.samples) {
    const at = start + sample.sec * 1000;
    const noted = noteSurvival(track, { at, liquidityUsd: sample.liquidityUsd, ageSeconds: coin.ageAtSignal }, at);
    track = noted.track;
    result = noted.result;
    if (result.status === "fail") return { blocked: true, reason: result.reason };
  }
  const end = start + LIVE_SURVIVAL_MS;
  if (track) result = survivalStatus(track, end);
  if (result.status === "fail") return { blocked: true, reason: result.reason };
  if (result.status !== "ready") return { blocked: true, reason: "Survival window not finished." };
  const entry = liveEntryAllowed(coin.facts, blacklist);
  if (!entry.ok) return { blocked: true, reason: entry.reason };
  return { blocked: false, reason: "" };
}
