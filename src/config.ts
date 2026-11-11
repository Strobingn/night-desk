import path from "node:path";
import { resolveRules, HARD_RULES, type ResolvedRules } from "./rules.js";
import { resolveDeskToken } from "./server/auth.js";
import type { FeedStatus } from "./types.js";
import { parseSecretKey } from "./market/wallet-key.js";

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
  /**
   * Trading engine default when nothing is saved. On for live feeds (it needs live quotes),
   * off on the replay tape. STRATEGY_ENGINE=1 or 0 overrides. A saved switch wins.
   */
  strategyEngine?: boolean;
  port: number;
  host: string;
  rpcUrl: string;
  /** Optional websocket override (Helius `wss://…`). Otherwise derived from `rpcUrl`. */
  rpcWsUrl?: string;
  pumpWsUrl: string;
  rugcheckUrl: string;
  bitqueryKey?: string;
  walletKeypairPath?: string;
  /**
   * v13.5 reads WALLET_PRIVATE_KEY at call time. A function so the secret is never a
   * string field on the config (JSON.stringify drops it; logs show [Function]).
   */
  readWalletSecret: () => string | undefined;
  /** v13.5 RPC for live swaps and the wallet card (.env SOLANA_RPC_URL), else rpcUrl. Never sent to clients. */
  walletRpcUrl: string;
  jupiterQuoteUrl: string;
  jupiterSwapUrl: string;
  resetPaper: boolean;
  rugWalletsFile?: string;
  /** Set only when DESK_TOKEN is non-empty. Never logged. */
  deskToken?: string;
  /** Optional. Commentary only. Never used to place or size a trade. */
  openaiApiKey?: string;
  openaiModel: string;
  /** Parallel enrich workers. Default 8, clamped to 1–16. */
  enrichConcurrency: number;
  /** Sightings waiting on a worker before the oldest is dropped. Default 160. */
  enrichQueueCap: number;
  /** Helius DAS holder pages. Default 0 (top 20 only). A non-Helius enrich RPC ignores this. */
  holderPagesMax: number;
  /** Enrich-lane budget per minute when SOLANA_RPC_URL is not Helius. Default 45. Hard cap 1200 (20/s). */
  enrichCallsPerMin: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DeskConfig {
  const liveRequested = env.LIVE_TRADING === "true";
  const walletKeypairPath = env.WALLET_KEYPAIR_PATH?.trim() || undefined;
  const rpcUrl = env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
  // v13.5: the secret is read from env only inside this closure. It is never copied onto the config.
  const readWalletSecret = (): string | undefined => {
    const raw = env.WALLET_PRIVATE_KEY;
    return raw && raw.trim() ? raw : undefined;
  };
  const envKeyValid = parseSecretKey(readWalletSecret()) != null;
  let mode: "paper" | "live" = "paper";
  let armError: string | undefined;
  if (liveRequested) {
    if (readWalletSecret() && !envKeyValid) {
      armError = "LIVE_TRADING=true but WALLET_PRIVATE_KEY is not a valid Solana private key. Staying on the paper ledger.";
    } else if (!envKeyValid && !walletKeypairPath) {
      armError = "LIVE_TRADING=true but WALLET_PRIVATE_KEY is empty (and no WALLET_KEYPAIR_PATH). Staying on the paper ledger.";
    } else if (!rpcUrl) {
      armError = "LIVE_TRADING=true but SOLANA_RPC_URL is missing. Staying on the paper ledger.";
    } else {
      mode = "live";
    }
  }
  const feedMode = parseFeedMode(env.FEED_MODE);
  const demoFeed = env.DEMO_FEED === "0" ? false : env.DEMO_FEED === "1" ? true : feedMode !== "live";
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
    strategyEngine: /^(1|true|on)$/i.test(env.STRATEGY_ENGINE ?? "") ? true : /^(0|false|off)$/i.test(env.STRATEGY_ENGINE ?? "") ? false : feedMode === "live" && !demoFeed,
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 4721,
    host: env.HOST?.trim() || "0.0.0.0",
    rpcUrl,
    rpcWsUrl: env.SOLANA_RPC_WS_URL?.trim() || undefined,
    pumpWsUrl: pumpPortalUrl(env),
    rugcheckUrl: env.RUGCHECK_API_URL?.trim() || "https://api.rugcheck.xyz/v1",
    bitqueryKey: env.BITQUERY_API_KEY?.trim() || undefined,
    walletKeypairPath,
    readWalletSecret,
    walletRpcUrl: env.DESK_WALLET_RPC_URL?.trim() || rpcUrl,
    jupiterQuoteUrl: env.JUPITER_QUOTE_URL?.trim() || "https://lite-api.jup.ag/swap/v1/quote",
    jupiterSwapUrl: env.JUPITER_SWAP_URL?.trim() || "https://lite-api.jup.ag/swap/v1/swap",
    resetPaper: env.PAPER_RESET === "1",
    rugWalletsFile: env.RUG_WALLETS_FILE?.trim() || undefined,
    deskToken: resolveDeskToken(env.DESK_TOKEN),
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    openaiModel: env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    enrichConcurrency: clampEnvInt(env.SCOUT_ENRICH_CONCURRENCY, 8, 1, 16),
    enrichQueueCap: clampEnvInt(env.SCOUT_ENRICH_QUEUE, 160, 8, 2000),
    holderPagesMax: clampEnvInt(env.HOLDER_PAGES_MAX, 0, 0, 20),
    enrichCallsPerMin: clampEnvInt(env.ENRICH_RPC_CALLS_PER_MIN, 45, 1, 1_200)
  };
}

/** Existing Scout socket only. The key is never logged. */
function pumpPortalUrl(env: NodeJS.ProcessEnv): string {
  const base = env.PUMP_WS_URL?.trim() || "wss://pumpportal.fun/api/data";
  const key = env.PUMPPORTAL_API_KEY?.trim();
  if (!key) return base;
  try {
    const url = new URL(base);
    if (!url.searchParams.has("api-key")) url.searchParams.set("api-key", key);
    return url.toString();
  } catch {
    return base;
  }
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
