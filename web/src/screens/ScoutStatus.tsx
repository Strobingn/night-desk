import { useEffect, useState } from "react";
import type { DeskSnapshot } from "../types";
import { stateText } from "../feedText";
import { SCOUT_OPEN_KEY, scoutSummary } from "../tapeToolbar";

export { stateText };

type Source = NonNullable<DeskSnapshot["feed"]["sources"]>[number];

/** v12.1: each Scout source's state — live, backing off (with countdown), down, or off. */
export function ScoutStatus({ feed, compact = false }: { feed: DeskSnapshot["feed"]; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  // v13.4: the compact Tape line remembers open/closed in this browser. Collapsed by default.
  const [open, setOpenState] = useState(() => {
    if (!compact) return false;
    try {
      return localStorage.getItem(SCOUT_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setOpen = (next: (v: boolean) => boolean) =>
    setOpenState((v) => {
      const n = next(v);
      if (compact) {
        try {
          localStorage.setItem(SCOUT_OPEN_KEY, n ? "1" : "0");
        } catch {
          /* private mode */
        }
      }
      return n;
    });
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
  if (compact) {
    const sum = scoutSummary(sources);
    return (
      <section className={`scout-line${open ? " open" : ""}`} aria-label="Scout status">
        <button type="button" className={`scout-pill ${sum.tone}`} aria-expanded={open} aria-label={open ? "Collapse Scout status" : "Expand Scout status"} onClick={() => setOpen((v) => !v)}>
          <i aria-hidden="true" />
          <span>{sum.text}</span>
          {sum.badge ? <em>{sum.badge}</em> : null}
          <b aria-hidden="true">{open ? "▾" : "▸"}</b>
        </button>
        {open ? (
          <ul className="card scout-status">
            {sources.map((s) => (
              <li key={s.id} className={`src ${s.state}`}>
                <i aria-hidden="true" />
                <b>{s.label}</b>
                <em>{stateText(s, now)}</em>
                <small>{rateText(s)}</small>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }
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
