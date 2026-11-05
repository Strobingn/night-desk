import { describe, expect, it } from "vitest";
import { Scout } from "../src/agents/scout.js";
import { EventBus } from "../src/bus.js";
import type { DeskEvents } from "../src/types.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("scout enrich drain", () => {
  it("never exceeds the concurrency cap and still finishes the queue", async () => {
    const gate = deferred();
    let active = 0;
    let max = 0;
    const bus = new EventBus<DeskEvents>();
    const published: string[] = [];
    bus.on("scout.candidate", (token) => {
      published.push(token.mint);
    });
    const scout = new Scout({
      bus,
      feedMode: "live",
      demo: false,
      pumpWsUrl: "ws://unused",
      enrichConcurrency: 3,
      queueCap: 50,
      fetchImpl: async () => {
        active += 1;
        max = Math.max(max, active);
        await gate.promise;
        active -= 1;
        return Response.json({ pairs: [] });
      },
      onStatus: () => {}
    });

    for (let i = 0; i < 9; i += 1) scout.ingest({ mint: `mint-${i}`, source: "pumpfun", observedAt: Date.now() });
    expect(max).toBe(3);
    expect(scout.status.dropped).toBe(0);
    expect(scout.status.sightings).toBe(9);

    gate.resolve();
    await waitFor(() => published.length === 9);
    expect(max).toBe(3);
    expect(published).toHaveLength(9);
    expect(scout.status.enriched).toBe(9);
    scout.stop();
  });

  it("drops the oldest queued sighting once the queue cap is full", async () => {
    const gate = deferred();
    const bus = new EventBus<DeskEvents>();
    const published: string[] = [];
    bus.on("scout.candidate", (token) => {
      published.push(token.mint);
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
      onStatus: () => {}
    });

    for (const mint of ["a", "b", "c", "d"]) {
      scout.ingest({ mint, source: "pumpfun", observedAt: Date.now() });
    }
    expect(scout.status.sightings).toBe(4);
    expect(scout.status.dropped).toBe(1);

    gate.resolve();
    await waitFor(() => published.length === 3);
    expect(published).toEqual(["a", "c", "d"]);
    scout.stop();
  });

  it("keeps a burst of the same mint to one tape line", async () => {
    const bus = new EventBus<DeskEvents>();
    const published: string[] = [];
    bus.on("scout.candidate", (token) => {
      published.push(token.mint);
    });
    const scout = new Scout({
      bus,
      feedMode: "live",
      demo: false,
      pumpWsUrl: "ws://unused",
      enrichConcurrency: 4,
      fetchImpl: async () => Response.json({ pairs: [] }),
      onStatus: () => {}
    });
    const mint = "SameMint1111111111111111111111111111111111";
    for (let i = 0; i < 4; i += 1) scout.ingest({ mint, symbol: "SAME", source: "pumpfun", observedAt: Date.now() });
    expect(scout.status.sightings).toBe(1);
    await waitFor(() => published.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(published).toEqual([mint]);
    scout.stop();
  });

  it("fills 1h volume from a later listing when the first pass had none", async () => {
    const bus = new EventBus<DeskEvents>();
    const volumes: number[] = [];
    bus.on("scout.candidate", (token) => {
      volumes.push(token.volume1hUsd);
    });
    const scout = new Scout({
      bus,
      feedMode: "live",
      demo: false,
      pumpWsUrl: "ws://unused",
      fetchImpl: async () => Response.json({ pairs: [] }),
      onStatus: () => {}
    });
    const mint = "VolMint11111111111111111111111111111111111";
    scout.ingest({ mint, symbol: "VOL", source: "pumpfun", observedAt: Date.now() });
    await waitFor(() => volumes.length === 1);
    scout.ingest({ mint, symbol: "VOL", source: "raydium", observedAt: Date.now(), volume1hUsd: 12_500, priceUsd: 0.01 });
    await waitFor(() => volumes.length === 2);
    expect(volumes).toEqual([0, 12_500]);
    scout.stop();
  });
});

async function waitFor(done: () => boolean): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for scout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
