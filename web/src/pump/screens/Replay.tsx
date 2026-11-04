import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";

interface ReplayFrame {
  index: number;
  at: number;
  signature: string;
  mint: string;
  symbol?: string;
  side: "buy" | "sell";
  marketCapLamports: string;
  solLamports: string;
}

/** Scrub confirmed trades along the market-cap curve. */
export function ReplayScreen() {
  const [frames, setFrames] = useState<ReplayFrame[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let gone = false;
    void api<{ frames?: ReplayFrame[] }>("/api/pump/journal/replay").then((res) => {
      if (gone) return;
      if (!res.ok) {
        setError(res.body.error ?? "Replay unavailable.");
        return;
      }
      const next = res.body.frames ?? [];
      setFrames(next);
      setIndex(next.length > 0 ? next.length - 1 : 0);
    });
    return () => {
      gone = true;
    };
  }, []);

  const frame = frames[index] ?? null;
  const points = useMemo(() => chartPoints(frames), [frames]);
  const fill = frames.length <= 1 ? 0 : (index / (frames.length - 1)) * 100;

  return (
    <section className="card" aria-label="Trade replay">
      <header>
        <h3>Replay</h3>
        <span>{frames.length === 0 ? "empty" : `${index + 1} / ${frames.length}`}</span>
      </header>
      <p className="fine">Scrub through confirmed trades. The line is market cap at each fill.</p>
      {error ? <p className="warn">{error}</p> : null}
      {frames.length === 0 ? <p className="empty">No trades to replay.</p> : null}
      {points ? (
        <svg viewBox="0 0 320 120" role="img" aria-label="Market cap replay" style={{ width: "100%", height: 140 }}>
          <polyline fill="none" stroke="currentColor" strokeWidth="2" points={points} />
          {framePoint(frames, index) ? <circle cx={framePoint(frames, index)!.x} cy={framePoint(frames, index)!.y} r="4" fill="currentColor" /> : null}
        </svg>
      ) : null}
      {frames.length > 0 ? (
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={index}
          aria-label="Replay scrubber"
          style={{ ["--fill" as string]: `${fill}%` }}
          onChange={(event) => setIndex(Number(event.target.value))}
        />
      ) : null}
      {frame ? (
        <p className="fine">
          {frame.side} {frame.symbol ?? frame.mint} · {sol(frame.solLamports)} SOL · mcap {sol(frame.marketCapLamports)} SOL · {new Date(frame.at).toISOString()}
        </p>
      ) : null}
    </section>
  );
}

function sol(raw: string): string {
  if (!/^\d+$/.test(raw)) return raw;
  const whole = BigInt(raw) / 1_000_000_000n;
  const frac = (BigInt(raw) % 1_000_000_000n).toString().padStart(4, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function chartPoints(frames: ReplayFrame[]): string {
  if (frames.length === 0) return "";
  return frames
    .map((frame, i) => {
      const p = locate(frames, i);
      return `${p.x},${p.y}`;
    })
    .join(" ");
}

function framePoint(frames: ReplayFrame[], index: number): { x: number; y: number } | null {
  if (!frames[index]) return null;
  return locate(frames, index);
}

function locate(frames: ReplayFrame[], index: number): { x: number; y: number } {
  const caps = frames.map((frame) => Number(frame.marketCapLamports));
  const min = Math.min(...caps);
  const max = Math.max(...caps);
  const span = max - min || 1;
  const x = frames.length === 1 ? 160 : 8 + (index / (frames.length - 1)) * 304;
  const y = 108 - ((caps[index]! - min) / span) * 96;
  return { x, y };
}
