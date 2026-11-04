/**
 * HTTP for desk alerts and the hot-coin scanner.
 * PumpCore calls this for paths it does not own. State is per core instance.
 */
import type { DatabaseSync } from "node:sqlite";
import { AlertEngine, type DeskAlert, type LiquidityDropNote } from "../alerts/engine.js";
import { sendFcm } from "../alerts/fcm.js";
import { countOwners, readPagedHolderCount, type HolderPage } from "../alerts/holders.js";
import { DEFAULT_NIGHT, inNightWindow, parseNight, type NightWindow } from "../alerts/night.js";
import { DEFAULT_RULES, parseRules, type AlertRule, type AlertSample } from "../alerts/rules.js";
import { webPushPayload } from "../alerts/webpush.js";
import { HotScanner, rowsFromBook } from "../scanner/scanner.js";
import type { PumpSafety } from "../safety.js";
import type { PumpCoin, TradeEvent, TradeIntent } from "../types.js";
import type { ScanInput } from "../scanner/score.js";

export interface PumpHttpResult {
  status: number;
  body: unknown;
}

export interface PumpHost {
  now: () => number;
  db: DatabaseSync;
  rpcUrl: string;
  safety: PumpSafety;
  prepare: (body: Record<string, unknown>) => Promise<TradeIntent>;
  listCoins: (limit: number) => PumpCoin[];
  recentTrades: (limit: number, mint?: string) => TradeEvent[];
  emitAlert: (input: { kind: DeskAlert["coreKind"]; mint?: string; message: string; data?: Record<string, unknown> }) => void;
}

interface ExtraState {
  engine: AlertEngine;
  scanner: HotScanner;
  night: NightWindow;
  fcmToken: string;
}

const states = new WeakMap<object, ExtraState>();

export async function routePumpExtras(
  core: object,
  method: string,
  path: string,
  url: URL,
  body: Record<string, unknown>,
  host: PumpHost
): Promise<PumpHttpResult | null> {
  const state = stateFor(core, host);
  if (path === "/api/pump/alert-rules" && method === "GET") return { status: 200, body: { ok: true, rules: state.engine.getRules() } };
  if (path === "/api/pump/alert-rules" && method === "POST") {
    const rules = parseRules(body.rules);
    if (!rules) return { status: 400, body: { ok: false, error: "rules must be a list of alert rules", code: "BAD_REQUEST" } };
    state.engine.setRules(rules);
    writeJson(host.db, "pumpAlertRules", rules);
    return { status: 200, body: { ok: true, rules: state.engine.getRules() } };
  }
  if (path === "/api/pump/night" && method === "GET") {
    return { status: 200, body: { ok: true, night: state.night, active: inNightWindow(state.night, new Date(host.now())) } };
  }
  if (path === "/api/pump/night" && method === "POST") {
    const night = parseNight(body.night ?? body);
    if (!night) return { status: 400, body: { ok: false, error: "night schedule needs startMin, endMin, and brightness", code: "BAD_REQUEST" } };
    state.night = night;
    writeJson(host.db, "pumpNight", night);
    return { status: 200, body: { ok: true, night, active: inNightWindow(night, new Date(host.now())) } };
  }
  if (path === "/api/pump/alert-holders" && method === "POST") {
    const mint = str(body.mint);
    if (!mint) return { status: 400, body: { ok: false, error: "mint is required", code: "BAD_REQUEST" } };
    const pages = Array.isArray(body.holderPages) ? (body.holderPages as HolderPage[]) : null;
    const read = pages
      ? { holderCount: countOwners(pages), pagesRead: pages.length, truncated: false }
      : await readPagedHolderCount({ rpcUrl: host.rpcUrl, mint, maxPages: limitPages(body.maxPages) });
    const sample: AlertSample = { mint, at: host.now(), holderCount: read.holderCount };
    const alerts = publish(state, host, sample);
    state.scanner.noteHolders(mint, read.holderCount);
    return { status: 200, body: { ok: true, ...read, alerts } };
  }
  if (path === "/api/pump/alert-eval" && method === "POST") {
    const sample = sampleOf(body.sample ?? body, host.now());
    if (!sample) return { status: 400, body: { ok: false, error: "sample.mint is required", code: "BAD_REQUEST" } };
    if (Array.isArray(body.holderPages)) sample.holderCount = countOwners(body.holderPages as HolderPage[]);
    const alerts = publish(state, host, sample);
    const notes = alerts.map((alert) => webPushPayload(alert));
    return { status: 200, body: { ok: true, alerts, web: notes } };
  }
  if (path === "/api/pump/push/fcm" && method === "POST") {
    const token = str(body.token);
    if (token) {
      state.fcmToken = token;
      writeJson(host.db, "pumpFcmToken", token);
    }
    const sample = sampleOf(body.sample, host.now());
    const alerts = sample ? publish(state, host, sample) : [];
    const target = token || state.fcmToken;
    const serverKey = process.env.FCM_SERVER_KEY || process.env.FIREBASE_SERVER_KEY || "";
    const sent = [];
    for (const alert of alerts) {
      sent.push({ id: alert.id, ...(await sendFcm(alert, { token: target, serverKey })) });
    }
    return { status: 200, body: { ok: true, alerts, sent, mode: serverKey && target ? "fcm" : "local-only" } };
  }
  if (path === "/api/pump/scanner/holders" && method === "POST") {
    const mint = str(body.mint);
    const count = Number(body.count);
    if (!mint || !Number.isFinite(count)) return { status: 400, body: { ok: false, error: "mint and count are required", code: "BAD_REQUEST" } };
    state.scanner.noteHolders(mint, count);
    return { status: 200, body: { ok: true, mint, count } };
  }
  if (path === "/api/pump/scanner" && method === "GET") return { status: 200, body: { ok: true, ...refresh(state, host) } };
  if (path === "/api/pump/scanner" && method === "POST") {
    const coins = Array.isArray(body.coins) ? (body.coins as ScanInput[]) : null;
    if (!coins) return { status: 400, body: { ok: false, error: "coins must be a list", code: "BAD_REQUEST" } };
    const ranked = state.scanner.replace(coins, host.now());
    return { status: 200, body: { ok: true, coins: ranked, intervalMs: 5_000 } };
  }
  if (path === "/api/pump/scanner/auto-buy" && method === "POST") {
    refresh(state, host);
    const wallet = str(body.wallet);
    const sol = lamports(body.solLamports);
    if (!wallet || sol == null) return { status: 400, body: { ok: false, error: "wallet and solLamports are required", code: "BAD_REQUEST" } };
    const session = host.safety.session();
    const liveRequested = body.live === true;
    const walletOk = !session.wallet || session.wallet === wallet;
    const result = await state.scanner.autoBuy({
      enabled: body.enabled === true,
      armed: session.armed && walletOk,
      liveRequested,
      wallet,
      solLamports: sol,
      assertRoom: (amount) => host.safety.assertRoom(amount),
      prepare: (input) => host.prepare({ ...input, live: input.live })
    });
    return { status: 200, body: { ok: true, ...result, armed: session.armed } };
  }
  return null;
}

