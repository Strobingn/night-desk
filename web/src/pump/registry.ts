/**
 * Pump tab registry. Later chunks append a line. The tab itself stays one entry in App.
 */
import type { ComponentType } from "react";
import { JournalScreen } from "./screens/Journal";
import { PortfolioScreen } from "./screens/Portfolio";
import { ReplayScreen } from "./screens/Replay";

export interface PumpFeatureView {
  id: string;
  label: string;
  Panel?: ComponentType;
}

export const PUMP_FEATURES: readonly PumpFeatureView[] = [
  { id: "core", label: "Curve" },
  { id: "journal", label: "Journal", Panel: JournalScreen },
  { id: "replay", label: "Replay", Panel: ReplayScreen },
  { id: "portfolio", label: "Portfolio", Panel: PortfolioScreen }
];
