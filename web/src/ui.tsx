import { useMemo, type ReactNode } from "react";
import { signedPct, signedUsd } from "./format";

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
  bell: <path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4" />
};

export function Icon({ name, size = 22 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? null}
    </svg>
  );
}

const AVATAR_TONES = ["#4a4a4a", "#5a5a5a", "#3e3e3e", "#666666", "#525252", "#444444"];

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
  const danger = fill < 25;
  return (
    <div className="stopbar" aria-label="Stop to trail progress">
      <div className="stopbar-track">
        <span className={`stopbar-fill${danger ? " near-stop" : ""}`} style={{ width: `${fill}%` }} />
        <i className="stopbar-entry" style={{ left: `${at(entry)}%` }} title="Entry" />
        <b className="stopbar-mark" style={{ left: `${fill}%` }} />
      </div>
      <div className="stopbar-labels">
        <span className="down">Stop {toStop != null ? signedPct(toStop) : "—"}</span>
        <span>entry</span>
        <span>{trailOn ? (peak >= arm ? "Trailing" : `Trail arms +${Math.round(armPct * 100)}%`) : `Trail off · +${Math.round(armPct * 100)}%`}</span>
      </div>
    </div>
  );
}
