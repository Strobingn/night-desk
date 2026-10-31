import { useEffect, useState } from "react";
import type { DeskSnapshot } from "../types";
import { stateText } from "../feedText";

export { stateText };

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
  const shown = open ? sources : sources.filter((s) => s.state === "backoff" || s.state === "down" || s.state === "stale");
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

function rateText(s: Source): string {
  if (s.id === "pump") return `${s.sightingsPerMin}/min new`;
  if (s.budgetPerMin == null) return "";
  return `${s.reqPerMin}/${s.budgetPerMin} req/min`;
}
