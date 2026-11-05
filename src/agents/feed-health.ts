import type { BucketStats, SourceId } from "../market/net.js";
import type { FeedSourceState, FeedSourceStatus } from "../types.js";

/** A source has to keep failing this long before the header banner shows it. */
export const BANNER_AFTER_MS = 120_000;

export const SOURCE_LABELS: Record<SourceId, string> = {
  pump: "Pump stream",
  dexscreener: "DexScreener",
  gecko: "GeckoTerminal",
  jupiter: "Jupiter",
  dexpaprika: "DexPaprika",
  bitquery: "Bitquery",
  pumpapi: "Pump.fun API",
  launchlab: "Bonk.fun / LaunchLab"
};

export const SOURCE_ORDER: SourceId[] = ["pump", "pumpapi", "launchlab", "dexscreener", "jupiter", "gecko", "dexpaprika", "bitquery"];

interface Health {
  lastOkAt: number | null;
  failingSince: number | null;
  lastError?: string;
  unavailable?: string;
  sightings: number[];
}

/**
 * Per-source health. One 429 or timeout only marks the source as backing off;
 * the banner waits until a source has failed without a single success for BANNER_AFTER_MS.
 */
export class FeedHealth {
  private readonly map = new Map<SourceId, Health>();

  private get(id: SourceId): Health {
    let h = this.map.get(id);
    if (!h) {
      h = { lastOkAt: null, failingSince: null, sightings: [] };
      this.map.set(id, h);
    }
    return h;
  }

  ok(id: SourceId, now = Date.now()): void {
    const h = this.get(id);
    h.lastOkAt = now;
    h.failingSince = null;
    h.lastError = undefined;
    h.unavailable = undefined;
  }

  fail(id: SourceId, message: string, now = Date.now()): void {
    const h = this.get(id);
    if (h.failingSince == null) h.failingSince = now;
    h.lastError = message;
  }

  /** The endpoint is gone (HTTP 410). Shown as down in Scout status, never as a banner. */
  unavailable(id: SourceId, message: string): void {
    const h = this.get(id);
    h.unavailable = message;
    h.lastError = message;
  }

  isUnavailable(id: SourceId): boolean {
    return Boolean(this.map.get(id)?.unavailable);
  }

  sighting(id: SourceId, now = Date.now()): void {
    const h = this.get(id);
    h.sightings.push(now);
    while (h.sightings.length && h.sightings[0]! <= now - 60_000) h.sightings.shift();
  }

  status(
    id: SourceId,
    opts: { enabled: boolean; idleReason?: string; buckets: BucketStats[]; connected?: boolean; stale?: string; now?: number }
  ): FeedSourceStatus {
    const now = opts.now ?? Date.now();
    const h = this.get(id);
    while (h.sightings.length && h.sightings[0]! <= now - 60_000) h.sightings.shift();
    const mine = opts.buckets.filter((b) => b.source === id);
    const retryAt = mine.reduce<number | null>((acc, b) => (b.pausedUntil && (!acc || b.pausedUntil > acc) ? b.pausedUntil : acc), null);
    const failingMs = h.failingSince != null ? now - h.failingSince : 0;
    let state: FeedSourceState;
    let detail: string | undefined;
    if (!opts.enabled) {
      state = "off";
      detail = opts.idleReason;
    } else if (h.unavailable) {
      state = "down";
      detail = h.unavailable;
    } else if (h.failingSince != null && failingMs >= BANNER_AFTER_MS) {
      state = "down";
      detail = h.lastError;
    } else if (opts.stale) {
      state = "stale";
      detail = opts.stale;
    } else if (retryAt || h.failingSince != null) {
      state = "backoff";
      detail = h.lastError;
    } else if (id === "pump" && opts.connected === false) {
      state = "backoff";
      detail = "reconnecting";
    } else {
      state = "live";
    }
    return {
      id,
      label: SOURCE_LABELS[id],
      enabled: opts.enabled,
      state,
      detail,
      retryAt: state === "backoff" ? retryAt : null,
      failingSince: h.failingSince,
      lastOkAt: h.lastOkAt,
      reqPerMin: mine.reduce((sum, b) => sum + b.reqLastMin, 0),
      budgetPerMin: mine.length ? mine.reduce((sum, b) => sum + b.budgetPerMin, 0) : null,
      limitPerMin: mine.length ? mine.reduce((sum, b) => sum + b.limitPerMin, 0) : null,
      count429: mine.reduce((sum, b) => sum + b.count429, 0),
      sightingsPerMin: h.sightings.length
    };
  }

  /** The header banner: only a source that is on and has failed for 2+ minutes straight. */
  banner(sources: FeedSourceStatus[], now = Date.now()): string | undefined {
    for (const src of sources) {
      if (!src.enabled || src.failingSince == null) continue;
      if (this.map.get(src.id)?.unavailable) continue;
      const failingMs = now - src.failingSince;
      if (failingMs < BANNER_AFTER_MS) continue;
      const mins = Math.max(2, Math.round(failingMs / 60_000));
      return `${src.label} failing for ${mins} min${src.detail ? ` (${src.detail})` : ""}`;
    }
    return undefined;
  }
}
