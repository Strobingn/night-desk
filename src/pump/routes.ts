/**
 * HTTP surface for pump core. `PumpCore.handle` dispatches these paths.
 * Later chunks add their own routes; they append a feature entry, not these.
 */
export const PUMP_CORE_ROUTES = [
  "/api/pump/status",
  "/api/pump/features",
  "/api/pump/caps",
  "/api/pump/arm",
  "/api/pump/disarm",
  "/api/pump/quote",
  "/api/pump/reverse",
  "/api/pump/prepare",
  "/api/pump/curve",
  "/api/pump/pool",
  "/api/pump/coins",
  "/api/pump/trades",
  "/api/pump/watch",
  "/api/pump/alerts"
] as const;
