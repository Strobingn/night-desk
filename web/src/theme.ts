/** v13 client-only theme preference (never sent to the desk). */
export type ThemePref = "dark" | "light" | "system";
export const THEME_KEY = "nightdesk.theme";
export const THEME_OPTIONS: { id: ThemePref; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" }
];

export function readThemePref(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemePref {
  const raw = storage?.getItem(THEME_KEY);
  return raw === "light" || raw === "system" || raw === "dark" ? raw : "dark";
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): "dark" | "light" {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

/** Header quick toggle: Dark → Light → System → Dark. */
export function nextTheme(pref: ThemePref): ThemePref {
  return pref === "dark" ? "light" : pref === "light" ? "system" : "dark";
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function saveThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* private mode: preference lasts for this session */
  }
}

export function applyTheme(pref: ThemePref) {
  const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : true;
  document.documentElement.dataset.theme = resolveTheme(pref, dark);
}
