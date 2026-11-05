import { DEMO_CLEAN_WALLET, DEMO_RUG_WALLET } from "../market/rug-registry.js";
import type { CandidateToken, SocialProxy } from "../types.js";

const LOUD: SocialProxy = { mentions1h: 40, hasWebsite: true, hasTelegram: true, hasTwitter: true };
const QUIET: SocialProxy = { mentions1h: 0, hasWebsite: false, hasTelegram: false, hasTwitter: false };

export function makeToken(overrides: Partial<CandidateToken> = {}): CandidateToken {
  const { social, ...rest } = overrides;
  return {
    mint: "GoodMint1111111111111111111111111111111111",
    symbol: "GOOD",
    name: "Good Coin",
    source: "replay",
    discoveredAt: 0,
    priceUsd: 0.001,
    liquidityUsd: 180_000,
    volume1hUsd: 180_000,
    ageSeconds: 5_400,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpLockedOrBurned: true,
    lpLockPct: 100,
    top10HolderPct: 0.04,
    holderCount: 1_200,
    devWallet: DEMO_CLEAN_WALLET,
    decimals: 6,
    ...rest,
    social: { ...LOUD, ...social }
  };
}

export interface DemoStep {
  at: number;
  kind: "candidate" | "tick";
  token?: CandidateToken;
  mint?: string;
  priceUsd?: number;
}

/** One loop of the seeded tape. Offsets are milliseconds from loop start. */
export function buildDemoSteps(): DemoStep[] {
  const steps: DemoStep[] = [];
  const pushToken = (at: number, token: CandidateToken) => {
    steps.push({ at, kind: "candidate", token });
  };
  const pushTick = (at: number, mint: string, priceUsd: number) => {
    steps.push({ at, kind: "tick", mint, priceUsd });
  };

  pushToken(400, makeToken({
    mint: "RugMint11111111111111111111111111111111111",
    symbol: "RUGMINT",
    name: "Authority Still On",
    mintAuthorityRevoked: false,
    priceUsd: 0.0004
  }));
  pushToken(1_600, makeToken({
    mint: "Lockless111111111111111111111111111111111",
    symbol: "LOCKLESS",
    name: "Unlocked Pool",
    lpLockedOrBurned: false,
    lpLockPct: 0,
    priceUsd: 0.0004
  }));
  pushToken(2_800, makeToken({
    mint: "WhaleBag11111111111111111111111111111111",
    symbol: "WHALEBAG",
    name: "Concentrated Holders",
    top10HolderPct: 0.47,
    holderCount: 18,
    priceUsd: 0.0004
  }));
  pushToken(4_000, makeToken({
    mint: "DryCoin111111111111111111111111111111111",
    symbol: "DRYCOIN",
    name: "No Volume",
    volume1hUsd: 1_200,
    priceUsd: 0.0004
  }));
  pushToken(5_200, makeToken({
    mint: "SerialRug1111111111111111111111111111111",
    symbol: "SERIAL",
    name: "Known Deployer",
    devWallet: DEMO_RUG_WALLET,
    priceUsd: 0.0004
  }));
  pushToken(6_600, makeToken({
    mint: "QuietCat11111111111111111111111111111111",
    symbol: "QUIETCAT",
    name: "Thin And Quiet",
    liquidityUsd: 12_000,
    volume1hUsd: 52_000,
    top10HolderPct: 0.19,
    holderCount: 40,
    ageSeconds: 120,
    social: QUIET,
    priceUsd: 0.00021
  }));

  const night = "NightPepe1111111111111111111111111111111";
  const nightPx = 0.0008;
  pushToken(8_000, makeToken({
    mint: night,
    symbol: "NIGHTPEPE",
    name: "Night Pepe",
    priceUsd: nightPx
  }));
  pushTick(10_000, night, nightPx * 0.98);
  pushTick(12_000, night, nightPx * 0.955);
  pushTick(14_000, night, nightPx * 0.93);
  pushToken(18_000, makeToken({
    mint: night,
    symbol: "NIGHTPEPE",
    name: "Night Pepe",
    priceUsd: nightPx * 0.9
  }));

  const moon = "MoonKit111111111111111111111111111111111";
  const moonPx = 0.002;
  pushToken(10_500, makeToken({
    mint: moon,
    symbol: "MOONKIT",
    name: "Moon Kit",
    priceUsd: moonPx
  }));
  pushTick(13_000, moon, moonPx * 1.08);
  pushTick(16_000, moon, moonPx * 1.14);
  pushTick(19_000, moon, moonPx * 1.2);
  pushTick(23_000, moon, moonPx * 1.1);

  const steady = "Steady1111111111111111111111111111111111";
  const steadyPx = 0.0042;
  pushToken(13_000, makeToken({
    mint: steady,
    symbol: "STEADY",
    name: "Steady Owl",
    priceUsd: steadyPx
  }));
  pushTick(16_500, steady, steadyPx * 1.01);
  pushTick(22_000, steady, steadyPx * 1.02);
  pushTick(30_000, steady, steadyPx * 1.035);
  pushToken(28_000, makeToken({
    mint: steady,
    symbol: "STEADY",
    name: "Steady Owl",
    priceUsd: steadyPx * 1.03
  }));

  pushToken(34_000, makeToken({
    mint: "DryAgain11111111111111111111111111111111",
    symbol: "DUST",
    name: "Dust Print",
    volume1hUsd: 800,
    liquidityUsd: 4_000,
    priceUsd: 0.0001
  }));
  pushToken(38_000, makeToken({
    mint: "WhaleTwo111111111111111111111111111111111",
    symbol: "BAGS",
    name: "Second Whale",
    top10HolderPct: 0.33,
    priceUsd: 0.0005
  }));

  return steps.sort((a, b) => a.at - b.at);
}

export const DEMO_LOOP_MS = 48_000;
