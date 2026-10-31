import type { DeskSnapshot } from "./types";

type Source = NonNullable<DeskSnapshot["feed"]["sources"]>[number];

/** Scout source state text (shared by the status card and tests). */
export function stateText(s: Source, now: number): string {
  if (s.state === "live") return s.id === "pump" ? "live · websocket" : "live";
  if (s.state === "off") return s.detail ? `off · ${s.detail}` : "off";
  if (s.state === "down") return s.detail ? `down · ${s.detail}` : "down";
  // v13.3 watchdog: connected but silent past 60s. Never shown as live.
  if (s.state === "stale") return s.detail ? `stale · ${s.detail}` : "stale · reconnecting";
  const left = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - now) / 1000)) : null;
  const wait = left != null && left > 0 ? ` · retry in ${left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : `${left}s`}` : "";
  return `backing off${wait}${s.detail ? ` · ${s.detail}` : ""}`;
}
