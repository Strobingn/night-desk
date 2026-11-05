import path from "node:path";
import { resolveRules, HARD_RULES, type ResolvedRules } from "./rules.js";
import { isLoopbackHost, resolveDeskToken } from "./server/auth.js";
import type { FeedStatus } from "./types.js";
import { resolveLiveExecution } from "./market/live-options.js";

export interface DeskConfig {
  rules: ResolvedRules;
  mode: "paper" | "live";
  liveRequested: boolean;
  armError?: string;
  startingBalanceUsd: number;
  dbPath: string;
  jsonlPath: string;
  /** Plain-text mirror of every stage event. Survives restarts. */
  logPath: string;
  /** Learned advisory memory. Never read as an order. */
  advisorPath: string;
  demoFeed: boolean;
  feedMode: FeedStatus["mode"];
  port: number;
  host: string;
  rpcUrl: string;
  pumpWsUrl: string;
  rugcheckUrl: string;
  bitqueryKey?: string;
  walletKeypairPath?: string;
  jupiterQuoteUrl: string;
  jupiterSwapUrl: string;
  jupiterApiKey?: string;
  liveExecution: import("./market/live-options.js").LiveExecutionOptions;
  resetPaper: boolean;
  rugWalletsFile?: string;
  /** Set only when DESK_TOKEN is non-empty. Never logged. */
  deskToken?: string;
  /** Optional. Commentary only. Never used to place or size a trade. */
  openaiApiKey?: string;
  openaiModel: string;
  /** Parallel enrich workers. Default 6, clamped to 1–12. */
  enrichConcurrency: number;
  /** Sightings waiting on a worker before the oldest is dropped. Default 160. */
  enrichQueueCap: number;
  /** Helius DAS holder pages. Default 3. Public RPC ignores this and stays on the top 20. */
  holderPagesMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DeskConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  const deskToken = resolveDeskToken(env.DESK_TOKEN);
  if (!deskToken && !isLoopbackHost(host)) throw new Error("DESK_TOKEN is required when HOST is not a loopback address.");
  const liveRequested = env.LIVE_TRADING === "true";
  const walletKeypairPath = env.WALLET_KEYPAIR_PATH?.trim() || undefined;
  const rpcUrl = env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
  let mode: "paper" | "live" = "paper";
  let armError: string | undefined;
  if (liveRequested) {
    if (!walletKeypairPath) {
      armError = "LIVE_TRADING=true but WALLET_KEYPAIR_PATH is missing. Staying on the paper ledger.";
    } else if (!rpcUrl) {
      armError = "LIVE_TRADING=true but SOLANA_RPC_URL is missing. Staying on the paper ledger.";
    } else {
      mode = "live";
    }
  }
  const feedMode = mode === "live" ? "live" : parseFeedMode(env.FEED_MODE);
  const demoFeed = mode === "live" ? false : env.DEMO_FEED === "0" ? false : env.DEMO_FEED === "1" ? true : feedMode !== "live";
  const starting = Number(env.PAPER_BALANCE_USD);
  return {
    rules: resolveRules(env),
    mode,
    liveRequested,
    armError,
    startingBalanceUsd: Number.isFinite(starting) && starting > 0 ? starting : HARD_RULES.paperStartingUsd,
    dbPath: path.resolve(env.DB_PATH?.trim() || "./data/desk.sqlite"),
    jsonlPath: path.resolve(env.LOG_JSONL?.trim() || "./data/desk.jsonl"),
    logPath: path.resolve(env.LOG_FILE?.trim() || "./data/desk.log"),
    advisorPath: path.resolve(env.ADVISOR_PATH?.trim() || "./data/advisor.json"),
    demoFeed,
    feedMode,
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 4721,
    host,
    rpcUrl,
    pumpWsUrl: env.PUMP_WS_URL?.trim() || "wss://pumpportal.fun/api/data",
    rugcheckUrl: env.RUGCHECK_API_URL?.trim() || "https://api.rugcheck.xyz/v1",
    bitqueryKey: env.BITQUERY_API_KEY?.trim() || undefined,
    walletKeypairPath,
    jupiterQuoteUrl: env.JUPITER_QUOTE_URL?.trim() || "https://lite-api.jup.ag/swap/v1/quote",
    jupiterSwapUrl: env.JUPITER_SWAP_URL?.trim() || "https://lite-api.jup.ag/swap/v1/swap",
    jupiterApiKey: env.JUPITER_API_KEY?.trim() || undefined,
    liveExecution: resolveLiveExecution(env),
    resetPaper: env.PAPER_RESET === "1" && mode === "paper",
    rugWalletsFile: env.RUG_WALLETS_FILE?.trim() || undefined,
    deskToken,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    openaiModel: env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    enrichConcurrency: clampEnvInt(env.SCOUT_ENRICH_CONCURRENCY, 6, 1, 12),
    enrichQueueCap: clampEnvInt(env.SCOUT_ENRICH_QUEUE, 160, 8, 2000),
    holderPagesMax: clampEnvInt(env.HOLDER_PAGES_MAX, 3, 0, 20)
  };
}

function clampEnvInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function parseFeedMode(raw: string | undefined): FeedStatus["mode"] {
  if (raw === "replay" || raw === "live" || raw === "auto") return raw;
  return "auto";
}
