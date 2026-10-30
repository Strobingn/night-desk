import { useEffect, useState } from "react";
import type { DeskSnapshot } from "../types";

type Source = NonNullable<DeskSnapshot["feed"]["sources"]>[number];

/** v12.1: each Scout source's state — live, backing off (with countdown), down, or off. */
export function ScoutStatus({ feed }: { feed: DeskSnapshot["feed"] }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const counting = (feed.sources ?? []).some((s) => s.state === "backoff" && s.retryAt);
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [counting]);
  const sources = feed.sources ?? [];
  if (!sources.length) return null;
  const live = sources.filter((s) => s.state === "live").length;
  // v12.3: collapsible. Collapsed still lists any source that is backing off or down.
  const shown = open ? sources : sources.filter((s) => s.state === "backoff" || s.state === "down");
  return (
    <section className="card scout-status" aria-label="Scout status">
      <header>
        <button type="button" className="scout-toggle" aria-expanded={open} aria-label={open ? "Collapse Scout status" : "Expand Scout status"} onClick={() => setOpen((v) => !v)}>
          <h3>Scout status</h3>
          <span>
            {live}/{sources.length} live · {sources.reduce((n, s) => n + s.sightingsPerMin, 0)} coins/min
          </span>
          <b aria-hidden="true">{open ? "▾" : "▸"}</b>
        </button>
      </header>
      <ul>
        {shown.map((s) => (
          <li key={s.id} className={`src ${s.state}`}>
            <i aria-hidden="true" />
            <b>{s.label}</b>
            <em>{stateText(s, now)}</em>
            <small>{rateText(s)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function stateText(s: Source, now: number): string {
  if (s.state === "live") return s.id === "pump" ? "live · websocket" : "live";
  if (s.state === "off") return s.detail ? `off · ${s.detail}` : "off";
  if (s.state === "down") return s.detail ? `down · ${s.detail}` : "down";
  const left = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - now) / 1000)) : null;
  const wait = left != null && left > 0 ? ` · retry in ${left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : `${left}s`}` : "";
  return `backing off${wait}${s.detail ? ` · ${s.detail}` : ""}`;
}

function rateText(s: Source): string {
  if (s.id === "pump") return `${s.sightingsPerMin}/min new`;
  if (s.budgetPerMin == null) return "";
  return `${s.reqPerMin}/${s.budgetPerMin} req/min`;
}
