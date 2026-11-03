import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { scoutSummary, shortPx, slipText, tapUsdText, SCOUT_OPEN_KEY } from "../web/src/tapeToolbar";

const src = (id: string, state: string, sightingsPerMin = 0) =>
  ({ id, label: id, enabled: true, state, detail: null, retryAt: null, failingSince: null, lastOkAt: null, reqPerMin: 0, budgetPerMin: null, limitPerMin: null, count429: 0, sightingsPerMin }) as never;

describe("v13.4 compact Tape toolbar", () => {
  it("collapses Scout status to one line with a red down count", () => {
    const sum = scoutSummary([src("pump", "live", 13), src("pumpapi", "down"), src("dex", "live", 30), src("bitquery", "off"), src("jup", "live", 6)]);
    expect(sum).toEqual({ text: "3/5 live · 49/min", badge: "1 down", tone: "down" });
    expect(scoutSummary([src("pump", "stale"), src("dex", "live")]).badge).toBe("1 slow");
    expect(scoutSummary([src("dex", "live")]).badge).toBeNull();
    expect(SCOUT_OPEN_KEY).toBe("nightdesk.tape.scoutOpen");
  });

  it("shows the one-tap chip as size and slip from the saved fraction", () => {
    expect(`⚡ ${tapUsdText(1223)} · slip ${slipText(0.085)}%`).toBe("⚡ $1223 · slip 8.5%");
    expect(tapUsdText(52)).toBe("$52.00");
    expect(slipText(0.03)).toBe("3");
    expect(shortPx(0.0000037051234)).toBe("0.0₅3705");
    expect(shortPx(1.23456)).toBe("1.235");
    expect(shortPx(Number.NaN)).toBe("—");
  });

  it("keeps every Tape control: sort options, verdict filters, view toggle, one-tap sheet", () => {
    const tape = readFileSync("web/src/screens/Tape.tsx", "utf8");
    for (const needle of ['aria-label="Tape sort"', "TAPE_SORTS.map", 'aria-label="Coin verdict"', "COIN_FILTERS.map", 'aria-label="Tape view"', 'aria-label="Log stage"', "<OneTapBar snap={snap} actions={actions} />", "<TapBuyButton", "<TapSellButton", "<ScoutStatus feed={snap.feed} compact />"]) {
      expect(tape).toContain(needle);
    }
  });
});
