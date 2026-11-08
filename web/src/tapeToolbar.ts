import { tinyPx } from "./format";
import type { DeskSnapshot } from "./types";

type Source = NonNullable<DeskSnapshot["feed"]["sources"]>[number];

/** v13.4 Tape toolbar text (same wording as Android TapeToolbar). */
export const SCOUT_OPEN_KEY = "nightdesk.tape.scoutOpen";

export function tapUsdText(usd: number): string {
  return `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

/** Saved slippage is a fraction (0.085); shown as a percent (8.5). */
export function slipText(fraction: number | null | undefined): string {
  const pct = Math.round((fraction ?? 0.03) * 10_000) / 100;
  return Number.isInteger(pct) ? pct.toFixed(0) : String(Math.round(pct * 10) / 10);
}

export function scoutSummary(sources: readonly Source[]): { text: string; badge: string | null; tone: "ok" | "warn" | "down" } {
  const live = sources.filter((s) => s.state === "live").length;
  const down = sources.filter((s) => s.state === "down").length;
  const blocked = sources.filter((s) => s.state === "blocked").length;
  const slow = sources.filter((s) => s.state === "backoff" || s.state === "stale").length;
  const perMin = sources.reduce((n, s) => n + s.sightingsPerMin, 0);
  return {
    text: `${live}/${sources.length} live · ${perMin}/min`,
    badge: down > 0 ? `${down} down` : blocked > 0 ? `${blocked} blocked` : slow > 0 ? `${slow} slow` : null,
    tone: down > 0 ? "down" : blocked > 0 || slow > 0 ? "warn" : "ok"
  };
}

/** Compact card price: 4 significant digits. */
export function shortPx(n: number): string {
  // v13.10: never a 0 price; tiny prices use the v13.8 subscript-zero format.
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 0.0001) return tinyPx(n);
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(3);
  const digits = Math.max(0, -Math.floor(Math.log10(n)) + 3);
  return n.toFixed(Math.min(digits, 20)).replace(/0+$/, "").replace(/\.$/, "");
}
