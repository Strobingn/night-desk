import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..");

/** DESK_PORT, then PORT, then PORT= in .env, then 4721. Never prints the file. */
export function deskPort(env: NodeJS.ProcessEnv = process.env, envFile = ""): number {
  const fromEnv = Number(env.DESK_PORT || env.PORT);
  if (fromEnv > 0 && Number.isFinite(fromEnv)) return fromEnv;
  const match = /^\s*PORT\s*=\s*["']?(\d+)/m.exec(envFile);
  const fromFile = match ? Number(match[1]) : 0;
  return fromFile > 0 ? fromFile : 4721;
}

function envFileText(): string {
  try {
    return readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    return "";
  }
}

const PORT = deskPort(process.env, envFileText());
const urlFile = path.join(root, "data", "public-url.txt");
const logFile = path.join(root, "data", "cloudflared.log");
const pidFile = path.join(root, "data", "cloudflared.pid");

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

export function parseTunnelUrl(text: string): string | null {
  const matches = String(text).match(TUNNEL_URL);
  return matches?.length ? matches[matches.length - 1] : null;
}

/** True when a cloudflared command already targets this desk port. Never kill that process. */
export function shouldStartTunnel(commands: string[], port = PORT): boolean {
  const needle = String(port);
  return !commands.some((command) => /cloudflared/i.test(command) && command.includes(needle));
}

export async function publishBeacon(
  publicUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<{ patched: boolean; reason?: string }> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const base = (env.SUPABASE_URL || "https://qivqvwlrmrgjpiqgvmzy.supabase.co").replace(/\/$/, "");
  const id = env.NIGHT_DESK_BEACON_ID || "phone";
  if (!key) {
    return { patched: false, reason: "SUPABASE_SERVICE_ROLE_KEY is unset. Wrote the URL locally only." };
  }
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    prefer: "return=representation"
  };
  const patch = await fetchImpl(`${base}/rest/v1/night_desk_beacon?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ public_url: publicUrl })
  });
  const patchText = await patch.text();
  if (!patch.ok) return { patched: false, reason: `beacon PATCH ${patch.status}` };
  const rows = JSON.parse(patchText || "[]") as unknown;
  if (Array.isArray(rows) && rows.length > 0) return { patched: true };
  const insert = await fetchImpl(`${base}/rest/v1/night_desk_beacon`, {
    method: "POST",
    headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id, public_url: publicUrl })
  });
  if (!insert.ok) return { patched: false, reason: `beacon upsert ${insert.status}` };
  return { patched: true };
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

export async function listCommands(): Promise<string[]> {
  if (process.platform === "win32") {
    const text = await execText("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'cloudflared' } | ForEach-Object { $_.CommandLine }"
    ]);
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  const text = await execText("ps", ["-ax", "-o", "command="]);
  return text.split(/\n/).map((line) => line.trim()).filter(Boolean);
}

async function readExistingUrl(): Promise<string | null> {
  try {
    const saved = (await readFile(urlFile, "utf8")).trim();
    if (parseTunnelUrl(saved) || /^https?:\/\//.test(saved)) return saved.split(/\s+/)[0] ?? null;
  } catch {
    // no file yet
  }
  try {
    return parseTunnelUrl(await readFile(logFile, "utf8"));
  } catch {
    return null;
  }
}

async function remember(url: string) {
  await mkdir(path.dirname(urlFile), { recursive: true });
  await writeFile(urlFile, `${url}\n`);
  const result = await publishBeacon(url);
  console.log(result.patched ? `beacon updated ${url}` : result.reason);
  console.log(`public url ${url}`);
  return result;
}

async function waitForUrl(timeoutMs = 30_000): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const url = parseTunnelUrl(await readFile(logFile, "utf8"));
      if (url) return url;
    } catch {
      // log not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function main() {
  const commands = await listCommands();
  if (!shouldStartTunnel(commands, PORT)) {
    const url = await readExistingUrl();
    console.log(`cloudflared already targets ${PORT}. Leaving it running.`);
    if (!url) {
      console.log(`No URL in ${urlFile}. The existing tunnel was not restarted.`);
      process.exit(0);
    }
    await remember(url);
    return;
  }

  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(logFile, "");
  const handle = await open(logFile, "a");
  const child = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"],
    { detached: true, stdio: ["ignore", handle.fd, handle.fd], windowsHide: true }
  );
  child.unref();
  await handle.close();
  if (child.pid) await writeFile(pidFile, `${child.pid}\n`);
  console.log(`started cloudflared pid ${child.pid ?? "unknown"}`);
  const url = await waitForUrl();
  if (!url) {
    console.error(`cloudflared did not print a trycloudflare URL. See ${logFile}`);
    process.exit(1);
  }
  await remember(url);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
