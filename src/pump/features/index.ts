/**
 * Pump feature registry. Later chunks append an entry. They do not edit `core`.
 */
import type { DatabaseSync } from "node:sqlite";
import { ALERT_ROUTES } from "../alerts/routes.js";
import { handleJournalPortfolio } from "../journal/http.js";
import { PUMP_CORE_ROUTES } from "../routes.js";
import { SCANNER_ROUTES } from "../scanner/routes.js";

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
    id: "journal",
    title: "Desk journal",
    routes: ["/api/pump/journal", "/api/pump/journal/report", "/api/pump/journal/csv", "/api/pump/journal/replay", "/api/pump/journal/report.png"]
  },
  {
    id: "portfolio",
    title: "Desk portfolio",
    routes: ["/api/pump/portfolio", "/api/pump/portfolio/wallets", "/api/pump/portfolio/import", "/api/pump/portfolio/marks"]
  },
  {
    id: "alerts",
    title: "Desk alerts",
    routes: ALERT_ROUTES
  },
  {
    id: "scanner",
    title: "Hot scanner",
    routes: SCANNER_ROUTES
  }
];

export interface PumpFeatureContext {
  db: DatabaseSync;
  now: () => number;
}

/** Feature routes PumpCore does not dispatch itself. Unknown paths return null. */
export async function dispatchPumpFeature(
  ctx: PumpFeatureContext,
  method: string,
  url: URL,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown } | null> {
  return handleJournalPortfolio(ctx, method, url, body);
}
