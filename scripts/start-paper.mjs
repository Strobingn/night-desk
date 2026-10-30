// Starts the Node desk only. It does not launch, restart, or stop cloudflared.
// Keep the phone hostname with scripts/ensure-tunnel.ps1 (Windows) or npm run tunnel.
import { spawn } from "node:child_process";
import path from "node:path";
import { ensureServer, ensureWeb, root } from "./ensure-build.mjs";

const args = process.argv.slice(2);
const live = args.includes("--live");
const recap = args.includes("--recap");
const forward = args.filter((arg) => arg !== "--live" && arg !== "--recap");

if (live) {
  process.env.LIVE_TRADING = "false";
  process.env.DEMO_FEED = "0";
  process.env.FEED_MODE = "live";
}

await ensureServer();
if (!recap) await ensureWeb();

const entry = path.join(root, "dist", recap ? "cli/recap.js" : "index.js");
const child = spawn(process.execPath, [entry, ...forward], {
  cwd: root,
  stdio: "inherit",
  env: process.env
});

child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
