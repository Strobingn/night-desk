/** Local-time night window. Overnight ranges (22:00–07:00) wrap past midnight. */

export interface NightWindow {
  enabled: boolean;
  /** Minutes from local midnight, inclusive. */
  startMin: number;
  /** Minutes from local midnight, exclusive when it differs from the start. */
  endMin: number;
  /** 0–1 screen brightness while the window is active. */
  brightness: number;
}

export const DEFAULT_NIGHT: NightWindow = { enabled: true, startMin: 22 * 60, endMin: 7 * 60, brightness: 0.55 };

export function minutesOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function inNightWindow(schedule: NightWindow, date: Date): boolean {
  if (!schedule.enabled) return false;
  const start = clampMin(schedule.startMin);
  const end = clampMin(schedule.endMin);
  const now = minutesOf(date);
  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

export function parseNight(raw: unknown): NightWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const startMin = num(row.startMin);
  const endMin = num(row.endMin);
  const brightness = num(row.brightness);
  if (startMin == null || endMin == null || brightness == null) return null;
  return {
    enabled: row.enabled !== false,
    startMin: clampMin(startMin),
    endMin: clampMin(endMin),
    brightness: Math.min(1, Math.max(0.15, brightness))
  };
}

function clampMin(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(24 * 60 - 1, Math.max(0, Math.floor(value)));
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
