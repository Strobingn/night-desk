import { useMemo } from "react";
import type { ChartPoint } from "./curve";

/** Market cap over time. One point still draws, so the first tick is visible. */
export function CurveChart({ points }: { points: ChartPoint[] }) {
  const d = useMemo(() => {
    const series = points.length > 0 ? points : [];
    if (series.length === 0) return "";
    const vals = series.map((p) => Number(p.marketCapLamports));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const w = 320;
    const h = 140;
    return series
      .map((p, i) => {
        const x = series.length === 1 ? w / 2 : (i / (series.length - 1)) * w;
        const y = h - 8 - ((Number(p.marketCapLamports) - min) / span) * (h - 16);
        return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points]);
  return (
    <svg className="curve-chart" viewBox="0 0 320 140" role="img" aria-label="Market cap over time">
      <path d={d || "M0,70 L320,70"} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
