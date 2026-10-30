import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { Desk } from "../desk/orchestrator.js";
import { deskSessionCookie, requestAuthorized } from "./auth.js";

const DEFAULT_DIST = path.resolve("web/dist");

export function startServer(
  desk: Desk,
  host: string,
  port: number,
  deskToken?: string,
  uiDist: string = DEFAULT_DIST
): http.Server {
  const dist = path.resolve(uiDist);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (!requestAuthorized(deskToken, req, url)) return unauthorized(res);
      if (deskToken) res.setHeader("set-cookie", deskSessionCookie(deskToken));
      if (url.pathname === "/api/health") return json(res, 200, { ok: true, mode: desk.config.mode, now: Date.now() });
      if (url.pathname === "/api/state") return json(res, 200, desk.snapshot());
      if (url.pathname === "/api/events" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "800");
        const stage = url.searchParams.get("stage") ?? undefined;
        const beforeRaw = url.searchParams.get("before");
        const before = beforeRaw != null && beforeRaw !== "" ? Number(beforeRaw) : undefined;
        return json(res, 200, { events: desk.store.queryEvents({ limit, stage, before }) });
      }
      if (url.pathname === "/api/settings" && req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json(res, 400, { ok: false, error: "Settings body must be an object." });
        }
        const record = body as Record<string, unknown>;
        const keys = Object.keys(record);
        const blocked = keys.filter((key) => BLOCKED_SETTINGS.has(key));
        if (blocked.length) {
          return json(res, 400, {
            ok: false,
            error: "The −6% hard stop and live trading cannot be changed from the desk."
          });
        }
        const unknown = keys.filter((key) => !ALLOWED_SETTINGS.has(key));
        if (!keys.length || unknown.length) {
          return json(res, 400, {
            ok: false,
            error: unknown.length ? `Unknown setting: ${unknown.join(", ")}.` : "No settings to save."
          });
        }
        const result = desk.updateSettings({
          ...( "minVolume1hUsd" in record ? { minVolume1hUsd: record.minVolume1hUsd } : {}),
          ...( "analystMinScore" in record ? { analystMinScore: record.analystMinScore } : {}),
          ...( "maxTop10Pct" in record ? { maxTop10Pct: record.maxTop10Pct } : {}),
          ...( "maxPositionPct" in record ? { maxPositionPct: record.maxPositionPct } : {}),
          ...( "defaultBuyUsd" in record ? { defaultBuyUsd: record.defaultBuyUsd } : {}),
          ...( "maxOpenPositions" in record ? { maxOpenPositions: record.maxOpenPositions } : {}),
          ...( "allowUnlockedLp" in record ? { allowUnlockedLp: record.allowUnlockedLp } : {}),
          ...( "maxEntrySlippage" in record ? { maxEntrySlippage: record.maxEntrySlippage } : {}),
          ...( "minLiquidityUsd" in record ? { minLiquidityUsd: record.minLiquidityUsd } : {}),
          ...( "minTokenAgeMin" in record ? { minTokenAgeMin: record.minTokenAgeMin } : {}),
          ...( "maxTokenAgeMin" in record ? { maxTokenAgeMin: record.maxTokenAgeMin } : {}),
          ...( "minHolderCount" in record ? { minHolderCount: record.minHolderCount } : {}),
          ...( "maxDevHoldingPct" in record ? { maxDevHoldingPct: record.maxDevHoldingPct } : {}),
          ...( "maxTradesPerHour" in record ? { maxTradesPerHour: record.maxTradesPerHour } : {}),
          ...( "dailyMaxLossUsd" in record ? { dailyMaxLossUsd: record.dailyMaxLossUsd } : {}),
          ...( "cooldownHours" in record ? { cooldownHours: record.cooldownHours } : {}),
          ...( "stopLossPct" in record ? { stopLossPct: record.stopLossPct } : {}),
          ...( "trailTakeProfit" in record ? { trailTakeProfit: record.trailTakeProfit } : {}),
          ...( "trailArmPct" in record ? { trailArmPct: record.trailArmPct } : {}),
          ...( "trailGapPct" in record ? { trailGapPct: record.trailGapPct } : {}),
          ...( "autoBuy" in record ? { autoBuy: record.autoBuy } : {}),
          ...( "scoutDexscreener" in record ? { scoutDexscreener: record.scoutDexscreener } : {}),
          ...( "scoutGecko" in record ? { scoutGecko: record.scoutGecko } : {}),
          ...( "scoutJupiter" in record ? { scoutJupiter: record.scoutJupiter } : {}),
          ...( "scoutDexpaprika" in record ? { scoutDexpaprika: record.scoutDexpaprika } : {}),
          ...( "scoutBitquery" in record ? { scoutBitquery: record.scoutBitquery } : {}),
          ...( "notifyNearMiss" in record ? { notifyNearMiss: record.notifyNearMiss } : {}),
          ...( "notifyFills" in record ? { notifyFills: record.notifyFills } : {}),
          ...( "notifyStops" in record ? { notifyStops: record.notifyStops } : {}),
          ...( "pnlAlertPct" in record ? { pnlAlertPct: record.pnlAlertPct } : {})
        });
        if (!result.ok) return json(res, 400, result);
        return json(res, 200, { ok: true, ...result.settings, settings: result.settings });
      }
      if (url.pathname === "/api/paper/reset" && req.method === "POST") {
        const body = await readJson(req);
        const confirm = Boolean(body && typeof body === "object" && "confirm" in body && (body as { confirm?: unknown }).confirm === true);
        const result = desk.resetPaperBook(confirm);
        return json(res, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/api/positions/buy" && req.method === "POST") {
        const body = await readJson(req);
        const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const mint =
          (typeof record.mint === "string" ? record.mint : "") || url.searchParams.get("mint") || "";
        const sizeUsd = parseSizeUsd(record);
        if (sizeUsd === "bad") {
          return json(res, 400, {
            ok: false,
            error: "sizeUsd must be a positive number of dollars, or omitted to use the position cap.",
            code: "POSITION_CAP"
          });
        }
        const ignoreCooldown = record.ignoreCooldown === true;
        const result = await desk.manualBuy(mint, sizeUsd, { ignoreCooldown });
        return json(res, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/api/live/ready" && req.method === "GET") return json(res, 200, desk.readiness());
      if (url.pathname === "/api/live/ready" && req.method === "POST") {
        const body = await readJson(req);
        const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const keys = Object.keys(record);
        if (keys.length !== 1 || keys[0] !== "operatorReady" || typeof record.operatorReady !== "boolean") {
          return json(res, 400, {
            ok: false,
            error:
              'This route only accepts {"operatorReady": true|false}. It cannot set LIVE_TRADING, a keypair, or a seed. Edit Austin .env and restart the desk. Mode stays paper until then.'
          });
        }
        const result = desk.setOperatorReady(record.operatorReady);
        return json(res, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/api/positions/close" && req.method === "POST") {
        const body = await readJson(req);
        const mint =
          (body && typeof body === "object" && "mint" in body && typeof body.mint === "string" ? body.mint : "") ||
          url.searchParams.get("mint") ||
          "";
        const result = await desk.closePosition(mint.trim());
        return json(res, result.ok ? 200 : 404, result);
      }
      if (url.pathname === "/api/recap") {
        return json(res, 200, desk.recap(url.searchParams.get("since")));
      }
      if (url.pathname === "/api/client-crash" && req.method === "POST") {
        const body = await readJson(req, 64_000);
        const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
        const stack = record && typeof record.stack === "string" ? record.stack : "";
        const version = record && typeof record.version === "string" ? record.version.slice(0, 40) : "";
        if (!stack.trim()) return json(res, 400, { ok: false, error: "stack is required" });
        desk.recordClientCrash(version, stack);
        return json(res, 200, { ok: true });
      }
      await serveStatic(dist, url.pathname, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "error";
      json(res, 500, { error: message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<import("ws").WebSocket>();
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!requestAuthorized(deskToken, req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nUnauthorized");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: "snapshot", data: desk.snapshot() }));
    socket.on("close", () => sockets.delete(socket));
  });

  let pending: NodeJS.Timeout | null = null;
  const push = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const payload = JSON.stringify({ type: "snapshot", data: desk.snapshot() });
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }, 200);
  };
  desk.bus.on("log.event", () => push());
  desk.bus.on("market.tick", () => push());

  server.listen(port, host, () => {
    const bound = server.address();
    const shown = typeof bound === "object" && bound ? bound.port : port;
    const gate = deskToken ? "token gate on" : "local open";
    console.log(`[desk] terminal http://127.0.0.1:${shown} (${gate})`);
  });
  return server;
}

async function readJson(req: http.IncomingMessage, max = 16_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > max) throw new Error("body too large");
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const BLOCKED_SETTINGS = new Set([
  "stopLoss",
  "liveTrading",
  "LIVE_TRADING",
  "mode",
  "walletKeypairPath",
  "seed",
  "secret",
  "secretKey",
  "keypair"
]);

const ALLOWED_SETTINGS = new Set([
  "minVolume1hUsd",
  "analystMinScore",
  "maxTop10Pct",
  "maxPositionPct",
  "defaultBuyUsd",
  "maxOpenPositions",
  "allowUnlockedLp",
  "maxEntrySlippage",
  "minLiquidityUsd",
  "minTokenAgeMin",
  "maxTokenAgeMin",
  "minHolderCount",
  "maxDevHoldingPct",
  "maxTradesPerHour",
  "dailyMaxLossUsd",
  "cooldownHours",
  "stopLossPct",
  "trailTakeProfit",
  "trailArmPct",
  "trailGapPct",
  "autoBuy",
  "scoutDexscreener",
  "scoutGecko",
  "scoutJupiter",
  "scoutDexpaprika",
  "scoutBitquery",
  "notifyNearMiss",
  "notifyFills",
  "notifyStops",
  "pnlAlertPct"
]);

function parseSizeUsd(record: Record<string, unknown>): number | undefined | "bad" {
  if (!("sizeUsd" in record) || record.sizeUsd == null || record.sizeUsd === "") return undefined;
  const n = typeof record.sizeUsd === "number" ? record.sizeUsd : typeof record.sizeUsd === "string" ? Number(record.sizeUsd) : Number.NaN;
  if (!Number.isFinite(n)) return "bad";
  return n;
}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate": "DeskToken"
  });
  res.end("Unauthorized");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function serveStatic(dist: string, pathname: string, res: http.ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const root = dist.endsWith(path.sep) ? dist : dist + path.sep;
  const file = path.resolve(dist, `.${rel}`);
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { "content-type": contentType(file), "cache-control": "no-cache" });
    createReadStream(file).pipe(res);
    return;
  }
  const index = path.join(dist, "index.html");
  if (!existsSync(index)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("UI build missing. Run npm run build:web or npm run paper.");
    return;
  }
  const html = await readFile(index);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(html);
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".woff2")) return "font/woff2";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
