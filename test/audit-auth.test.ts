import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveLiveExecution } from "../src/market/live-options.js";
import { deskSessionCookie, requestOriginAllowed } from "../src/server/auth.js";
import { startServer } from "../src/server/http.js";
import type { Desk } from "../src/desk/orchestrator.js";

const request = (headers: IncomingMessage["headers"]) => ({ headers } as IncomingMessage);

describe("server exposure and origins", () => {
  it("binds an unconfigured desk to localhost", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });
  it("requires a token before binding publicly", () => {
    expect(() => startServer({} as Desk, "0.0.0.0", 4721)).toThrow(/DESK_TOKEN/);
    expect(() => startServer({} as Desk, "::", 4721)).toThrow(/DESK_TOKEN/);
  });
  it("rejects cross-site cookie POSTs and WebSocket handshakes", () => {
    expect(requestOriginAllowed(request({ host: "desk.example", origin: "https://evil.example" }), false)).toBe(false);
    expect(requestOriginAllowed(request({ host: "desk.example", origin: "null" }), false)).toBe(false);
    expect(requestOriginAllowed(request({ host: "desk.example", "sec-fetch-site": "cross-site" }), false)).toBe(false);
    expect(requestOriginAllowed(request({ host: "desk.example", origin: "https://desk.example" }), false)).toBe(true);
    expect(requestOriginAllowed(request({ host: "desk.example" }), false)).toBe(true);
  });
  it("rejects DNS rebinding into a tokenless localhost desk", () => {
    expect(requestOriginAllowed(request({ host: "evil.example:4721" }), true)).toBe(false);
    expect(requestOriginAllowed(request({ host: "127.0.0.1:4721", origin: "http://127.0.0.1:4721" }), true)).toBe(true);
  });
  it("uses an HttpOnly strict session cookie", () => {
    expect(deskSessionCookie("secret")).toMatch(/HttpOnly; SameSite=Strict/);
    expect(deskSessionCookie("secret", true)).toMatch(/; Secure$/);
  });
});

describe("execution configuration", () => {
  it("keeps fees disabled and RPC transport by default", () => {
    expect(resolveLiveExecution({})).toMatchObject({ transport: "rpc", slippageBps: 100, platformFeeBps: 0 });
    expect(loadConfig({}).mode).toBe("paper");
  });
  it.each([
    { PLATFORM_FEE_BPS: "85" }, { LIVE_SLIPPAGE_BPS: "1500" },
    { LIVE_MAX_PRICE_IMPACT_BPS: "NaN" }, { JITO_TIP_LAMPORTS: "999999999" },
    { LIVE_EXECUTION_TRANSPORT: "other" }, { JITO_BLOCK_ENGINE_URL: "http://jito.test" }
  ])("rejects invalid options instead of silently loosening risk: %j", (env) => {
    expect(() => resolveLiveExecution(env)).toThrow();
  });
  it("disables replay and ignores PAPER_RESET when real trading is armed", () => {
    expect(loadConfig({ LIVE_TRADING: "true", WALLET_KEYPAIR_PATH: "/unused", DEMO_FEED: "1", FEED_MODE: "replay", PAPER_RESET: "1" }))
      .toMatchObject({ mode: "live", demoFeed: false, feedMode: "live", resetPaper: false });
  });
});
