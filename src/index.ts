import { loadConfig } from "./config.js";
import { Desk } from "./desk/orchestrator.js";
import { startServer } from "./server/http.js";

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
