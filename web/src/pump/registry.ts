/**
 * Pump tab registry. Later chunks append a line. The tab itself stays one entry in App.
 */
import type { ComponentType } from "react";
import { GraduationScreen } from "./screens/Graduation";
import { Terminal } from "./screens/Terminal";

export interface PumpFeatureView {
  id: string;
  label: string;
  Panel?: ComponentType;
}

export const PUMP_FEATURES: readonly PumpFeatureView[] = [
  { id: "core", label: "Curve" },
  { id: "terminal", label: "Terminal", Panel: Terminal },
  { id: "graduation", label: "Graduation", Panel: GraduationScreen }
];
