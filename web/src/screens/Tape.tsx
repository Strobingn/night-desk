import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { countNewSince, initialTapeFollow, pausedLabel, stepTapeFollow, type TapeFollowState } from "../../../src/desk/tape-follow";
import { api } from "../api";
import { clock } from "../format";
import type { DeskSnapshot, FeedEvent } from "../types";
import { mergeEvents, type DeskActions } from "../App";
import { OneTapBar, TapBuyButton, TapSellButton } from "./OneTap";
import { slipText, tapUsdText } from "../tapeToolbar";
import { ScoutStatus } from "./ScoutStatus";
import { coinCards, HOT_RANK, parseTapeSort, sortCoins, TAPE_SORT_KEY, TAPE_SORTS, TOP_VOLUME, VERDICT_LABEL, type CoinRow, type TapeSort, type Verdict } from "../coins";
import { compactUsd } from "../format";
import { shortPx } from "../tapeToolbar";
import { CoinAvatar, Icon } from "../ui";

const COIN_FILTERS = ["all", "open", "trade", "near", "killed"] as const;
const COIN_FILTER_LABEL: Record<(typeof COIN_FILTERS)[number], string> = { all: "All", open: "Open", trade: "Passed", near: "Near miss", killed: "Killed" };

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
  const [view, setView] = useState<"coins" | "log">("coins");
  const [coinFilter, setCoinFilter] = useState<(typeof COIN_FILTERS)[number]>("all");
  // v13.1: per-device sort, Volume by default. Saved in this browser only, never sent to the desk.
  const [sort, setSortState] = useState<TapeSort>(() => {
    try {
      return parseTapeSort(localStorage.getItem(TAPE_SORT_KEY));
    } catch {
      return "volume";
    }
  });
  function setSort(next: TapeSort) {
    setSortState(next);
    try {
      localStorage.setItem(TAPE_SORT_KEY, next);
    } catch {
      /* private mode: keep it for this session only */
    }
  }
  const [stageFilter, setStageFilter] = useState<(typeof LOG_STAGES)[number]>("all");
  // v13.4: the One Tap controls open in a bottom sheet from the slim chip.
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);
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

  const openMints = new Set(snap.positions.map((pos) => pos.mint));
  const coins = view === "coins" ? sortCoins(coinCards(history, openMints).filter((c) => coinFilter === "all" || c.verdict === coinFilter || (coinFilter === "trade" && c.verdict === "bought")), sort) : [];

  return (
    <div className="tape-screen">
      {/* v13.4 compact sticky toolbar: Scout line + view toggle, then one-tap chip, sort and filter. The list scrolls under it. */}
      <div className="tape-toolbar">
        <div className="tape-head">
          <ScoutStatus feed={snap.feed} compact />
          <div className="segmented compact" role="tablist" aria-label="Tape view">
            <button type="button" role="tab" aria-selected={view === "coins"} aria-label="Coins" title="Coins" className={view === "coins" ? "on" : ""} onClick={() => setView("coins")}>
              <Icon name="coins" size={16} /> <span className="seg-text">Coins</span>
            </button>
            <button type="button" role="tab" aria-selected={view === "log"} aria-label="Raw log" title="Raw log" className={view === "log" ? "on" : ""} onClick={() => setView("log")}>
              <Icon name="list" size={16} /> <span className="seg-text">Raw log</span>
            </button>
          </div>
          {view === "log" ? (
          <button className={`live-toggle${tapePaused ? " on" : ""}`} type="button" onClick={() => (tapePaused ? goLiveTape() : pauseTape())}>
            {tapePaused ? "Live" : "Pause"}
          </button>
          ) : null}
        </div>
        {view === "coins" ? (
          <div className="tape-tools">
            <button type="button" className="onetap-chip" aria-label="One-tap size and slippage" aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
              ⚡ {tapUsdText(actions.tapUsd)} · slip {slipText(snap.rules.maxEntrySlippage)}% <span aria-hidden="true">▴</span>
            </button>
            <label className="tool-select" title="Sort">
              <span aria-hidden="true">↕</span>
              <select aria-label="Tape sort" value={sort} onChange={(event) => setSort(event.target.value as TapeSort)}>
                {TAPE_SORTS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="tool-select" title="Filter">
              <select aria-label="Coin verdict" value={coinFilter} onChange={(event) => setCoinFilter(event.target.value as (typeof COIN_FILTERS)[number])}>
                {COIN_FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {COIN_FILTER_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
        <div className="filters" role="tablist" aria-label="Log stage">
          {LOG_STAGES.map((stage) => (
            <button key={stage} type="button" className={stageFilter === stage ? "on" : ""} onClick={() => setStageFilter(stage)}>
              {stage}
            </button>
          ))}
        </div>
        )}
      </div>
      {logError ? <div className="banner">{logError}</div> : null}
      {sheetOpen && view === "coins" ? (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <section className="sheet" role="dialog" aria-modal="true" aria-label="One tap settings" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" aria-hidden="true" />
            <header>
              <h3>One tap</h3>
              <button type="button" className="ghost" onClick={() => setSheetOpen(false)}>
                Done
              </button>
            </header>
            <OneTapBar snap={snap} actions={actions} />
            <p className="fine">
              Tap ⚡ Buy to paper-buy now at your one-tap size, or Buy… to pick a size first (cap{capText ? ` $${capText}` : ""}). No add while a mint is open.
            </p>
          </section>
        </div>
      ) : null}
      <form
        className={`buybar${view === "coins" && !selected ? " hidden" : ""}`}
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
            {`Select a mint on the tape to buy. The size starts at the current cap${capText ? ` ($${capText})` : ""}. A larger request is filled at the cap. No add while that mint is open.`}
          </p>
        )}
      </form>
      {view === "coins" ? (
        <div className="coin-list" aria-live="polite">
          {coins.length === 0 ? (
            <p className="empty">No coins for this filter yet. The Scout adds a card as each new pair lands.</p>
          ) : (
            coins.map((coin) => (
              <CoinCard
                key={coin.mint}
                coin={coin}
                selected={selected?.mint === coin.mint}
                busy={busy === coin.mint}
                actions={actions}
                onSelect={() => {
                  setSelected({ mint: coin.mint, symbol: coin.symbol });
                  setBuySize(capText);
                }}
                onBuy={() => actions.askBuy({ mint: coin.mint, symbol: coin.symbol, minutesLeft: null })}
              />
            ))
          )}
        </div>
      ) : (
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
      )}
    </div>
  );
}

