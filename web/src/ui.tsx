import { useMemo, type ReactNode } from "react";
import { signedPct, signedUsd, stopLabel } from "./format";

/** v13 redesign primitives (FieldOps style: gray chrome, green/red for status only). */

const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  tape: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  add: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  recap: <path d="M5 20V10M12 20V4M19 20v-7" />,
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  coins: (
    <>
      <circle cx="9" cy="9" r="6" />
      <path d="M15.5 9.2A6 6 0 1 1 9.2 15.5" />
    </>
  ),
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
  filter: <path d="M4 5h16l-6 8v6l-4-2v-4z" />,
  exit: <path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 16l-4-4 4-4M6 12h10" />,
  radar: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 12 18 6" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  auto: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" />
    </>
  ),
  palette: <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1-.8-1.4-.8-2.3 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4c0-4.7-4-8.7-9-8.7zM7.5 11h.01M10 7.5h.01M14 7.5h.01M16.5 11h.01" />
};

export function Icon({ name, size = 22 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? null}
    </svg>
  );
}

const AVATAR_TONES = ["var(--av0)", "var(--av1)", "var(--av2)", "var(--av3)", "var(--av4)", "var(--av5)"];

/** Round coin avatar with initials. Gray tone from the mint so a coin keeps its look. */
export function CoinAvatar({ symbol, mint, tone, size = 44 }: { symbol: string; mint: string; tone?: "up" | "down" | "flat"; size?: number }) {
  const letters = symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  let h = 0;
  for (const ch of mint) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`avatar${tone ? ` ring-${tone}` : ""}`} style={{ width: size, height: size, background: AVATAR_TONES[h % AVATAR_TONES.length], fontSize: size * 0.36 }} aria-hidden="true">
      {letters}
    </span>
  );
}

export function PnlChip({ usd, pct, size = "md" }: { usd?: number; pct?: number | null; size?: "md" | "lg" }) {
  const n = usd ?? pct ?? 0;
  const t = n > 0 ? "up" : n < 0 ? "down" : "flat";
  return (
    <span className={`pchip ${t} ${size}`}>
      {usd != null ? signedUsd(usd) : null}
      {usd != null && pct != null ? <i>·</i> : null}
      {pct != null ? signedPct(pct) : null}
    </span>
  );
}

/** Small price line for one held coin. Entry is the dashed baseline. */
export function CoinSpark({ points, entry }: { points: { t: number; priceUsd: number }[]; entry: number }) {
  const d = useMemo(() => {
    const series = points.length >= 2 ? points : points.length === 1 ? [points[0], { ...points[0], t: points[0].t + 1 }] : [];
    if (series.length < 2) return null;
    const vals = series.map((p) => p.priceUsd);
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (Number.isFinite(entry) && entry > 0) {
      min = Math.min(min, entry);
      max = Math.max(max, entry);
    }
    const span = max - min || 1;
    const w = 300;
    const h = 36;
    const xy = series.map((p, i) => [(i / (series.length - 1)) * w, h - 3 - ((p.priceUsd - min) / span) * (h - 6)] as const);
    const line = xy.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
    const base = Number.isFinite(entry) ? h - 3 - ((entry - min) / span) * (h - 6) : h / 2;
    const last = vals[vals.length - 1] ?? entry;
    return { line, base, up: last >= entry, h };
  }, [points, entry]);
  if (!d) return null;
  return (
    <svg className={`spark coin-spark ${d.up ? "up" : "down"}`} viewBox={`0 0 300 ${d.h}`} preserveAspectRatio="none" role="img" aria-label="Price sparkline">
      <line x1="0" x2="300" y1={d.base} y2={d.base} className="spark-base" />
      <path d={d.line} className="spark-line" />
    </svg>
  );
}

export function Sparkline({ points, baseline, height = 56 }: { points: { t: number; equity: number }[]; baseline: number; height?: number }) {
  const d = useMemo(() => {
    const series = points.length > 1 ? points : [{ t: 0, equity: baseline }, { t: 1, equity: points[0]?.equity ?? baseline }];
    const vals = series.map((p) => p.equity);
    const min = Math.min(...vals, baseline);
    const max = Math.max(...vals, baseline);
    const span = max - min || 1;
    const w = 300;
    const xy = series.map((p, i) => [(i / (series.length - 1)) * w, height - 4 - ((p.equity - min) / span) * (height - 8)] as const);
    const line = xy.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
    const base = height - 4 - ((baseline - min) / span) * (height - 8);
    return { line, area: `${line} L${w},${height} L0,${height} Z`, base, up: vals[vals.length - 1] >= baseline };
  }, [points, baseline, height]);
  return (
    <svg className={`spark ${d.up ? "up" : "down"}`} viewBox={`0 0 300 ${height}`} preserveAspectRatio="none" role="img" aria-label="Equity sparkline">
      <line x1="0" x2="300" y1={d.base} y2={d.base} className="spark-base" />
      <path d={d.area} className="spark-area" />
      <path d={d.line} className="spark-line" />
    </svg>
  );
}

/**
 * Stop → trail progress. Left edge is the hard stop, right edge is the trail arm price
 * (or the peak once it is past the arm). The fill shows where the mark sits.
 */
export function StopTrailBar({ stop, entry, mark, peak, armPct, trailOn }: { stop: number; entry: number; mark: number; peak: number; armPct: number; trailOn: boolean }) {
  const arm = entry * (1 + armPct);
  const hi = Math.max(arm, peak);
  const lo = stop;
  const span = hi - lo;
  const at = (p: number) => (span > 0 ? Math.min(100, Math.max(0, ((p - lo) / span) * 100)) : 50);
  const fill = at(mark);
  const toStop = mark > 0 ? stop / mark - 1 : null;
  const fromEntry = entry > 0 && stop > 0 ? stop / entry - 1 : null;
  const danger = fill < 25;
  return (
    <div className="stopbar" aria-label="Stop to trail progress">
      <div className="stopbar-track">
        <span className={`stopbar-fill${danger ? " near-stop" : ""}`} style={{ width: `${fill}%` }} />
        <i className="stopbar-entry" style={{ left: `${at(entry)}%` }} title="Entry" />
        <b className="stopbar-mark" style={{ left: `${fill}%` }} />
      </div>
      <div className="stopbar-labels">
        <span className="down">{stopLabel(fromEntry, toStop)}</span>
        <span>entry</span>
        <span>{trailOn ? (peak >= arm ? "Trailing" : `Trail arms +${Math.round(armPct * 100)}%`) : `Trail off · +${Math.round(armPct * 100)}%`}</span>
      </div>
    </div>
  );
}
