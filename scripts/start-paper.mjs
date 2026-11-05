// Starts the Node desk only. It does not launch, restart, or stop cloudflared.
// Keep the phone hostname with scripts/ensure-tunnel.ps1 (Windows) or npm run tunnel.
import { spawn } from "node:child_process";
import path from "node:path";
import { ensureServer, ensureWeb, root } from "./ensure-build.mjs";
import { existsSync, readFileSync } from "node:fs";

/** Exactly LIVE_TRADING=true in .env. Reads only that one line's value; nothing is printed. */
function envFileLiveFlag(file) {
  if (!existsSync(file)) return false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*LIVE_TRADING\s*=\s*(.*?)\s*$/.exec(raw);
    if (m) return m[1].replace(/^["']|["']$/g, "") === "true";
  }
  return false;
}

const args = process.argv.slice(2);
const live = args.includes("--live");
const recap = args.includes("--recap");
const forward = args.filter((arg) => arg !== "--live" && arg !== "--recap");

if (live) {
  // v13.5: live swaps only when Austin's .env says exactly LIVE_TRADING=true (and a valid
  // WALLET_PRIVATE_KEY is there; the desk re-checks). Anything else stays paper.
  process.env.LIVE_TRADING = envFileLiveFlag(path.join(root, ".env")) ? "true" : "false";
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
