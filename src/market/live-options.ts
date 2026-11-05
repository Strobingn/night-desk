export interface LiveExecutionOptions {
  transport: "rpc" | "jito";
  slippageBps: number;
  maxPriceImpactPct: number;
  platformFeeBps: number;
  /** Initialized USDC SPL token account, never a SOL treasury address. */
  feeAccount?: string;
  jitoUrl: string;
  jitoTipLamports: number;
}

export function resolveLiveExecution(env: NodeJS.ProcessEnv): LiveExecutionOptions {
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const transport = env.LIVE_EXECUTION_TRANSPORT?.trim() || "rpc";
  if (transport !== "rpc" && transport !== "jito") throw new Error("LIVE_EXECUTION_TRANSPORT must be rpc or jito.");
  const platformFeeBps = integer("PLATFORM_FEE_BPS", 0, 0, 100);
  const feeAccount = env.JUPITER_FEE_ACCOUNT?.trim() || undefined;
  if (platformFeeBps > 0 && !feeAccount) throw new Error("JUPITER_FEE_ACCOUNT is required when PLATFORM_FEE_BPS is positive.");
  const jitoUrl = env.JITO_BLOCK_ENGINE_URL?.trim() || "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
  if (new URL(jitoUrl).protocol !== "https:") throw new Error("JITO_BLOCK_ENGINE_URL must use HTTPS.");
  return {
    transport,
    slippageBps: integer("LIVE_SLIPPAGE_BPS", 100, 1, 100),
    maxPriceImpactPct: integer("LIVE_MAX_PRICE_IMPACT_BPS", 100, 1, 100) / 10_000,
    platformFeeBps, feeAccount, jitoUrl,
    jitoTipLamports: integer("JITO_TIP_LAMPORTS", 10_000, 1000, 1_000_000)
  };
}
