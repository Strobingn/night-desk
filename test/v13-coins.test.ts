import { describe, expect, it } from "vitest";
import { coinCards, dayBase } from "../web/src/coins";
import type { FeedEvent } from "../src/types";

const ev = (over: Partial<FeedEvent>): FeedEvent => ({ id: Math.random().toString(36), ts: 1, stage: "scout", kind: "info", message: "", ...over });

describe("v13 tape coin cards", () => {
  it("folds scout, filter, analyst and open state into one card per mint", () => {
    const events = [
      ev({ ts: 10, mint: "A", symbol: "AAA", message: "Scout found AAA on pumpfun. Mark 0.00000572, 1h volume $5,866.81.", detail: "pumpfun" }),
      ev({ ts: 11, mint: "A", symbol: "AAA", stage: "filter", kind: "reject", code: "HOLDER_CONCENTRATION", detail: "HOLDER_CONCENTRATION, VOLUME_TOO_LOW", message: "Filter killed AAA. Top 10 holders control 27.2% of supply (limit 5.0%)." }),
      ev({ ts: 12, mint: "B", symbol: "BBB", message: "Scout found BBB on raydium. Mark 0.5, 1h volume $100.", detail: "raydium" }),
      ev({ ts: 13, mint: "B", symbol: "BBB", stage: "analyst", kind: "reject", code: "SCORE_BELOW_THRESHOLD", detail: "0.28", message: "Analyst scored BBB 0.28. No trade. Thin book." }),
      ev({ ts: 14, mint: "C", symbol: "CCC", stage: "analyst", kind: "pass", detail: "0.61", message: "Analyst scored CCC 0.61. Handing to Executor." }),
      ev({ ts: 99, mint: "D", symbol: "DDD", stage: "risk", kind: "reject", message: "Risk ignored a DDD mark" })
    ];
    const rows = coinCards(events, new Set(["D"]));
    const by = Object.fromEntries(rows.map((r) => [r.mint, r]));
    expect(rows[0].mint).toBe("C");
    expect(by.A.verdict).toBe("killed");
    expect(by.A.vol1h).toBeCloseTo(5866.81);
    expect(by.A.codes[0]).toBe("HOLDER_CONCENTRATION");
    expect(by.A.reason).toContain("Top 10 holders");
    expect(by.B.verdict).toBe("near");
    expect(by.B.score).toBeCloseTo(0.28);
    expect(by.B.reason).toBe("No trade. Thin book.");
    expect(by.C.verdict).toBe("trade");
    expect(by.D.verdict).toBe("open");
  });

  it("day base uses the last equity point before local midnight", () => {
    const now = new Date(2026, 9, 30, 13, 0).getTime();
    const mid = new Date(2026, 9, 30, 0, 0).getTime();
    expect(dayBase([{ t: mid - 1000, equity: 80 }, { t: mid + 1000, equity: 78 }], 100, now)).toBe(80);
    expect(dayBase([{ t: mid + 1000, equity: 78 }], 100, now)).toBe(78);
    expect(dayBase([], 100, now)).toBe(100);
  });
});
