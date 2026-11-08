import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { IdempotencyCache } from "./idempotency.js";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { Desk } from "../desk/orchestrator.js";
import { deskSessionCookie, requestAuthorized } from "./auth.js";

const DEFAULT_DIST = path.resolve("web/dist");

let publicUrlCache: { at: number; file: string; url: string | null } | null = null;

/** data/public-url.txt next to the database, if it holds an https trycloudflare URL. Cached 10s. */
export function readPublicUrl(dbPath: string, now = Date.now()): string | null {
  const file = path.join(path.dirname(dbPath), "public-url.txt");
  if (publicUrlCache && publicUrlCache.file === file && now - publicUrlCache.at < 10_000) return publicUrlCache.url;
  let url: string | null = null;
  try {
    const raw = readFileSync(file, "utf8").trim();
    const match = raw.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    url = match ? match[0] : null;
  } catch {
    url = null;
  }
  publicUrlCache = { at: now, file, url };
  return url;
}

/** Snapshot pushes are coalesced to at most one per WS_PUSH_MS. */
export const WS_PUSH_MS = 200;
/** v13.2: a full snapshot (~80 KB) goes out at most once per second. */
export const WS_SNAPSHOT_MIN_MS = 1_000;
/** v13.2: position-mark deltas (a few hundred bytes) are coalesced to one per 100 ms (v13.8, was 250). */
export const WS_MARKS_MS = 100;
/** A socket with more than this still queued is behind; it skips snapshots until it drains. */
export const WS_BACKLOG_MAX = 256 * 1024;
export const WS_HEARTBEAT_MS = 25_000;

type PushTarget = { readyState: number; OPEN: number; bufferedAmount: number; send: (data: string) => void };

/**
 * Sends one full snapshot to every open socket that is not backed up. Snapshots are whole
 * state, so skipping a stale one loses nothing. Returns how many sockets were skipped.
 */
export function sendSnapshot(sockets: Iterable<PushTarget>, payload: string, backlogMax = WS_BACKLOG_MAX): number {
  let skipped = 0;
  for (const socket of sockets) {
    if (socket.readyState !== socket.OPEN) continue;
    if (socket.bufferedAmount > backlogMax) {
      skipped += 1;
      continue;
    }
    socket.send(payload);
  }
  return skipped;
}

