import { describe, expect, it } from "vitest";
import { evaluateFilter } from "../src/agents/filter.js";
import { makeToken } from "../src/demo/tokens.js";
import { classifyNearMiss } from "../src/desk/near-miss.js";
import { DEMO_RUG_WALLET } from "../src/market/rug-registry.js";
import { resolveRules } from "../src/rules.js";
import { testDesk } from "./helpers.js";

const rules = resolveRules({});
const cleanRug = { status: "clean" as const };

function near(desk: ReturnType<typeof testDesk>, mint: string) {
  return desk.snapshot().advice.find((note) => note.stance === "near-miss" && note.mint === mint);
}

describe("near miss your call", () => {
  it("classifies a slightly high top-10 and a slightly low volume, and nothing harder", () => {
    const holders = evaluateFilter(makeToken({ top10HolderPct: 0.38 }), cleanRug, rules);
    expect(classifyNearMiss(holders, rules)?.code).toBe("HOLDER_CONCENTRATION");
    const tooHigh = evaluateFilter(makeToken({ top10HolderPct: 0.5 }), cleanRug, rules);
    expect(classifyNearMiss(tooHigh, rules)).toBeNull();
    const unknown = evaluateFilter(makeToken({ top10HolderPct: null }), cleanRug, rules);
    expect(classifyNearMiss(unknown, rules)).toBeNull();
    const volume = evaluateFilter(makeToken({ volume1hUsd: 8_000 }), cleanRug, rules);
    expect(classifyNearMiss(volume, rules)?.code).toBe("VOLUME_TOO_LOW");
    const thin = evaluateFilter(makeToken({ volume1hUsd: 2_500 }), cleanRug, rules);
    expect(classifyNearMiss(thin, rules)).toBeNull();
    const both = evaluateFilter(makeToken({ top10HolderPct: 0.38, volume1hUsd: 8_000 }), cleanRug, rules);
    expect(classifyNearMiss(both, rules)).toBeNull();
    const mint = evaluateFilter(makeToken({ mintAuthorityRevoked: false }), cleanRug, rules);
    expect(classifyNearMiss(mint, rules)).toBeNull();
    const rug = evaluateFilter(
      makeToken({ devWallet: DEMO_RUG_WALLET }),
      { status: "rugged", evidence: "dev rug" },
      rules
    );
    expect(classifyNearMiss(rug, rules)).toBeNull();
    const unlocked = evaluateFilter(makeToken({ lpLockedOrBurned: false }), cleanRug, rules);
    expect(classifyNearMiss(unlocked, rules)).toBeNull();
  });

  it("posts one card after price and volume rise, and does not auto-buy", async () => {
    const desk = testDesk();
    const mint = "NearHold11111111111111111111111111111111";
    await desk.submitCandidate(makeToken({ mint, symbol: "NEAR", top10HolderPct: 0.38, priceUsd: 0.001, volume1hUsd: 180_000 }));
    expect(near(desk, mint)).toBeUndefined();
    expect(desk.snapshot().positions).toHaveLength(0);
    await desk.submitCandidate(makeToken({ mint, symbol: "NEAR", top10HolderPct: 0.38, priceUsd: 0.0012, volume1hUsd: 190_000 }));
    const note = near(desk, mint);
    expect(note?.code).toBe("HOLDER_CONCENTRATION");
    expect(note?.text).toContain("Near miss — your call");
    expect(note?.score).toBeGreaterThanOrEqual(0.5);
    expect(desk.snapshot().positions).toHaveLength(0);
    expect(desk.snapshot().pipeline.analystTrade).toBe(0);
    await desk.submitCandidate(makeToken({ mint, symbol: "NEAR", top10HolderPct: 0.38, priceUsd: 0.0014, volume1hUsd: 200_000 }));
    expect(desk.snapshot().advice.filter((row) => row.stance === "near-miss" && row.mint === mint)).toHaveLength(1);
  });

  it("posts a card for volume just under the floor", async () => {
    const desk = testDesk();
    const mint = "NearVol111111111111111111111111111111111";
    await desk.submitCandidate(makeToken({ mint, symbol: "SOFT", volume1hUsd: 8_000, priceUsd: 0.001 }));
    expect(near(desk, mint)).toBeUndefined();
    await desk.submitCandidate(makeToken({ mint, symbol: "SOFT", volume1hUsd: 8_500, priceUsd: 0.0011 }));
    expect(near(desk, mint)?.code).toBe("VOLUME_TOO_LOW");
    expect(desk.snapshot().positions).toHaveLength(0);
  });

  it("stays quiet when the print is not rising, is far over the cap, or is a hard kill", async () => {
    const desk = testDesk();
    const flat = "NearFlat11111111111111111111111111111111";
    await desk.submitCandidate(makeToken({ mint: flat, symbol: "FLAT", top10HolderPct: 0.38, priceUsd: 0.001, volume1hUsd: 180_000 }));
    await desk.submitCandidate(makeToken({ mint: flat, symbol: "FLAT", top10HolderPct: 0.38, priceUsd: 0.001, volume1hUsd: 180_000 }));
    expect(near(desk, flat)).toBeUndefined();

    const wide = "NearWide11111111111111111111111111111111";
    await desk.submitCandidate(makeToken({ mint: wide, symbol: "WIDE", top10HolderPct: 0.5, priceUsd: 0.001, volume1hUsd: 180_000 }));
    await desk.submitCandidate(makeToken({ mint: wide, symbol: "WIDE", top10HolderPct: 0.5, priceUsd: 0.002, volume1hUsd: 190_000 }));
    expect(near(desk, wide)).toBeUndefined();

    const auth = "NearAuth11111111111111111111111111111111";
    await desk.submitCandidate(makeToken({ mint: auth, symbol: "AUTH", mintAuthorityRevoked: false, priceUsd: 0.001 }));
    await desk.submitCandidate(makeToken({ mint: auth, symbol: "AUTH", mintAuthorityRevoked: false, priceUsd: 0.002, volume1hUsd: 200_000 }));
    expect(near(desk, auth)).toBeUndefined();

    const rug = "NearRug111111111111111111111111111111111";
    await desk.submitCandidate(makeToken({ mint: rug, symbol: "RUG", devWallet: DEMO_RUG_WALLET, priceUsd: 0.001 }));
    await desk.submitCandidate(makeToken({ mint: rug, symbol: "RUG", devWallet: DEMO_RUG_WALLET, priceUsd: 0.002, volume1hUsd: 200_000 }));
    expect(near(desk, rug)).toBeUndefined();
    expect(desk.snapshot().positions).toHaveLength(0);
  });

  it("fills a one-tap buy at the cap and counts the near miss when it closes", async () => {
    const desk = testDesk();
    const mint = "NearBuy111111111111111111111111111111111";
    await desk.submitCandidate(makeToken({ mint, symbol: "CALL", volume1hUsd: 8_000, priceUsd: 1 }));
    await desk.submitCandidate(makeToken({ mint, symbol: "CALL", volume1hUsd: 8_500, priceUsd: 1.1 }));
    expect(near(desk, mint)?.code).toBe("VOLUME_TOO_LOW");
    const bought = await desk.manualBuy(mint);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    expect(bought.sizeUsd).toBe(800);
    expect(near(desk, mint)).toBeUndefined();
    const pos = desk.snapshot().positions.find((row) => row.mint === mint);
    expect(pos?.entry).toBe("manual");
    expect(pos?.score).toBeGreaterThan(0);
    await desk.markPrice(mint, 1.4);
    const closed = await desk.closePosition(mint);
    expect(closed.ok).toBe(true);
    const lines = await desk.commentOnce();
    expect(lines.some((line) => line.includes("Near-miss record: surfaced 1, taken 1, wins 1, losses 0"))).toBe(true);
  });
});