/** Feed hook. Curve updates and trades evaluate the armed rules. */
export function evaluateDesk(core: object, host: PumpHost, sample: AlertSample): DeskAlert[] {
  return publish(stateFor(core, host), host, sample);
}

/** One unmatched liquidity drop, latched by the desk alert engine and stored on the core alert log. */
export function pageLiquidityDrop(core: object, host: PumpHost, input: LiquidityDropNote): boolean {
  const alert = stateFor(core, host).engine.noteLiquidityDrop(input);
  if (!alert) return false;
  host.emitAlert({
    kind: alert.coreKind,
    mint: alert.mint,
    message: alert.message,
    data: {
      type: "liquidity-drop",
      dropPct: input.dropPct,
      quoteBefore: input.quoteBefore,
      quoteAfter: input.quoteAfter,
      sellLamports: input.sellLamports,
      windowMs: input.windowMs,
      peakAt: input.peakAt,
      delivery: alert.delivery,
      ruleId: alert.ruleId,
      value: alert.value,
      threshold: alert.threshold,
      desk: true
    }
  });
  return true;
}

function publish(state: ExtraState, host: PumpHost, sample: AlertSample): DeskAlert[] {
  const alerts = state.engine.evaluate(sample);
  for (const alert of alerts) {
    host.emitAlert({
      kind: alert.coreKind,
      mint: alert.mint,
      message: alert.message,
      data: { delivery: alert.delivery, ruleId: alert.ruleId, value: alert.value, threshold: alert.threshold, desk: true }
    });
  }
  return alerts;
}

function refresh(state: ExtraState, host: PumpHost): { coins: ReturnType<HotScanner["top"]>; intervalMs: number } {
  if (state.scanner.due(host.now()) || state.scanner.top().length === 0) {
    const rows = rowsFromBook(host.listCoins(200), host.recentTrades(500), state.scanner.holderGrowth(), host.now());
    if (rows.length) state.scanner.replace(rows, host.now());
    else if (state.scanner.due(host.now())) state.scanner.replace(state.scanner.top(), host.now());
  }
  return { coins: state.scanner.top(), intervalMs: 5_000 };
}

function stateFor(core: object, host: PumpHost): ExtraState {
  let state = states.get(core);
  if (!state) {
    const saved = readJson(host.db, "pumpAlertRules");
    const rules = parseRules(saved) ?? DEFAULT_RULES.map((rule) => ({ ...rule }));
    const night = parseNight(readJson(host.db, "pumpNight")) ?? { ...DEFAULT_NIGHT };
    const token = readJson(host.db, "pumpFcmToken");
    state = { engine: new AlertEngine(rules), scanner: new HotScanner(host.now), night, fcmToken: typeof token === "string" ? token : "" };
    states.set(core, state);
  }
  return state;
}

function sampleOf(raw: unknown, now: number): AlertSample | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const mint = str(row.mint);
  if (!mint) return null;
  const sample: AlertSample = { mint, at: typeof row.at === "number" ? row.at : now };
  if (typeof row.price === "number") sample.price = row.price;
  if (typeof row.marketCapLamports === "number") sample.marketCapLamports = row.marketCapLamports;
  if (typeof row.progressPct === "number") sample.progressPct = row.progressPct;
  if (typeof row.holderCount === "number") sample.holderCount = row.holderCount;
  if (typeof row.graduated === "boolean") sample.graduated = row.graduated;
  const buy = side(row.buy);
  const sell = side(row.sell);
  if (buy) sample.buy = buy;
  if (sell) sample.sell = sell;
  return sample;
}

function side(raw: unknown): { lamports: number; signature: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const lamports = typeof row.lamports === "number" ? row.lamports : Number(row.lamports);
  if (!Number.isFinite(lamports)) return null;
  return { lamports, signature: typeof row.signature === "string" ? row.signature : "" };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function lamports(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function limitPages(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(20, Math.max(1, Math.floor(n))) : 3;
}

function readJson(db: DatabaseSync, key: string): unknown {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

function writeJson(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
}

export type { AlertRule };
