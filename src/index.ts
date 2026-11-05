import path from "node:path";
import { loadDeskEnv } from "./env-file.js";
import { loadConfig } from "./config.js";
import { Desk } from "./desk/orchestrator.js";
import { startServer } from "./server/http.js";

// v13.5: wallet keys only, from Austin's .env (names logged, never values).
const appliedEnv = loadDeskEnv(path.resolve(".env"));
if (appliedEnv.length) console.log(`[desk] .env wallet keys loaded: ${appliedEnv.join(", ")}`);
const config = loadConfig();
const desk = new Desk(config);
desk.start();
const server = startServer(desk, config.host, config.port, config.deskToken);

function shutdown(signal: string): void {
  console.log(`[desk] ${signal}, flushing the book`);
  server.close();
  desk.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
