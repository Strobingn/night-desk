import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Desk } from "../src/desk/orchestrator.js";
import { WS_BACKLOG_MAX, readPublicUrl, sendSnapshot, skipDuplicateSnapshot, startServer } from "../src/server/http.js";
import { testConfig } from "./helpers.js";

function fakeSocket(buffered: number) {
  const sent: string[] = [];
  return { readyState: 1, OPEN: 1, bufferedAmount: buffered, send: (d: string) => sent.push(d), sent };
}

describe("v12.2 phone connection", () => {
  it("a socket backed up past the backlog cap skips stale snapshots instead of queueing more", () => {
    const fast = fakeSocket(0);
    const slow = fakeSocket(WS_BACKLOG_MAX + 1);
    const closed = { ...fakeSocket(0), readyState: 3 };
    expect(sendSnapshot([fast, slow, closed], "{}")).toBe(1);
    expect(fast.sent).toHaveLength(1);
    expect(slow.sent).toHaveLength(0);
    expect(closed.sent).toHaveLength(0);
    slow.bufferedAmount = 0;
    expect(sendSnapshot([slow], "{}")).toBe(0);
    expect(slow.sent).toHaveLength(1);
  });

  it("keeps the drain retry when the next snapshot only moved the clock", () => {
    expect(skipDuplicateSnapshot("book", "book", false)).toBe(true);
    expect(skipDuplicateSnapshot("book", "book", true)).toBe(false);
    expect(skipDuplicateSnapshot("closed", "book", false)).toBe(false);
  });

  it("reads only an https trycloudflare URL from data/public-url.txt", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nd-url-"));
    const db = path.join(dir, "desk.sqlite");
    expect(readPublicUrl(db, 1)).toBeNull();
    writeFileSync(path.join(dir, "public-url.txt"), "https://deaths-fridge-portal-neck.trycloudflare.com\r\n");
    expect(readPublicUrl(db, 20_000)).toBe("https://deaths-fridge-portal-neck.trycloudflare.com");
    writeFileSync(path.join(dir, "public-url.txt"), "http://evil.example.com");
    expect(readPublicUrl(db, 40_000)).toBeNull();
  });

  it("health reports the public URL, the socket negotiates compression, and a sell keeps the socket open", async () => {
    const cfg = testConfig();
    writeFileSync(path.join(path.dirname(cfg.dbPath), "public-url.txt"), "https://deaths-fridge-portal-neck.trycloudflare.com");
    const desk = new Desk(cfg);
    const server = startServer(desk, "127.0.0.1", 0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: true });
    const opened = once(ws, "open");
    try {
      const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean; publicUrl: string | null };
      expect(health.ok).toBe(true);
      expect(health.publicUrl).toBe("https://deaths-fridge-portal-neck.trycloudflare.com");
      await opened;
      expect(ws.extensions).toContain("permessage-deflate");
      let closed = false;
      let messages = 0;
      ws.on("close", () => (closed = true));
      ws.on("message", () => (messages += 1));
      const { makeToken } = await import("../src/demo/tokens.js");
      const mint = "SellKeepsSocket111111111111111111111111111";
      await desk.submitCandidate(makeToken({ symbol: "KEEP", mint, source: "raydium" }));
      if (desk.book.positions.size) {
        const sold = await fetch(`${base}/api/positions/sell`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint, percent: 50 }) });
        expect(sold.status).toBe(200);
        const closeAll = await fetch(`${base}/api/positions/sell`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint, percent: 100 }) });
        expect(closeAll.status).toBe(200);
      }
      await new Promise((r) => setTimeout(r, 600));
      expect(closed).toBe(false);
      expect(messages).toBeGreaterThan(0);
    } finally {
      ws.close();
      server.close();
      desk.stop();
    }
  });
});
