export interface LiveReadiness {
  mode: "paper" | "live";
  liveTradingFlag: boolean;
  keypairPresent: boolean;
  walletPublicKey: string | null;
  rpcPresent: boolean;
  operatorReady: boolean;
  lines: string[];
}

export interface DeskSnapshot {
  mode: "paper" | "live";
  liveRequested: boolean;
  armError?: string;
  readiness: LiveReadiness;
  startedAt: number;
  now: number;
  startingBalanceUsd: number;
  cashUsd: number;
  equityUsd: number;
  sessionPnlUsd: number;
  sessionPnlPct: number;
  prefs: {
    defaultBuyUsd: number | null;
    maxOpenPositions: number;
    allowUnlockedLp?: boolean;
    autoBuy?: boolean;
    minLiquidityUsd?: number;
    minTokenAgeMin?: number;
    maxTokenAgeMin?: number;
    minHolderCount?: number;
    maxDevHoldingPct?: number;
    maxTradesPerHour?: number;
    dailyMaxLossUsd?: number;
    cooldownHours?: number;
    trailTakeProfit?: boolean;
    notifyNearMiss?: boolean;
    notifyFills?: boolean;
    notifyStops?: boolean;
    pnlAlertPct?: number;
    scoutDexscreener?: boolean;
    scoutGecko?: boolean;
    scoutJupiter?: boolean;
    scoutDexpaprika?: boolean;
    scoutBitquery?: boolean;
  };
  positionCapUsd: number;
  cooldowns?: { mint: string; until: number; minutesLeft: number }[];
  rules: {
    maxTop10Pct: number;
    minVolume1hUsd: number;
    analystMinScore: number;
    maxPositionPct: number;
    stopLossPct: number;
    maxEntrySlippage?: number;
    trailArmPct: number;
    trailGapPct: number;
    revengeCooldownMs: number;
  };
  feed: {
    mode: string;
    demo: boolean;
    pumpConnected: boolean;
    dexLastPollAt: number | null;
    geckoLastPollAt?: number | null;
    jupiterLastPollAt?: number | null;
    bitqueryLastPollAt?: number | null;
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
  stance: "sell" | "skip" | "hold" | "watch" | "near-miss";
  symbol?: string;
  mint?: string;
  text: string;
  code?: string;
  score?: number;
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
  entry?: "manual" | "analyst";
  lpUnlocked?: boolean;
  markAgeMs?: number;
  openedAt: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  pnlUsd: number;
  pnlPct: number;
  exitCode: string;
  closedAt: number;
  openedAt?: number;
  score: number;
  entryPrice?: number;
  exitPrice?: number;
  costUsd?: number;
  proceedsUsd?: number;
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
