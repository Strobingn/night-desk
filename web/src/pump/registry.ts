/**
 * Pump tab registry. Later chunks append a line. The tab itself stays one entry in App.
 */
import type { ComponentType } from "react";
import { GraduationScreen } from "./screens/Graduation";

export interface PumpFeatureView {
  id: string;
  label: string;
  Screen?: ComponentType;
}

export const PUMP_FEATURES: readonly PumpFeatureView[] = [
  { id: "core", label: "Curve" },
  { id: "graduation", label: "Graduation", Screen: GraduationScreen }
];