export function startServer(
  desk: Desk,
  host: string,
  port: number,
  deskToken?: string,
  uiDist: string = DEFAULT_DIST
): http.Server {
  const dist = path.resolve(uiDist);
  const idem = new IdempotencyCache();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (!requestAuthorized(deskToken, req, url)) return unauthorized(res);
      if (deskToken) res.setHeader("set-cookie", deskSessionCookie(deskToken));
      if (url.pathname === "/api/health") {
        // v12.2: the desk's current public tunnel URL (written by ensure-tunnel.ps1), so the phone can learn a new one.
        return json(res, 200, { ok: true, mode: desk.config.mode, now: Date.now(), publicUrl: readPublicUrl(desk.config.dbPath) });
      }
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
        if (record.liveAutoBuy === true) {
          return json(res, 400, { ok: false, error: "AI auto-buys stay on the paper book. The server refuses to let them spend real money." });
        }
        delete record.liveAutoBuy;
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
        const patch: Record<string, unknown> = {};
        for (const key of keys) patch[key] = record[key];
        const result = desk.updateSettings(patch);
        if (!result.ok) return json(res, 400, result);
        return json(res, 200, { ok: true, ...result.settings, settings: result.settings });
      }
      if (url.pathname === "/api/paper/reset" && req.method === "POST") {
        const body = await readJson(req);
        const confirm = Boolean(body && typeof body === "object" && "confirm" in body && (body as { confirm?: unknown }).confirm === true);
        const rawStart = body && typeof body === "object" ? (body as { startingUsd?: unknown }).startingUsd : undefined;
        if (rawStart !== undefined && (typeof rawStart !== "number" || !Number.isFinite(rawStart) || rawStart < 100 || rawStart > 10_000)) {
          return json(res, 400, { ok: false, error: "startingUsd must be a number from 100 to 10,000." });
        }
        const result = desk.resetPaperBook(confirm, rawStart as number | undefined);
        return json(res, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/api/positions/buy" && req.method === "POST") {
        const body = await readJson(req);
        const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const replay = idem.lookup("buy", record.idemKey);
        if (replay) {
          const first = await replay;
          return json(res, first.status, { ...first.body, replayed: true });
        }
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
        const started = Date.now();
        const job = desk
          .manualBuy(mint, sizeUsd, {
            ignoreCooldown,
            confirmHardKill: record.confirmHardKill === true,
            confirmSize: record.confirmSize === true,
            // v13.7: armed desk → manual buys are live unless the client asks for the paper book.
            ...(parseBook(record, url) ? { book: parseBook(record, url) } : {})
          })
          .then((result) => ({ ...result, ms: Date.now() - started }));
        idem.remember("buy", record.idemKey, job, (r) => (r.ok ? 200 : 400));
        const result = await job;
        return json(res, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/api/live/ready" && req.method === "GET") return json(res, 200, desk.readiness());
      // v13.5 read-only wallet card: public address, SOL / USDC, key loaded, LIVE on/off. Never the secret.
      if (url.pathname === "/api/wallet" && req.method === "GET") {
        await desk.refreshWalletThrottled();
        return json(res, 200, desk.walletView());
      }
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
      if ((url.pathname === "/api/positions/close" || url.pathname === "/api/positions/sell") && req.method === "POST") {
        const body = await readJson(req);
        const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const mint = (typeof record.mint === "string" ? record.mint : "") || url.searchParams.get("mint") || "";
        const fraction = parseSellFraction(record, url);
        if (fraction === "bad") {
          return json(res, 400, { ok: false, error: "Sell size must be 25, 50 or 100 percent (or a fraction above 0 and at most 1)." });
        }
        const replay = idem.lookup("sell", record.idemKey);
        if (replay) {
          const first = await replay;
          return json(res, first.status, { ...first.body, replayed: true });
        }
        const started = Date.now();
        const job = desk.closePosition(mint.trim(), fraction, parseBook(record, url)).then((result) => ({ ...result, ms: Date.now() - started }));
        const statusOf = (r: Awaited<typeof job>) => (r.ok ? 200 : r.error.startsWith("No open position") ? 404 : 400);
        idem.remember("sell", record.idemKey, job, statusOf);
        const result = await job;
        return json(res, statusOf(result), result);
      }
      // v13.11 limit / take-profit / stop orders. Placing never fires; cancel works on open orders.
      if (url.pathname === "/api/orders" && req.method === "GET") {
        return json(res, 200, { ok: true, orders: desk.snapshot().orders ?? [] });
      }
      if (url.pathname === "/api/orders" && req.method === "POST") {
        const body = await readJson(req);
        const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const replay = idem.lookup("order", record.idemKey);
        if (replay) {
          const first = await replay;
          return json(res, first.status, { ...first.body, replayed: true });
        }
        const job = Promise.resolve(desk.placeOrder(record));
        idem.remember("order", record.idemKey, job, (r) => (r.ok ? 200 : 400));
        const result = await job;
        return json(res, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/api/orders/cancel" && req.method === "POST") {
        const body = await readJson(req);
        const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const id = typeof record.id === "string" ? record.id : url.searchParams.get("id") ?? "";
        const result = desk.cancelOrder(id);
        return json(res, result.ok ? 200 : result.error.startsWith("No order") ? 404 : 400, result);
      }
      if (url.pathname === "/api/positions/sell-all" && req.method === "POST") {
        const body = await readJson(req);
        const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        if (record.confirm !== true) return json(res, 400, { ok: false, error: 'Send {"confirm": true} to sell every open position.' });
        const replay = idem.lookup("sell-all", record.idemKey);
        if (replay) {
          const first = await replay;
          return json(res, first.status, { ...first.body, replayed: true });
        }
        const started = Date.now();
        const job = desk.closeAllPositions(parseBook(record, url)).then((result) => ({ ...result, ms: Date.now() - started }));
        idem.remember("sell-all", record.idemKey, job, () => 200);
        return json(res, 200, await job);
      }
      if (url.pathname === "/api/lookup" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const result = await desk.lookupCoin(q);
        return json(res, result.ok || result.code === "AMBIGUOUS" ? 200 : result.code === "PRICE_UNAVAILABLE" ? 422 : 400, result);
      }
      if (url.pathname === "/api/watchlist" && req.method === "GET") {
        return json(res, 200, { ok: true, watchlist: desk.listWatchlist() });
      }
      if (url.pathname === "/api/watchlist" && req.method === "POST") {
        const body = await readJson(req);
        const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const q = typeof record.q === "string" ? record.q : typeof record.mint === "string" ? record.mint : "";
        const result = await desk.addToWatchlist(q);
        return json(res, result.ok ? 200 : result.code === "PRICE_UNAVAILABLE" ? 422 : 400, result);
      }
      if ((url.pathname === "/api/watchlist/remove" && req.method === "POST") || (url.pathname === "/api/watchlist" && req.method === "DELETE")) {
        const body = req.method === "POST" ? await readJson(req) : {};
        const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const mint = (typeof record.mint === "string" ? record.mint : "") || url.searchParams.get("mint") || "";
        const result = desk.removeFromWatchlist(mint);
        return json(res, result.ok ? 200 : 404, result);
      }
      if (url.pathname === "/api/recap") {
        return json(res, 200, desk.recap(url.searchParams.get("since")));
      }
      if (url.pathname === "/api/pump" || url.pathname.startsWith("/api/pump/")) {
        const body = req.method === "GET" || req.method === "HEAD" ? {} : await readJson(req);
        const result = await desk.pump.handle(req.method ?? "GET", url, body);
        return json(res, result.status, result.body);
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

  // v12.2: snapshots are ~80 KB of JSON. Compress them (OkHttp 4.12 and browsers negotiate
  // permessage-deflate), and never queue more than WS_BACKLOG_MAX for a slow phone link.
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 }, serverNoContextTakeover: true, clientNoContextTakeover: true }
  });
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
  const alive = new WeakMap<import("ws").WebSocket, boolean>();
  wss.on("connection", (socket) => {
    sockets.add(socket);
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));
    socket.on("message", (buf) => desk.pump.onClientMessage(socket, buf.toString()));
    socket.send(JSON.stringify({ type: "snapshot", data: desk.snapshot() }));
    socket.on("close", () => {
      sockets.delete(socket);
      desk.pump.detachSocket(socket);
    });
    socket.on("error", () => sockets.delete(socket));
  });
  // Server heartbeat: drop sockets that stopped answering so they do not pile up behind a dead tunnel.
  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (alive.get(socket) === false) {
        sockets.delete(socket);
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      try {
        socket.ping();
      } catch {
        /* closing */
      }
    }
  }, WS_HEARTBEAT_MS);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));

  let pending: NodeJS.Timeout | null = null;
  let lastSnapshotAt = 0;
  const push = () => {
    if (pending) return;
    const wait = Math.max(WS_PUSH_MS, lastSnapshotAt + WS_SNAPSHOT_MIN_MS - Date.now());
    pending = setTimeout(() => {
      pending = null;
      lastSnapshotAt = Date.now();
      const payload = JSON.stringify({ type: "snapshot", data: desk.snapshot() });
      // A socket still draining an older snapshot skips this one and gets the latest once it drains.
      if (sendSnapshot(sockets, payload) > 0) push();
    }, wait);
  };
  let marksPending: NodeJS.Timeout | null = null;
  const pushMarks = () => {
    if (marksPending) return;
    marksPending = setTimeout(() => {
      marksPending = null;
      const payload = JSON.stringify({ type: "marks", data: desk.marksDelta() });
      sendSnapshot(sockets, payload);
    }, WS_MARKS_MS);
  };
  desk.bus.on("log.event", () => push());
  // v13.2: a tick only refreshes the tape, so it rides the 1/s snapshot. Held marks go as deltas.
  desk.bus.on("market.tick", () => push());
  desk.bus.on("desk.changed", () => push());
  desk.bus.on("position.mark", () => pushMarks());

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
  "keypair",
  "privateKey",
  "walletPrivateKey",
  "WALLET_PRIVATE_KEY",
  "readWalletSecret"
]);