function CoinCard({ coin, selected, busy, actions, onSelect, onBuy }: { coin: CoinRow; selected: boolean; busy: boolean; actions: DeskActions; onSelect: () => void; onBuy: () => void }) {
  const tone: Record<Verdict, "up" | "down" | "flat"> = { open: "up", bought: "up", trade: "up", near: "flat", killed: "down", seen: "flat" };
  const rank = coin.volRank;
  const top = rank != null && rank <= TOP_VOLUME;
  const hot = rank != null && rank <= HOT_RANK;
  const ch = coin.change1h;
  const chTone = ch == null || !Number.isFinite(ch) ? "flat" : ch > 0 ? "up" : ch < 0 ? "down" : "flat";
  return (
    <article className={`coin-card v-${coin.verdict}${selected ? " selected" : ""}${top ? " top-vol" : ""}${hot ? " hot" : ""}`} onClick={onSelect} data-mint={coin.mint}>
      {/* v13.4 compact card: same facts and buttons, three rows. */}
      <div className="cc-top">
        <CoinAvatar symbol={coin.symbol} mint={coin.mint} tone={tone[coin.verdict]} size={36} />
        <div className="cc-name">
          <div className="cc-title-row">
            <b>{coin.symbol}</b>
            <span className="cc-chips">
              <span className={`verdict-chip v-${coin.verdict}`}>{VERDICT_LABEL[coin.verdict]}</span>
              {hot ? <span className="vol-badge hot" title={`#${rank} by 1h volume`}>HOT #{rank}</span> : top ? <span className="vol-badge" title={`#${rank} by 1h volume`}>VOL #{rank}</span> : null}
            </span>
          </div>
          <span className="cc-meta">
            {coin.source ?? "scout"} · {clock(coin.lastTs || Date.now())}
            {coin.score != null ? (
              <span className={`score-inline${coin.verdict === "trade" || coin.verdict === "bought" || coin.verdict === "open" ? " pass" : ""}`} title="Analyst score">
                {" "}· score {coin.score.toFixed(2)}
              </span>
            ) : null}
          </span>
        </div>
        <div className={`cc-chgbox ${chTone}`} title="1h price change">
          <b>{ch == null || !Number.isFinite(ch) ? "—" : `${ch > 0 ? "+" : ch < 0 ? "−" : ""}${Math.abs(ch).toFixed(1)}%`}</b>
          <span className="k">1h chg</span>
        </div>
      </div>
      <div className="cc-stats inline">
        <div className="cc-stat vol">
          <span className="k">1h vol</span>
          <b>{coin.vol1h != null ? compactUsd(coin.vol1h) : "—"}</b>
        </div>
        <div className="cc-stat">
          <span className="k">5m vol</span>
          <b>{coin.vol5m != null ? compactUsd(coin.vol5m) : "—"}</b>
        </div>
        <div className="cc-stat">
          <span className="k">Price</span>
          <b>{coin.mark ? shortPx(coin.mark) : "—"}</b>
        </div>
      </div>
      <div className="cc-foot">
        <span className="cc-reason">{coin.codes.length ? <code>{coin.codes[0]}</code> : null} {coin.reason ?? ""}</span>
        {coin.verdict !== "open" ? (
          <span className="cc-buys">
            <TapBuyButton mint={coin.mint} symbol={coin.symbol} actions={actions} />
            <button
              className="tonal sm"
              type="button"
              disabled={busy}
              title="Buy with the confirm dialog (size, Buy anyway)"
              onClick={(event) => {
                event.stopPropagation();
                onBuy();
              }}
            >
              {busy ? "Buying" : "Buy"}…
            </button>
          </span>
        ) : (
          <span className="cc-buys">
            <span className="verdict-chip v-open">Holding</span>
            <TapSellButton mint={coin.mint} symbol={coin.symbol} actions={actions} />
          </span>
        )}
      </div>
    </article>
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
