/**
 * Pump tab registry. Later chunks append a line. The tab itself stays one entry in App.
 */
import type { ComponentType } from "react";
import { Alerts } from "../screens/Alerts";
import { Scanner } from "../screens/Scanner";
import { JournalScreen } from "./screens/Journal";
import { PortfolioScreen } from "./screens/Portfolio";
import { ReplayScreen } from "./screens/Replay";
import { Terminal } from "./screens/Terminal";

export interface PumpFeatureView {
  id: string;
  label: string;
  Panel?: ComponentType;
}

export const PUMP_FEATURES: readonly PumpFeatureView[] = [
  { id: "core", label: "Curve" },
  { id: "terminal", label: "Terminal", Panel: Terminal },
  { id: "journal", label: "Journal", Panel: JournalScreen },
  { id: "replay", label: "Replay", Panel: ReplayScreen },
  { id: "portfolio", label: "Portfolio", Panel: PortfolioScreen },
  { id: "alerts", label: "Alerts", Panel: Alerts },
  { id: "scanner", label: "Scanner", Panel: Scanner }
];
