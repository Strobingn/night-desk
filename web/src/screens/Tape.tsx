import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { countNewSince, initialTapeFollow, pausedLabel, stepTapeFollow, type TapeFollowState } from "../../../src/desk/tape-follow";
import { api } from "../api";
import { clock } from "../format";
import type { DeskSnapshot, FeedEvent } from "../types";
import { mergeEvents, type DeskActions } from "../App";

const LOG_STAGES = ["all", "scout", "filter", "analyst", "executor", "risk", "system", "logger"] as const;

export function TapeScreen({
  snap,
  history,
  setHistory,
  actions,
  busy
}: {
  snap: DeskSnapshot;
  history: FeedEvent[];
  setHistory: Dispatch<SetStateAction<FeedEvent[]>>;
  actions: DeskActions;
  busy: string | null;
}) {
  const [stageFilter, setStageFilter] = useState<(typeof LOG_STAGES)[number]>("all");
  const [selected, setSelected] = useState<{ mint: string; symbol: string } | null>(null);
  const [buySize, setBuySize] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const tapeRef = useRef<TapeFollowState>(initialTapeFollow);
  const [tape, setTape] = useState<TapeFollowState>(initialTapeFollow);
  const programmaticScroll = useRef(0);
  const viewAnchorRef = useRef<{ id: string; offset: number } | null>(null);
  const filterRef = useRef(stageFilter);
  const eventsRef = useRef<FeedEvent[]>([]);

  const events = history.filter((event) => stageFilter === "all" || event.stage === stageFilter);
  eventsRef.current = events;
  const tapePaused = tape.held || tape.away;
  const tapeFresh = countNewSince(
    events.map((event) => event.id),
    tape.seenId,
    tapePaused
  );
  const capText = snap.positionCapUsd > 0 ? snap.positionCapUsd.toFixed(2) : "";

  function applyTape(next: TapeFollowState) {
    const prev = tapeRef.current;
    tapeRef.current = next;
    if (prev.held !== next.held || prev.away !== next.away || prev.seenId !== next.seenId) setTape(next);
  }

  function captureViewAnchor(el: HTMLElement) {
    const top = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>("[data-event-id]");
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top + 1) {
        viewAnchorRef.current = { id: row.dataset.eventId || "", offset: box.top - top };
        return;
      }
    }
  }

  function restoreViewAnchor(el: HTMLElement) {
    const anchor = viewAnchorRef.current;
    if (!anchor?.id) return;
    const row = el.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(anchor.id)}"]`);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 1) assignScrollTop(el, el.scrollTop + delta);
  }

  function assignScrollTop(el: HTMLElement, top: number) {
    if (Math.abs(el.scrollTop - top) < 1) return;
    programmaticScroll.current += 1;
    el.scrollTop = top;
  }

  function noteUserScroll() {
    const el = rowsRef.current;
    if (!el) return;
    if (programmaticScroll.current > 0) {
      programmaticScroll.current -= 1;
      return;
    }
    const atLiveEdge = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    if (!atLiveEdge) captureViewAnchor(el);
    const result = stepTapeFollow(tapeRef.current, {
      ids: eventsRef.current.map((event) => event.id),
      userMoved: true,
      atLiveEdge,
      pause: false,
      goLive: false,
      filterChanged: false
    });
    applyTape(result.state);
    if (result.follow) {
      viewAnchorRef.current = null;
      assignScrollTop(el, el.scrollHeight);
    }
  }

  function pauseTape() {
    const el = rowsRef.current;
    if (el) captureViewAnchor(el);
    const result = stepTapeFollow(tapeRef.current, {
      ids: eventsRef.current.map((event) => event.id),
      userMoved: false,
      atLiveEdge: false,
      pause: true,
      goLive: false,
      filterChanged: false
    });
    applyTape(result.state);
  }

  function goLiveTape() {
    const el = rowsRef.current;
    const result = stepTapeFollow(tapeRef.current, {
      ids: eventsRef.current.map((event) => event.id),
      userMoved: false,
      atLiveEdge: true,
      pause: false,
      goLive: true,
      filterChanged: false
    });
    applyTape(result.state);
    viewAnchorRef.current = null;
    if (el) assignScrollTop(el, el.scrollHeight);
  }

  const eventKey = `${stageFilter}\0${events.map((event) => event.id).join("\0")}`;
  useLayoutEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const filterChanged = filterRef.current !== stageFilter;
    filterRef.current = stageFilter;
    const result = stepTapeFollow(tapeRef.current, {
      ids: eventsRef.current.map((event) => event.id),
      userMoved: false,
      atLiveEdge: false,
      pause: false,
      goLive: false,
      filterChanged
    });
    applyTape(result.state);
    if (result.follow) {
      viewAnchorRef.current = null;
      assignScrollTop(el, el.scrollHeight);
    } else if (filterChanged) {
      viewAnchorRef.current = null;
    } else if (result.anchor) {
      restoreViewAnchor(el);
    }
  }, [eventKey, stageFilter]);

  async function loadEarlier() {
    const oldest = history[0]?.ts;
    if (!oldest) return;
    const res = await api<{ events?: FeedEvent[] }>(`/api/events?limit=800&before=${oldest}`);
    if (!res.ok) {
      setLogError(res.body.error ?? "Log failed");
      return;
    }
    setLogError(null);
    setHistory((prev) => mergeEvents(res.body.events ?? [], prev));
  }

  function buySelected() {
    if (!selected) return;
    const trimmed = buySize.trim();
    let sizeUsd: number | undefined;
    if (trimmed) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) {
        actions.notify({ ok: false, text: "Size must be a positive dollar amount, or blank for the cap." });
        return;
      }
      sizeUsd = n;
    }
    actions.askBuy({ mint: selected.mint, symbol: selected.symbol, sizeUsd, minutesLeft: null });
  }

  return (
    <div className="tape-screen">
      <div className="tape-head">
        <h2>Activity log</h2>
        <button className={`live-toggle${tapePaused ? " on" : ""}`} type="button" onClick={() => (tapePaused ? goLiveTape() : pauseTape())}>
          {tapePaused ? "Live" : "Pause"}
        </button>
      </div>
      <div className="filters" role="tablist" aria-label="Log stage">
        {LOG_STAGES.map((stage) => (
          <button key={stage} type="button" className={stageFilter === stage ? "on" : ""} onClick={() => setStageFilter(stage)}>
            {stage}
          </button>
        ))}
      </div>
      {logError ? <div className="banner">{logError}</div> : null}
      <form
        className="buybar"
        onSubmit={(event) => {
          event.preventDefault();
          buySelected();
        }}
      >
        {selected ? (
          <>
            <label>
              Buy {selected.symbol}
              <input
                aria-label="Manual size in dollars"
                inputMode="decimal"
                placeholder={capText ? `Cap ${capText}` : "USD cap"}
                value={buySize}
                onChange={(event) => setBuySize(event.target.value)}
              />
            </label>
            <button className="primary" type="submit" disabled={busy === selected.mint}>
              {busy === selected.mint ? "Buying" : "Buy"}
            </button>
            <button className="ghost" type="button" onClick={() => actions.openAddCoin(selected.mint)}>
              Look up
            </button>
            <button className="ghost" type="button" onClick={() => setSelected(null)}>
              Clear
            </button>
          </>
        ) : (
          <p className="empty">
            Select a mint on the tape to buy. The size starts at the current cap{capText ? ` ($${capText})` : ""}. A larger request is filled at the cap. No add while that mint is open.
          </p>
        )}
      </form>
      <div className="rows-wrap">
        <div className="rows" aria-live="polite" ref={rowsRef} onScroll={() => noteUserScroll()}>
          <button className="ghost earlier" type="button" onClick={() => void loadEarlier()}>
            Load earlier
          </button>
          {events.length === 0 ? (
            <p className="empty">No lines for this filter. The desk log on disk keeps every stage across restarts.</p>
          ) : (
            events.map((event) => (
              <Row
                key={event.id}
                event={event}
                selected={selected?.mint === event.mint}
                onSelect={
                  event.mint
                    ? () => {
                        setSelected({ mint: event.mint!, symbol: event.symbol ?? event.mint!.slice(0, 4) });
                        setBuySize(capText);
                      }
                    : undefined
                }
              />
            ))
          )}
        </div>
        {tapePaused ? (
          <button className="jump" type="button" onClick={() => goLiveTape()}>
            {pausedLabel(tapeFresh)}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Row({ event, selected, onSelect }: { event: FeedEvent; selected: boolean; onSelect?: () => void }) {
  return (
    <article className={`row ${event.kind}${selected ? " selected" : ""}`} data-event-id={event.id}>
      <time className="when">{clock(event.ts)}</time>
      <span className={`tag ${event.stage}`}>{event.stage}</span>
      <div className="msg">
        {event.code ? <code>{event.code}</code> : null} {event.code ? "· " : null}
        {event.message}
        {event.detail ? <span className="detail"> · {event.detail}</span> : null}
        {onSelect ? (
          <button className="ghost select" type="button" onClick={onSelect}>
            {selected ? "Selected" : "Select"}
          </button>
        ) : null}
      </div>
    </article>
  );
}