export const ALLOWED_SETTINGS: ReadonlySet<string> = new Set([
  "liveTradeUsd",
  "liveDailyCapUsd",
  "liveTrailPct",
  "positionRefreshMs",
  "minVolume1hUsd",
  "analystMinScore",
  "volumeBoost",
  "maxTop10Pct",
  "maxPositionPct",
  "defaultBuyUsd",
  "maxOpenPositions",
  "allowUnlockedLp",
  "maxEntrySlippage",
  "maxExitSlippage",
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
  "scoutPumpApi",
  "scoutLaunchLab",
  "notifyNearMiss",
  "notifyFills",
  "notifyStops",
  "pnlAlertPct",
  "positionSizeUsd",
  "maxExposurePct",
  "paperResetUsd"
]);

/** 25, 50, 100 (percent) or 0.25, 0.5, 1 (fraction). Omitted = 100%. */
export function parseSellFraction(record: Record<string, unknown>, url?: URL): number | "bad" {
  const raw = "fraction" in record ? record.fraction : "percent" in record ? record.percent : url?.searchParams.get("percent") ?? url?.searchParams.get("fraction") ?? null;
  if (raw == null || raw === "") return 1;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return "bad";
  const fraction = n > 1 ? n / 100 : n;
  if (!(fraction > 0) || fraction > 1) return "bad";
  return fraction;
}

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

/** v13.7 `book: "live" | "paper"` in the body (or ?book=). Anything else = not given. */
function parseBook(record: Record<string, unknown>, url: URL): "live" | "paper" | undefined {
  const raw = typeof record.book === "string" ? record.book : url.searchParams.get("book");
  return raw === "live" || raw === "paper" ? raw : undefined;
}
