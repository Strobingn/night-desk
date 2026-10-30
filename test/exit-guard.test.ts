import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { assertNonNegativeFinite, exitImpactAllowed, quotePaperSell, slippageFor } from "../src/agents/execution-math.js";
import { makeToken } from "../src/demo/tokens.js";
import { startServer } from "../src/server/http.js";
import { testDesk } from "./helpers.js";

describe("paper exit proceeds stay non-negative", () => {
  it("does not ceil a sub-cent sale into a negative proceed", () => {
    // qty * mark = $0.0001. The old 10 bps fee ceiled to $0.01 and floorUsd(gross - fee) was -$0.01.
    const dust = quotePaperSell(0.000001, 100, 50_000);
    expect(dust.ok).toBe(true);
    expect(dust.fillPrice).toBeGreaterThan(0);
    expect(Number.isFinite(dust.fillPrice)).toBe(true);
    expect(dust.feeUsd).toBe(0);
    expect(dust.proceedsUsd).toBe(0);
    expect(dust.proceedsUsd).toBeGreaterThanOrEqual(0);
  });

  it("books a zero fill when the mark or the pool cannot be priced", () => {
    for (const quote of [quotePaperSell(Number.NaN, 10, 1_000), quotePaperSell(-1, 10, 1_000), quotePaperSell(1, 10, 0)]) {
      expect(quote.fillPrice).toBeGreaterThanOrEqual(0);
      expect(quote.proceedsUsd).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(quote.fillPrice)).toBe(true);
      expect(Number.isFinite(quote.proceedsUsd)).toBe(true);
    }
  });

  it("asserts that a negative or NaN book figure is not a fill", () => {
    expect(() => assertNonNegativeFinite("proceedsUsd", -0.01)).toThrow(/proceedsUsd/);
    expect(() => assertNonNegativeFinite("fillPrice", Number.NaN)).toThrow(/fillPrice/);
    expect(() => assertNonNegativeFinite("fillPrice", Number.POSITIVE_INFINITY)).toThrow(/fillPrice/);
  });

  it("lets sell impact follow pool depth past the old 50% ceiling", () => {
    const raw = slippageFor(5_000, 1_000, "sell");
    expect(raw).toBeGreaterThan(0.5);
    expect(raw).toBeLessThan(1);
    const quote = quotePaperSell(1, 5_000, 1_000);
    expect(quote.fillPrice).toBeGreaterThanOrEqual(0);
    expect(quote.proceedsUsd).toBeGreaterThanOrEqual(0);
    expect(quote.slippage).toBeGreaterThan(0.5);
  });
});

describe("exit impact gate", () => {
  it("refuses a buy whose full exit costs more than the entry cap plus a few percent", () => {
    const gate = exitImpactAllowed(800, 16_000, 0.03);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe("EXIT_IMPACT");
      expect(gate.slippage).toBeGreaterThan(0.06);
      expect(gate.message).toContain("Buy refused.");
      expect(gate.message).toContain("full exit");
    }
    const deep = exitImpactAllowed(800, 100_000, 0.03);
    expect(deep.ok).toBe(true);
  });

  it("still refuses on entry slippage when the exit itself is inside the slack", async () => {
    const desk = testDesk();
    const mint = "EntryOnly11111111111111111111111111111111";
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "MID", priceUsd: 1, liquidityUsd: 40_000 }));
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "ENTRY_SLIPPAGE" && event.message.includes("Buy refused"))).toBe(true);
      expect(desk.snapshot().events.some((event) => event.code === "EXIT_IMPACT")).toBe(false);
    } finally {
      desk.stop();
    }
  });

  it("closes a crashed mark with non-negative proceeds and logs the stop against the fill", async () => {
    const desk = testDesk();
    const mint = "Bh6VcHSTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "SPERM", priceUsd: 1, liquidityUsd: 180_000 }));
      const open = desk.book.positions.get(mint);
      expect(open).toBeTruthy();
      const cashBefore = desk.book.cashUsd;
      await desk.markPrice(mint, 1e-8);
      expect(desk.book.positions.has(mint)).toBe(true);
      await desk.markPrice(mint, 1e-8);
      expect(desk.book.positions.has(mint)).toBe(false);
      const closed = desk.snapshot().closed.find((trade) => trade.mint === mint);
      expect(closed?.proceedsUsd).toBeGreaterThanOrEqual(0);
      expect(closed?.proceedsUsd).not.toBe(-0.01);
      expect(desk.book.cashUsd).toBeGreaterThanOrEqual(cashBefore);
      const logged = desk.snapshot().events.find((event) => event.code === "STOP_LOSS" && event.message.includes("Stop trigger"));
      expect(logged?.message).toMatch(/Stop trigger .+ vs fill .+/);
      expect(desk.snapshot().events.some((event) => event.kind === "fill" && event.message.includes("Stop trigger") && event.message.includes("vs fill"))).toBe(true);
    } finally {
      desk.stop();
    }
  });

  it("keeps the hard-stop ban on auto buys and lets a confirmed manual buy through", async () => {
    const desk = testDesk();
    const mint = "BanMint111111111111111111111111111111111";
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      await desk.submitCandidate(makeToken({ mint, symbol: "BAN", priceUsd: 1, liquidityUsd: 180_000 }));
      await desk.markPrice(mint, 0.9);
      expect(desk.book.positions.has(mint)).toBe(false);
      const row = desk.snapshot().cooldowns.find((item) => item.mint === mint);
      expect(row?.minutesLeft).toBeGreaterThanOrEqual(359);

      await desk.submitCandidate(makeToken({ mint, symbol: "BAN", priceUsd: 1, liquidityUsd: 180_000 }));
      expect(desk.book.positions.has(mint)).toBe(false);
      expect(desk.snapshot().events.some((event) => event.code === "REVENGE_COOLDOWN")).toBe(true);

      const blocked = await fetch(`http://127.0.0.1:${port}/api/positions/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint, sizeUsd: 10, ignoreCooldown: "true" })
      });
      expect(blocked.status).toBe(400);
      const blockedBody = (await blocked.json()) as { code?: string; error?: string };
      expect(blockedBody.code).toBe("REVENGE_COOLDOWN");
      expect(blockedBody.error).toContain("minute");
      expect(desk.book.positions.has(mint)).toBe(false);

      const allowed = await fetch(`http://127.0.0.1:${port}/api/positions/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint, sizeUsd: 10, ignoreCooldown: true })
      });
      expect(allowed.status).toBe(200);
      expect(desk.book.positions.has(mint)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });
});
