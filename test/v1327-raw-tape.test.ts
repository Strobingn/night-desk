import { describe, expect, it } from "vitest";
import { Scout } from "../src/agents/scout.js";
import { EventBus } from "../src/bus.js";
import { makeToken } from "../src/demo/tokens.js";
import { RawTape, draftFromRaw, rawCandidate } from "../src/desk/raw-tape.js";
import type { DeskEvents, RawSighting } from "../src/types.js";
import { testDesk } from "./helpers.js";

const MINT = "RawMint111111111111111111111111111111111";

function sighting(over: Partial<RawSighting> = {}): RawSighting {
  return {
    mint: MINT,
    symbol: "RAW",
    name: "Raw Coin",
    source: "pumpfun",
    observedAt: 1_700_000_000_000,
    volume1hUsd: 4_200,
    priceUsd: 0.0004,
    liquidityUsd: 9_000,
    marketCapUsd: 40_000,
    ...over
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("v13.27 raw sightings publish a Tape row", () => {
  it("dedupes by mint and does not call RPC to publish", () => {
    const tape = new RawTape({ flushMs: 0 });
    const order: string[] = [];
    const bus = new EventBus<DeskEvents>();
    const hang = deferred();
    const scout = new Scout({
      bus,
      feedMode: "live",
      demo: false,
      pumpWsUrl: "ws://unused",
      enrichConcurrency: 1,
      queueCap: 8,
      fetchImpl: async () => {
        order.push("fetch");
        await hang.promise;
        return Response.json({ pairs: [] });
      },
      onTape: (row) => {
        order.push("tape");
        tape.observe(row);
      },
      onStatus: () => {}
    });
    const raw = sighting();
    scout.ingest(raw);
    scout.ingest({ ...raw, volume1hUsd: 8_000 });
    scout.ingest({ ...raw, symbol: "RAW" });
    const rows = tape.view();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mint: MINT,
      symbol: "RAW",
      name: "Raw Coin",
      source: "pumpfun",
      volume1hUsd: 8_000,
      priceUsd: 0.0004,
      liquidityUsd: 9_000,
      marketCapUsd: 40_000,
      enrich: "pending"
    });
    expect(order[0]).toBe("tape");
    expect(order.filter((step) => step === "fetch")).toHaveLength(1);
    expect(scout.status.sightings).toBe(1);
    hang.resolve();
    scout.stop();
    tape.stop();
  });

  it("keeps a queue-overflow row and upgrades the ones that enrich", async () => {
    const gate = deferred();
    const tape = new RawTape({ flushMs: 0 });
    const bus = new EventBus<DeskEvents>();
    const published: string[] = [];
    bus.on("scout.candidate", (token) => {
      published.push(token.mint);
      tape.markEnriched(token);
    });
    const scout = new Scout({
      bus,
      feedMode: "live",
      demo: false,
      pumpWsUrl: "ws://unused",
      enrichConcurrency: 1,
      queueCap: 2,
      fetchImpl: async () => {
        await gate.promise;
        return Response.json({ pairs: [] });
      },
      onTape: (row) => tape.observe(row),
      onStatus: () => {}
    });
    for (const mint of ["a", "b", "c", "d"]) {
      scout.ingest({ mint, symbol: mint.toUpperCase(), source: "pumpfun", observedAt: Date.now(), volume1hUsd: 10 });
    }
    const dropped = tape.view().find((row) => row.mint === "b");
    expect(dropped?.enrich).toBe("queue_full");
    expect(tape.view().map((row) => row.mint).sort()).toEqual(["a", "b", "c", "d"]);
    expect(published).toEqual([]);

    gate.resolve();
    await waitFor(() => published.length === 3);
    expect(published).toEqual(["a", "c", "d"]);
    const after = Object.fromEntries(tape.view().map((row) => [row.mint, row.enrich]));
    expect(after.b).toBe("queue_full");
    expect(after.a).toBe("enriched");
    expect(after.c).toBe("enriched");
    expect(after.d).toBe("enriched");
    scout.stop();
    tape.stop();
  });

  it("collapses a burst into one flush and drops the oldest past the cap", async () => {
    let flushes = 0;
    const tape = new RawTape({ flushMs: 40, cap: 3, onFlush: () => { flushes += 1; } });
    for (let i = 0; i < 5; i += 1) tape.observe(draftFromRaw(sighting({ mint: `m${i}`, observedAt: i + 1 }), "pending"));
    expect(flushes).toBe(0);
    expect(tape.view().map((row) => row.mint)).toEqual(["m4", "m3", "m2"]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(flushes).toBe(1);
    tape.observe(draftFromRaw(sighting({ mint: "m3", volume1hUsd: 99_000 }), "pending"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(flushes).toBe(2);
    expect(tape.get("m3")?.volume1hUsd).toBe(99_000);
    tape.stop();
  });

  it("does not auto-buy a raw row, quotes on a manual tap, and upgrades in place", async () => {
    let fetches = 0;
    const desk = testDesk({}, {
      priceFetch: async () => {
        fetches += 1;
        return Response.json({});
      }
    });
    try {
      const before = desk.snapshot();
      const good = makeToken({ mint: MINT, symbol: "RAW", name: "Raw Coin" });
      desk.noteRawSighting(sighting());
      await new Promise((resolve) => setTimeout(resolve, 30));
      const pending = desk.snapshot();
      expect(pending.pipeline.scouted).toBe(0);
      expect(pending.positions).toHaveLength(0);
      expect(pending.cashUsd).toBe(before.cashUsd);
      expect(pending.equityUsd).toBe(before.equityUsd);
      const pendingRow = pending.rawTape?.[0];
      expect(pendingRow).toMatchObject({ mint: MINT, enrich: "pending", symbol: "RAW" });
      expect(rawCandidate(pendingRow!).priceUsd).toBe(0);

      const beforeFetch = fetches;
      const bought = await desk.manualBuy(MINT, 5, { book: "paper" });
      expect(bought.ok).toBe(false);
      expect(fetches).toBeGreaterThan(beforeFetch);
      expect(desk.snapshot().positions).toHaveLength(0);
      expect(desk.snapshot().cashUsd).toBe(before.cashUsd);

      const killed = makeToken({
        mint: MINT,
        symbol: "RAW",
        name: "Raw Coin",
        mintAuthorityRevoked: false,
        priceUsd: 0.2,
        volume1hUsd: 50_000
      });
      await desk.submitCandidate(killed);
      const row = desk.snapshot().rawTape?.find((item) => item.mint === MINT);
      expect(row?.enrich).toBe("enriched");
      expect(row?.priceUsd).toBe(0.2);
      expect(desk.snapshot().positions).toHaveLength(0);
      expect(desk.snapshot().events.some((event) => event.mint === MINT && event.stage === "filter" && event.kind === "reject")).toBe(true);
      expect(desk.snapshot().pipeline.fills).toBe(0);
    } finally {
      desk.stop();
    }
  });
});

async function waitFor(done: () => boolean): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for scout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
