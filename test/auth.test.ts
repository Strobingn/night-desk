import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/server/http.js";
import { isDeskAuthorized, readCookie, resolveDeskToken } from "../src/server/auth.js";
import { testDesk } from "./helpers.js";

describe("desk token gate", () => {
  it("stays open when DESK_TOKEN is unset or blank", () => {
    expect(resolveDeskToken(undefined)).toBeUndefined();
    expect(resolveDeskToken("   ")).toBeUndefined();
    expect(loadConfig({}).deskToken).toBeUndefined();
    expect(isDeskAuthorized(undefined, {})).toBe(true);
  });

  it("accepts the header, the query, or the cookie, and rejects anything else", () => {
    const expected = "secret";
    expect(isDeskAuthorized(expected, { header: "secret" })).toBe(true);
    expect(isDeskAuthorized(expected, { query: "secret" })).toBe(true);
    expect(isDeskAuthorized(expected, { cookie: "secret" })).toBe(true);
    expect(isDeskAuthorized(expected, { header: "nope" })).toBe(false);
    expect(isDeskAuthorized(expected, { query: "secret-extra" })).toBe(false);
    expect(isDeskAuthorized(expected, {})).toBe(false);
    expect(readCookie("a=1; desk_token=secret%2B1; b=2", "desk_token")).toBe("secret+1");
  });

  const open: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
  });

  it("returns 401 without the token and serves API and UI with ?token=", async () => {
    const desk = testDesk();
    const ui = mkdtempSync(path.join(tmpdir(), "night-desk-ui-"));
    writeFileSync(path.join(ui, "index.html"), "<!doctype html><title>Night Desk</title><h1>Night Desk</h1>");
    const server = startServer(desk, "127.0.0.1", 0, "secret", ui);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    open.push({
      close: async () => {
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
        desk.stop();
      }
    });

    const bare = await fetch(`${base}/api/health`);
    expect(bare.status).toBe(401);
    const pageBare = await fetch(`${base}/`);
    expect(pageBare.status).toBe(401);

    const health = await fetch(`${base}/api/health?token=secret`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("paper");

    const header = await fetch(`${base}/api/state`, { headers: { "X-Desk-Token": "secret" } });
    expect(header.status).toBe(200);

    const page = await fetch(`${base}/?token=secret`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("set-cookie")).toMatch(/desk_token=/);
    const html = await page.text();
    expect(html).toMatch(/Night Desk/);

    const wrong = await fetch(`${base}/api/health?token=wrong`);
    expect(wrong.status).toBe(401);

    const crossSite = await fetch(`${base}/api/settings`, {
      method: "POST", headers: { cookie: "desk_token=secret", origin: "https://untrusted.example", "content-type": "application/json" },
      body: JSON.stringify({ minVolume1hUsd: 1000 })
    });
    expect(crossSite.status).toBe(403);
    expect(desk.config.rules.minVolume1hUsd).toBe(50000);

    const malformed = await fetch(`${base}/api/settings`, {
      method: "POST", headers: { "X-Desk-Token": "secret", "content-type": "application/json" }, body: "{"
    });
    expect(malformed.status).toBe(400);
    const nullFloor = await fetch(`${base}/api/settings`, {
      method: "POST", headers: { "X-Desk-Token": "secret", "content-type": "application/json" },
      body: JSON.stringify({ minVolume1hUsd: null })
    });
    expect(nullFloor.status).toBe(400);
  });

  it("returns 503 for the page when the UI build is missing", async () => {
    const desk = testDesk();
    const ui = mkdtempSync(path.join(tmpdir(), "night-desk-empty-ui-"));
    const server = startServer(desk, "127.0.0.1", 0, "secret", ui);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    open.push({
      close: async () => {
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
        desk.stop();
      }
    });
    const page = await fetch(`http://127.0.0.1:${port}/?token=secret`);
    expect(page.status).toBe(503);
    expect(await page.text()).toMatch(/UI build missing/);
  });
});
