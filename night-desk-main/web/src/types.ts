export interface DeskSnapshot {
  mode: "paper" | "live";
  liveRequested: boolean;
  armError?: string;
  startedAt: number;
  now: number;
  startingBalanceUsd: number;
  cashUsd: number;
  equityUsd: number;
  sessionPnlUsd: number;
  sessionPnlPct: number;
  rules: {
    maxTop10Pct: number;
    minVolume1hUsd: number;
    analystMinScore: number;
    maxPositionPct: number;
    stopLossPct: number;
    trailArmPct: number;
    trailGapPct: number;
    revengeCooldownMs: number;
  };
  feed: {
    mode: string;
    demo: boolean;
    pumpConnected: boolean;
    dexLastPollAt: number | null;
    lastError?: string;
    sightings: number;
    enriched: number;
    dropped: number;
  };
  pipeline: {
    scouted: number;
    filteredPass: number;
    filteredKill: number;
    analystTrade: number;
    analystReject: number;
    fills: number;
    riskExits: number;
    executorSkips: number;
  };
  killReasons: Record<string, number>;
  positions: PositionView[];
  closed: ClosedTrade[];
  equity: { t: number; equity: number; cash: number }[];
  events: FeedEvent[];
  advice: AdviceNote[];
}

export interface AdviceNote {
  id: string;
  ts: number;
  stance: "sell" | "skip" | "hold" | "watch";
  symbol?: string;
  mint?: string;
  text: string;
}

export interface PositionView {
  mint: string;
  symbol: string;
  name: string;
  qty: number;
  entryPrice: number;
  markPrice: number;
  costUsd: number;
  marketValueUsd: number;
  pnlUsd: number;
  pnlPct: number;
  peakPrice: number;
  trailArmed: boolean;
  stopPrice: number;
  trailHintPrice: number | null;
  score: number;
  source: string;
  openedAt: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  pnlUsd: number;
  pnlPct: number;
  exitCode: string;
  closedAt: number;
  score: number;
}

export interface FeedEvent {
  id: string;
  ts: number;
  stage: string;
  kind: string;
  symbol?: string;
  mint?: string;
  code?: string;
  message: string;
  detail?: string;
}
