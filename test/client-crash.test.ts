import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { Desk } from "../src/desk/orchestrator.js";
import { startServer } from "../src/server/http.js";
import { testConfig } from "./helpers.js";

describe("client crash reports", () => {
  it("stores the stack and keeps recap and state totals typed", async () => {
    const cfg = testConfig();
    const desk = new Desk(cfg);
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const missing = await fetch(`${base}/api/client-crash`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "v9" })
      });
      expect(missing.status).toBe(400);

      const posted = await fetch(`${base}/api/client-crash`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: "v9",
          stack: "java.lang.IllegalArgumentException: Key was already used\n\tat Tape"
        })
      });
      expect(posted.status).toBe(200);
      expect(await posted.json()).toEqual({ ok: true });

      const log = readFileSync(cfg.logPath, "utf8");
      expect(log).toMatch(/CLIENT_CRASH/);
      expect(log).toMatch(/Key was already used/);
      expect(log).toMatch(/Android client crash v9/);

      for (const since of ["12h", "24h", "7d", "reset"]) {
        const recap = await fetch(`${base}/api/recap?since=${since}`);
        expect(recap.status).toBe(200);
        const body = (await recap.json()) as { closed: unknown; closedCount: unknown; text: unknown };
        expect(Array.isArray(body.closed)).toBe(true);
        expect(typeof body.closedCount).toBe("number");
        expect(typeof body.text).toBe("string");
      }

      const state = await fetch(`${base}/api/state`);
      expect(state.status).toBe(200);
      const snap = (await state.json()) as {
        equityUsd: unknown;
        cashUsd: unknown;
        positions: unknown;
        events: unknown;
        closed: unknown;
        rules: { stopLossPct?: unknown };
      };
      expect(typeof snap.equityUsd).toBe("number");
      expect(typeof snap.cashUsd).toBe("number");
      expect(Array.isArray(snap.positions)).toBe(true);
      expect(Array.isArray(snap.events)).toBe(true);
      expect(Array.isArray(snap.closed)).toBe(true);
      expect(snap.rules.stopLossPct).toBe(0.06);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      desk.stop();
    }
  });
});
