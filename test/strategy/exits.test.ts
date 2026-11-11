import { describe, expect, it } from "vitest";
import { assessStrategyExit, type StrategyMeta } from "../../src/strategy/exits.js";

const now = 5_000_000;
const meta = (over: Partial<StrategyMeta> = {}): StrategyMeta => ({
  variant: "launch-1",
  signal: "launch",
  stopPct: 0.01,
  targetNetUsd: 3,
  timeLimitMs: 600_000,
  ...over
});
const base = { entryPrice: 1, openedAt: now - 60_000, markFresh: true, now };

describe("strategy exits", () => {
  it("holds inside the stop and under the target", () => {
    const r = assessStrategyExit({ ...base, mark: 0.995, netPnlUsd: -0.4, meta: meta() });
    expect(r.action).toBe("hold");
    expect(r.armBreakeven).toBe(false);
  });

  it("stops at the variant stop, not before", () => {
    expect(assessStrategyExit({ ...base, mark: 0.9901, netPnlUsd: -0.6, meta: meta() }).action).toBe("hold");
    const r = assessStrategyExit({ ...base, mark: 0.99, netPnlUsd: -0.7, meta: meta() });
    expect(r).toMatchObject({ action: "exit", code: "STRATEGY_STOP" });
    expect(assessStrategyExit({ ...base, mark: 0.97, netPnlUsd: -1.6, meta: meta({ stopPct: 0.03 }) }).code).toBe("STRATEGY_STOP");
    expect(assessStrategyExit({ ...base, mark: 0.975, netPnlUsd: -1.4, meta: meta({ stopPct: 0.03 }) }).action).toBe("hold");
  });

  it("takes profit at the net target, not on gross", () => {
    expect(assessStrategyExit({ ...base, mark: 1.07, netPnlUsd: 2.99, meta: meta() }).action).toBe("hold");
    expect(assessStrategyExit({ ...base, mark: 1.07, netPnlUsd: 3, meta: meta() })).toMatchObject({ action: "exit", code: "TAKE_PROFIT" });
  });

  it("arms breakeven at half the target and exits when the trade nets zero again", () => {
    const armed = assessStrategyExit({ ...base, mark: 1.04, netPnlUsd: 1.5, meta: meta() });
    expect(armed).toMatchObject({ action: "hold", armBreakeven: true });
    const under = assessStrategyExit({ ...base, mark: 1.035, netPnlUsd: 1.49, meta: meta() });
    expect(under.armBreakeven).toBe(false);
    const back = assessStrategyExit({ ...base, mark: 1.006, netPnlUsd: 0, meta: meta({ breakevenArmed: true }) });
    expect(back).toMatchObject({ action: "exit", code: "BREAKEVEN_STOP" });
    // Not armed: a flat trade is just held.
    expect(assessStrategyExit({ ...base, mark: 1.006, netPnlUsd: 0, meta: meta() }).action).toBe("hold");
  });

  it("closes at the time limit on a fresh mark only", () => {
    const late = { ...base, openedAt: now - 600_000, mark: 1.002, netPnlUsd: -0.2 };
    expect(assessStrategyExit({ ...late, meta: meta() })).toMatchObject({ action: "exit", code: "TIME_LIMIT" });
    expect(assessStrategyExit({ ...late, openedAt: now - 599_999, meta: meta() }).action).toBe("hold");
    expect(assessStrategyExit({ ...late, markFresh: false, meta: meta() }).action).toBe("hold");
  });

  it("never takes profit, breaks even or times out on a stale or missing price", () => {
    const stale = { ...base, markFresh: false };
    expect(assessStrategyExit({ ...stale, mark: 1.2, netPnlUsd: null, meta: meta() }).action).toBe("hold");
    expect(assessStrategyExit({ ...stale, mark: 1.2, netPnlUsd: 9, meta: meta() }).action).toBe("hold");
    expect(assessStrategyExit({ ...stale, mark: 1, netPnlUsd: 0, meta: meta({ breakevenArmed: true }) }).action).toBe("hold");
    expect(assessStrategyExit({ ...base, mark: 0, netPnlUsd: null, meta: meta() }).action).toBe("hold");
    expect(assessStrategyExit({ ...base, mark: Number.NaN, netPnlUsd: null, meta: meta() }).action).toBe("hold");
  });

  it("checks the stop before the target", () => {
    // A contradictory read: through the stop but a positive net. The stop wins.
    expect(assessStrategyExit({ ...base, mark: 0.98, netPnlUsd: 5, meta: meta() }).code).toBe("STRATEGY_STOP");
  });
});
