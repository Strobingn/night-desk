/**
 * Pump feature registry. Later chunks append an entry. They do not edit `core`.
 */
import type { PumpFeatureHost } from "./host.js";
import { MIGRATION_ROUTES, attachTracker, handleMigration } from "../migration/tracker.js";
import { PUMP_CORE_ROUTES } from "../routes.js";
import { SNIPER_ROUTES, attachSniper, handleSniper } from "../sniper/sniper.js";

export interface PumpFeature {
  id: string;
  title: string;
  routes: readonly string[];
}

export const PUMP_FEATURES: readonly PumpFeature[] = [
  {
    id: "core",
    title: "Pump core",
    routes: PUMP_CORE_ROUTES
  },
  {
    id: "terminal",
    title: "Bonding curve terminal",
    routes: ["/api/pump/curve", "/api/pump/reverse", "/api/pump/prepare", "/api/pump/trades", "/api/pump/watch"]
  },
  {
    id: "sniper",
    title: "Graduation sniper",
    routes: SNIPER_ROUTES
  },
  {
    id: "migration",
    title: "Graduation tracker",
    routes: MIGRATION_ROUTES
  }
];

export function attachPumpFeatures(host: PumpFeatureHost): void {
  const tracker = attachTracker(host);
  attachSniper(host, {
    onPool: (job, observation) => {
      const quote = BigInt(observation.quoteLamports || "0");
      tracker.noteLiquidity({ mint: job.mint, quoteLamports: quote, cumulativeSellLamports: BigInt(job.volumeLamports || "0"), at: observation.at ?? host.now() });
    }
  });
}

export async function handlePumpFeature(
  host: PumpFeatureHost,
  method: string,
  url: URL,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown } | null> {
  return (await handleSniper(host, method, url, body)) ?? (await handleMigration(host, method, url, body));
}
