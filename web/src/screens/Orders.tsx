import { useState } from "react";
import type { DeskSnapshot } from "../types";
import { api } from "../api";
import type { DeskActions } from "../App";
import { px, usd } from "../format";
import { newIdemKey } from "../onetap";
import { BASIS_LABEL, SIDE_SHORT, basesFor, defaultValue, orderStatusText, ordersFor, previewTrigger, type DeskOrderView, type TicketBasis, type TicketSide } from "../orderTicket";

type Book = "paper" | "live";

/**
 * v13.11 compact order ticket: side, trigger (% entry / % now / price / market cap), amount, place.
 * Sells sit on a held position (paper 25/50/100%, live 100%). Limit buys pick the book.
 */
export function OrderTicket({
  snap,
  actions,
  mint,
  symbol,
  sides,
  book: fixedBook,
  mark,
  entry,
  stopPrice,
  onClose
}: {
  snap: DeskSnapshot;
  actions: DeskActions;
  mint: string;
  symbol: string;
  sides: TicketSide[];
  book?: Book;
  mark: number | null;
  entry: number | null;
  stopPrice?: number | null;
  onClose: () => void;
}) {
  const [side, setSide] = useState<TicketSide>(sides[0]);
  const [basis, setBasis] = useState<TicketBasis>(basesFor(sides[0])[0]);
  const [value, setValue] = useState(defaultValue(sides[0], basesFor(sides[0])[0]));
  const [pct, setPct] = useState<25 | 50 | 100>(100);
  const [book, setBook] = useState<Book>(fixedBook ?? (snap.liveBook ? "live" : "paper"));
  const [size, setSize] = useState(String(book === "live" ? snap.prefs.liveTradeUsd ?? 5 : actions.tapUsd));
  const [busy, setBusy] = useState(false);
  const live = book === "live";
  const n = Number(value.replace(/[,$%\s]/g, ""));
  const preview = previewTrigger(basis, n, { mark, entry });
  const pick = (s: TicketSide) => {
    setSide(s);
    const b = basesFor(s).includes(basis) ? basis : basesFor(s)[0];
    setBasis(b);
    setValue(defaultValue(s, b));
  };
  const place = async () => {
    setBusy(true);
    const body: Record<string, unknown> = { side, mint, basis, value: n, book, idemKey: newIdemKey() };
    if (side === "limit_buy") body.sizeUsd = Number(size);
    else body.percent = live ? 100 : pct;
    const res = await api<{ text?: string }>("/api/orders", { body });
    setBusy(false);
    actions.notify({ ok: res.ok, toast: true, text: res.ok ? res.body.text ?? "Order placed." : `${symbol}: ${res.body.error ?? "Order refused."}` });
    if (res.ok) onClose();
  };
  return (
    <div className={`order-ticket${live ? " live" : ""}`} role="group" aria-label={`Order on ${symbol}`} onClick={(e) => e.stopPropagation()}>
      <div className="ot-row">
        {sides.map((s) => (
          <button key={s} type="button" className={`ot-chip side-${s}${side === s ? " on" : ""}`} onClick={() => pick(s)}>
            {SIDE_SHORT[s]}
          </button>
        ))}
        {side === "limit_buy" && !fixedBook ? (
          <span className="ot-book">
            {(["paper", "live"] as const).map((b) => (
              <button
                key={b}
                type="button"
                className={`ot-chip book-${b}${book === b ? " on" : ""}`}
                onClick={() => {
                  setBook(b);
                  setSize(String(b === "live" ? snap.prefs.liveTradeUsd ?? 5 : actions.tapUsd));
                }}
              >
                {b === "live" ? "LIVE" : "PAPER"}
              </button>
            ))}
          </span>
        ) : (
          <span className={`book-tag ${live ? "live" : "paper"}`}>{live ? "LIVE" : "PAPER"}</span>
        )}
        <button type="button" className="ot-x" aria-label="Close order ticket" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="ot-row">
        {basesFor(side).map((b) => (
          <button
            key={b}
            type="button"
            className={`ot-chip basis${basis === b ? " on" : ""}`}
            onClick={() => {
              setBasis(b);
              setValue(defaultValue(side, b));
            }}
          >
            {BASIS_LABEL[b]}
          </button>
        ))}
      </div>
      <div className="ot-row">
        <label className="ot-input">
          <span>{basis === "price" ? "$" : basis === "mcap" ? "MCap $" : "%"}</span>
          <input
            inputMode="decimal"
            value={value}
            placeholder={basis === "price" ? (mark ? px(mark).replace("$", "") : "price") : basis === "mcap" ? "e.g. 250000" : "%"}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Trigger"
          />
        </label>
        {side === "limit_buy" ? (
          <label className="ot-input size">
            <span>$</span>
            <input inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} aria-label="Buy size" />
          </label>
        ) : live ? (
          <span className="ot-chip on">100%</span>
        ) : (
          ([25, 50, 100] as const).map((p) => (
            <button key={p} type="button" className={`ot-chip${pct === p ? " on" : ""}`} onClick={() => setPct(p)}>
              {p}%
            </button>
          ))
        )}
      </div>
      <p className="ot-preview">
        {basis === "mcap" ? "Desk converts the market cap to a price." : preview ? `Trigger ${px(preview)}` : "Enter a number."}
        {mark ? ` · now ${px(mark)}` : ""}
        {side === "stop_sell" && stopPrice ? ` · hard stop ${px(stopPrice)} stays the floor; your stop can only be tighter.` : ""}
        {live && !snap.liveBook ? " · waiting: live not armed (never fills on paper)." : ""}
      </p>
      <button type="button" className={`ot-place side-${side}`} disabled={busy || !Number.isFinite(n) || value.trim() === ""} onClick={() => void place()}>
        {busy ? "Placing…" : `Place ${SIDE_SHORT[side].toLowerCase()}${side === "limit_buy" ? ` ${usd(Number(size) || 0, 0)}` : ` ${live ? 100 : pct}%`}${live ? " LIVE" : ""}`}
      </button>
    </div>
  );
}

