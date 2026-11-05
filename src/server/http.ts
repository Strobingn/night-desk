import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { Desk } from "../desk/orchestrator.js";
import { buildRecap, formatRecap, parseSince } from "../desk/recap.js";
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
      // Health stays open so ensure-desk.ps1 and uptime checks work with DESK_TOKEN set.
      // It returns only ok/mode/time — no book, keys, or events.
      if (url.pathname === "/api/health") return json(res, 200, { ok: true, mode: desk.config.mode, now: Date.now() });
      if (!requestAuthorized(deskToken, req, url)) return unauthorized(res);
      if (deskToken) res.setHeader("set-cookie", deskSessionCookie(deskToken));
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
        const raw =
          body && typeof body === "object" && "minVolume1hUsd" in body
            ? Number((body as { minVolume1hUsd?: unknown }).minVolume1hUsd)
            : Number.NaN;
        const result = desk.setMinVolume(raw);
        return json(res, result.ok ? 200 : 400, result);
      }
      if (url.pathname === "/api/paper/reset" && req.method === "POST") {
        const body = await readJson(req);
        const confirm = Boolean(body && typeof body === "object" && "confirm" in body && (body as { confirm?: unknown }).confirm === true);
        const result = desk.resetPaperBook(confirm);
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
        const since = parseSince(url.searchParams.get("since") ?? "12h");
        const until = Date.now();
        const snap = desk.snapshot();
        const recap = buildRecap({
          since,
          until,
          events: desk.store.eventsSince(since),
          equity: desk.store.equitySince(since),
          closed: desk.store.closedSince(since),
          open: snap.positions,
          startingBalanceUsd: snap.startingBalanceUsd
        });
        return json(res, 200, { ...recap, text: formatRecap(recap) });
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

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 16_000) throw new Error("body too large");
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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
