/**
 * Pump feature registry. Later chunks append an entry. They do not edit `core`.
 */
import { PUMP_CORE_ROUTES } from "../routes.js";

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
  }
];
