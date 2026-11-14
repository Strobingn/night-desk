import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type DeskConfig } from "../src/config.js";
import { Desk } from "../src/desk/orchestrator.js";
import { resolveRules } from "../src/rules.js";

export function testConfig(overrides: Partial<DeskConfig> = {}): DeskConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "night-desk-"));
  const base = loadConfig({
    LIVE_TRADING: "false",
    DEMO_FEED: "0",
    FEED_MODE: "replay",
    PAPER_RESET: "1",
    PAPER_BALANCE_USD: "10000"
  });
  return {
    ...base,
    dbPath: path.join(dir, "desk.sqlite"),
    jsonlPath: path.join(dir, "desk.jsonl"),
    logPath: path.join(dir, "desk.log"),
    advisorPath: path.join(dir, "advisor.json"),
    openaiApiKey: undefined,
    demoFeed: false,
    feedMode: "replay",
    resetPaper: true,
    rules: resolveRules({}),
    ...overrides
  };
}

export function testDesk(overrides: Partial<DeskConfig> = {}, deps: { priceFetch?: typeof fetch } = {}): Desk {
  return new Desk(testConfig(overrides), deps);
}

/** Injected sell quote so an engine live buy test does not call Jupiter. */
export function engineSellRouteStub(): Promise<"route"> {
  return Promise.resolve("route");
}
