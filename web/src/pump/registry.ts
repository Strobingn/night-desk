/**
 * Pump tab registry. Later chunks append a line. The tab itself stays one entry in App.
 */
export interface PumpFeatureView {
  id: string;
  label: string;
}

export const PUMP_FEATURES: readonly PumpFeatureView[] = [
  { id: "core", label: "Curve" }
];
