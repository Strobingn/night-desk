import { describe, expect, it } from "vitest";
import { scoreToken } from "../src/agents/analyst.js";
import { buildDemoSteps } from "../src/demo/tokens.js";
import { DEMO_RUG_WALLET, StaticRugRegistry } from "../src/market/rug-registry.js";
import { resolveRules } from "../src/rules.js";
import { loadConfig } from "../src/config.js";
import { buildRecap } from "../src/desk/recap.js";
import { evaluateFilter } from "../src/agents/filter.js";
import { testDesk } from "./helpers.js";
import { makeToken } from "../src/demo/tokens.js";

describe("handoffs and demo tape", () => {
  it("does not let a filter kill reach the executor", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ symbol: "RUGMINT", mintAuthorityRevoked: false }));
      const events = desk.snapshot().events;
      expect(events.map((event) => event.stage)).toEqual(["logger", "scout", "filter"]);
      expect(events.some((event) => event.stage === "analyst" || event.stage === "executor")).toBe(false);
      expect(desk.book.positions.size).toBe(0);
    } finally {
      desk.stop();
    }
  });

  it("walks a survivor scout → filter → analyst → executor", async () => {
    const desk = testDesk();
    try {
      await desk.submitCandidate(makeToken({ symbol: "STEADY", mint: "SteadyTest111111111111111111111111111111" }));
      const stages = desk.snapshot().events.map((event) => `${event.stage}:${event.kind}`);
      expect(stages.slice(0, 5)).toEqual([
        "logger:info",
        "scout:info",
        "filter:pass",
        "analyst:pass",
        "executor:fill"
      ]);
      expect(stages.at(-1)).toBe("system:info");
    } finally {
      desk.stop();
    }
  });

  it("keeps live trading off unless LIVE_TRADING is exactly true and a keypair path is set", () => {
    expect(loadConfig({ LIVE_TRADING: "false" }).mode).toBe("paper");
    expect(loadConfig({}).mode).toBe("paper");
    expect(loadConfig({ LIVE_TRADING: "TRUE" }).mode).toBe("paper");
    expect(loadConfig({ LIVE_TRADING: "true" }).mode).toBe("paper");
    expect(loadConfig({ LIVE_TRADING: "true" }).armError).toMatch(/WALLET_KEYPAIR_PATH/);
    expect(loadConfig({ LIVE_TRADING: "true", WALLET_KEYPAIR_PATH: "/tmp/not-a-real-key.json" }).mode).toBe("live");
  });

  it("seeds every hard rejection and both score outcomes", async () => {
    const rules = resolveRules({});
    const rugs = new StaticRugRegistry(new Map([[DEMO_RUG_WALLET, "fixture"]]));
    const steps = buildDemoSteps().filter((step) => step.kind === "candidate" && step.token);
    const codes = new Set<string>();
    let trades = 0;
    let analystRejects = 0;
    for (const step of steps) {
      const token = step.token!;
      const rug = await rugs.lookup(token.devWallet);
      const filtered = evaluateFilter(token, rug, rules);
      if (filtered.decision === "reject") {
        for (const reason of filtered.reasons) codes.add(reason.code);
        continue;
      }
      const report = scoreToken(token, rules);
      if (report.decision === "reject") analystRejects += 1;
      else trades += 1;
    }
    expect(codes).toEqual(
      new Set([
        "MINT_AUTHORITY_ACTIVE",
        "LP_NOT_LOCKED",
        "HOLDER_CONCENTRATION",
        "VOLUME_TOO_LOW",
        "DEV_RUG_HISTORY"
      ])
    );
    expect(analystRejects).toBeGreaterThan(0);
    expect(trades).toBeGreaterThanOrEqual(3);
  });

  it("summarizes kills, skips, and closed trades", () => {
    const recap = buildRecap({
      since: 0,
      until: 10,
      startingBalanceUsd: 10_000,
      equity: [
        { t: 1, equity: 10_000, cash: 10_000 },
        { t: 9, equity: 10_120, cash: 9_400 }
      ],
      open: [],
      closed: [
        {
          id: "a",
          mint: "m",
          symbol: "MOONKIT",
          openedAt: 1,
          closedAt: 5,
          costUsd: 800,
          proceedsUsd: 900,
          pnlUsd: 100,
          pnlPct: 0.125,
          exitCode: "TRAIL_STOP",
          score: 0.9,
          mode: "paper"
        },
        {
          id: "b",
          mint: "n",
          symbol: "NIGHTPEPE",
          openedAt: 2,
          closedAt: 6,
          costUsd: 800,
          proceedsUsd: 740,
          pnlUsd: -60,
          pnlPct: -0.075,
          exitCode: "STOP_LOSS",
          score: 0.88,
          mode: "paper"
        }
      ],
      events: [
        { id: "1", ts: 1, stage: "scout", kind: "info", message: "found" },
        {
          id: "2",
          ts: 2,
          stage: "filter",
          kind: "reject",
          code: "VOLUME_TOO_LOW",
          message: "killed",
          payload: { reasons: [{ code: "VOLUME_TOO_LOW" }, { code: "LP_NOT_LOCKED" }] }
        },
        { id: "3", ts: 3, stage: "filter", kind: "pass", message: "ok" },
        { id: "4", ts: 4, stage: "analyst", kind: "reject", code: "SCORE_BELOW_THRESHOLD", message: "low" },
        { id: "5", ts: 5, stage: "executor", kind: "reject", code: "REVENGE_COOLDOWN", message: "ban" },
        { id: "6", ts: 6, stage: "risk", kind: "exit", code: "STOP_LOSS", message: "stopped" }
      ]
    });
    expect(recap.pnlUsd).toBeCloseTo(120, 5);
    expect(recap.biggestWin?.symbol).toBe("MOONKIT");
    expect(recap.biggestLoss?.symbol).toBe("NIGHTPEPE");
    expect(recap.killReasons.VOLUME_TOO_LOW).toBe(1);
    expect(recap.killReasons.LP_NOT_LOCKED).toBe(1);
    expect(recap.analystRejects).toBe(1);
    expect(recap.executorSkips.REVENGE_COOLDOWN).toBe(1);
    expect(recap.riskExits.STOP_LOSS).toBe(1);
    expect(recap.wins).toHaveLength(1);
    expect(recap.losses).toHaveLength(1);
  });
});
