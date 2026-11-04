/**
 * Night mode on a schedule: force the dark theme and lower the page brightness.
 * The window math lives in the server module so the phone and the desk agree.
 */
import { DEFAULT_NIGHT, inNightWindow, type NightWindow } from "../../../src/pump/alerts/night";

export { DEFAULT_NIGHT, inNightWindow };
export type { NightWindow };

const KEY = "nightdesk.night";

export interface NightRoot {
  dataset: Record<string, string>;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
}

export function readNight(storage: Pick<Storage, "getItem"> | null = safeStorage()): NightWindow {
  if (!storage) return { ...DEFAULT_NIGHT };
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { ...DEFAULT_NIGHT };
    const parsed = JSON.parse(raw) as NightWindow;
    if (typeof parsed.startMin !== "number" || typeof parsed.endMin !== "number") return { ...DEFAULT_NIGHT };
    return {
      enabled: parsed.enabled !== false,
      startMin: parsed.startMin,
      endMin: parsed.endMin,
      brightness: typeof parsed.brightness === "number" ? parsed.brightness : DEFAULT_NIGHT.brightness
    };
  } catch {
    return { ...DEFAULT_NIGHT };
  }
}

export function saveNight(schedule: NightWindow, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(schedule));
  } catch {
    /* private mode keeps the schedule for this session */
  }
}

/** Applies dark theme plus brightness while the schedule says it is night. */
export function applyNight(schedule: NightWindow, date: Date = new Date(), root?: NightRoot): boolean {
  const target = root ?? rootFromDocument();
  if (!target) return inNightWindow(schedule, date);
  const on = inNightWindow(schedule, date);
  if (on) {
    if (!target.dataset.nightPrev && target.dataset.theme) target.dataset.nightPrev = target.dataset.theme;
    target.dataset.theme = "dark";
    target.dataset.night = "1";
    const brightness = Math.min(1, Math.max(0.15, schedule.brightness));
    target.style.setProperty("--night-brightness", brightness.toFixed(2));
    return true;
  }
  if (target.dataset.night === "1") {
    target.dataset.night = "0";
    if (target.dataset.nightPrev) {
      target.dataset.theme = target.dataset.nightPrev;
      delete target.dataset.nightPrev;
    }
    target.style.removeProperty("--night-brightness");
  }
  return false;
}

export function startNightMode(schedule: NightWindow = readNight(), now: () => Date = () => new Date()): () => void {
  const tick = () => applyNight(schedule, now());
  tick();
  const timer = setInterval(tick, 30_000);
  return () => clearInterval(timer);
}

function rootFromDocument(): NightRoot | null {
  const root = globalThis.document?.documentElement as NightRoot | undefined;
  return root ?? null;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
