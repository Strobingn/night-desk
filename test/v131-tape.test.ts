import { describe, expect, it } from "vitest";
import { coinCards, parseTapeSort, sortCoins } from "../web/src/coins";
import type { FeedEvent } from "../src/types";

let n = 0;
const scout = (ts: number, mint: string, vol: string, extra = ""): FeedEvent => ({ id: `e${n++}`, ts, stage: "scout", kind: "info", mint, symbol: mint, message: `Scout found ${mint} on pumpfun. Mark 0.001, 1h volume $${vol}${extra}.`, detail: "pumpfun" });

describe("v13.1 tape: volume first", () => {
  const events = [
    scout(1, "A", "5,000.00"),
    scout(2, "B", "250,000.00", ", 5m volume $12,000.00, 1h change +18.4%"),
    scout(3, "C", "40,000.00", ", 1h change -6.0%"),
    { id: "x", ts: 4, stage: "analyst", kind: "pass", mint: "A", symbol: "A", detail: "0.71", message: "Analyst scored A 0.71." } as FeedEvent,
    scout(5, "D", "0.00")
  ];
  const rows = coinCards(events, new Set());

  it("parses 5m volume and 1h change, and ranks by 1h volume", () => {
    const by = Object.fromEntries(rows.map((r) => [r.mint, r]));
    expect(by.B.vol1h).toBe(250_000);
    expect(by.B.vol5m).toBe(12_000);
    expect(by.B.change1h).toBeCloseTo(18.4);
    expect(by.C.change1h).toBeCloseTo(-6);
    expect(by.B.volRank).toBe(1);
    expect(by.C.volRank).toBe(2);
    expect(by.A.volRank).toBe(3);
    expect(by.D.volRank).toBeUndefined();
  });

  it("sorts Newest by default, and still sorts Volume and Score", () => {
    expect(parseTapeSort(null)).toBe("newest");
    expect(parseTapeSort("junk")).toBe("newest");
    expect(parseTapeSort("volume")).toBe("volume");
    expect(sortCoins(rows, "volume").map((r) => r.mint)).toEqual(["B", "C", "A", "D"]);
    expect(sortCoins(rows, "newest").map((r) => r.mint)).toEqual(["D", "A", "C", "B"]);
    expect(sortCoins(rows, "score")[0].mint).toBe("A");
  });

  it("falls back to the move since first sighting when the feed has no change", () => {
    const r = coinCards([scout(1, "Z", "1,000.00"), { ...scout(2, "Z", "1,500.00"), message: "Scout found Z on pumpfun. Mark 0.0015, 1h volume $1,500.00." }], new Set());
    expect(r[0].change1h).toBeCloseTo(50);
  });
});
