import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Empty or whitespace means the desk is local-only and the gate stays open. */
export function resolveDeskToken(raw: string | undefined): string | undefined {
  const token = raw?.trim();
  return token ? token : undefined;
}

export function tokenMatches(expected: string, presented: string | null | undefined): boolean {
  if (presented == null) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

export function headerToken(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * When `expected` is unset, every request is allowed.
 * Otherwise the header, the query string, or the session cookie must match.
 */
export function isDeskAuthorized(
  expected: string | undefined,
  presented: { header?: string | null; query?: string | null; cookie?: string | null }
): boolean {
  if (!expected) return true;
  return (
    tokenMatches(expected, presented.header) ||
    tokenMatches(expected, presented.query) ||
    tokenMatches(expected, presented.cookie)
  );
}

export function requestAuthorized(expected: string | undefined, req: IncomingMessage, url: URL): boolean {
  return isDeskAuthorized(expected, {
    header: headerToken(req.headers["x-desk-token"]),
    query: url.searchParams.get("token"),
    cookie: readCookie(req.headers.cookie, "desk_token")
  });
}

export function deskSessionCookie(token: string): string {
  return `desk_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}