async function cancel(o: DeskOrderView, actions: DeskActions) {
  const res = await api("/api/orders/cancel", { body: { id: o.id } });
  actions.notify({ ok: res.ok, toast: true, text: res.ok ? `Canceled: ${o.text}` : res.body.error ?? "Cancel failed." });
}

/** Small chips under a card: this coin's open orders, each with ✕. */
export function OrderChips({ snap, actions, mint, book }: { snap?: DeskSnapshot; actions: DeskActions; mint: string; book?: Book }) {
  const rows = ordersFor(snap, mint, book);
  if (!rows.length) return null;
  return (
    <div className="order-chips">
      {rows.map((o) => (
        <span key={o.id} className={`order-chip side-${o.side}${o.waiting ? " waiting" : ""}`} title={o.text}>
          {o.book === "live" ? <b className="lv">LIVE</b> : null}
          {SIDE_SHORT[o.side]} {px(o.triggerPrice)}
          {o.side !== "limit_buy" ? ` · ${Math.round((o.fraction ?? 1) * 100)}%` : ""}
          <small>{orderStatusText(o)}</small>
          <button type="button" aria-label={`Cancel ${o.text}`} onClick={(e) => (e.stopPropagation(), void cancel(o, actions))}>
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

/** Home: every open order with Cancel, then the last few that filled, failed or were canceled. */
export function OpenOrdersCard({ snap, actions }: { snap: DeskSnapshot; actions: DeskActions }) {
  const all = snap.orders ?? [];
  const open = all.filter((o) => o.status === "open" || o.status === "working");
  const done = all.filter((o) => o.status !== "open" && o.status !== "working").slice(0, 5);
  return (
    <section className="card orders-card" aria-label="Orders">
      <header>
        <h3>Orders</h3>
        <span className="muted">{open.length} open</span>
      </header>
      {open.length === 0 ? <p className="empty">No open orders. Set a stop or take profit on a position, or a limit buy on a Tape coin.</p> : null}
      <ul className="order-list">
        {open.map((o) => (
          <li key={o.id} className={`order-row side-${o.side}${o.waiting ? " waiting" : ""}`}>
            <span className={`ord-side side-${o.side}`}>{SIDE_SHORT[o.side]}</span>
            <span className="ord-main">
              <b>
                {o.book === "live" ? <span className="book-tag live">LIVE</span> : <span className="book-tag paper">PAPER</span>} {o.symbol}
                {o.side === "limit_buy" ? (o.sizeUsd ? ` · ${usd(o.sizeUsd, 0)}` : "") : ` · ${Math.round((o.fraction ?? 1) * 100)}%`}
              </b>
              <span className={`ord-trig side-${o.side}`}>
                @ {px(o.triggerPrice)}
                {o.markUsd ? ` · now ${px(o.markUsd)}` : ""}
              </span>
              <small className={o.waiting ? "wait" : undefined}>{orderStatusText(o)}</small>
            </span>
            {o.status === "open" ? (
              <button type="button" className="ord-cancel" onClick={() => void cancel(o, actions)}>
                Cancel
              </button>
            ) : (
              <span className="muted">firing…</span>
            )}
          </li>
        ))}
        {done.map((o) => (
          <li key={o.id} className={`order-row done st-${o.status}`}>
            <span className={`ord-side side-${o.side}`}>{SIDE_SHORT[o.side]}</span>
            <span className="ord-main">
              <b>
                {o.book === "live" ? "LIVE " : ""}
                {o.symbol} @ {px(o.triggerPrice)} · {o.status}
              </b>
              <small>{o.note ?? ""}</small>
            </span>
          </li>
        ))}
      </ul>
      <p className="fine">Orders fire on the same fresh price the hard stop uses and go through every buy/sell check. A refusal is shown here, never a silent fill. Your −{(snap.rules.stopLossPct * 100).toFixed(0)}% hard stop stays the floor.</p>
    </section>
  );
}
