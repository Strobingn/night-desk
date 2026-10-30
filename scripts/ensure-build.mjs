import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function newestUnder(dir) {
  let max = 0;
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const file = path.join(current, name);
      const stat = statSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.mtimeMs > max) max = stat.mtimeMs;
    }
  };
  if (existsSync(dir)) walk(dir);
  return max;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(" ")} exited ${code}`));
    });
  });
}

export async function ensureServer() {
  const dist = path.join(root, "dist", "index.js");
  const config = path.join(root, "tsconfig.build.json");
  const newest = Math.max(newestUnder(path.join(root, "src")), existsSync(config) ? statSync(config).mtimeMs : 0);
  if (existsSync(dist) && statSync(dist).mtimeMs >= newest) return;
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  await run([tsc, "-p", "tsconfig.build.json"]);
}

export async function ensureWeb() {
  const index = path.join(root, "web", "dist", "index.html");
  const newest = Math.max(
    newestUnder(path.join(root, "web", "src")),
    existsSync(path.join(root, "web", "index.html")) ? statSync(path.join(root, "web", "index.html")).mtimeMs : 0,
    existsSync(path.join(root, "web", "vite.config.ts")) ? statSync(path.join(root, "web", "vite.config.ts")).mtimeMs : 0
  );
  if (existsSync(index) && statSync(index).mtimeMs >= newest) return;
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  await run([vite, "build", "--config", "web/vite.config.ts"]);
}

export { root };
