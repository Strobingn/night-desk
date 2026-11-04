/**
 * Pump feature registry. Later chunks append an entry. They do not edit `core`.
 */
import { ALERT_ROUTES } from "../alerts/routes.js";
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
