import { useCallback, useEffect, useRef, useState } from "react";
import { acceptSnapshot, mergeMarks, stampSnapshot } from "./marks";
import type { MarksDelta } from "../../src/types";
import { formatBuyNotice } from "../../src/desk/buy-notice";
import { api, authHeaders, withToken } from "./api";
import { signedPct, signedUsd, usd } from "./format";
import { AddCoinScreen } from "./screens/AddCoin";
import { HomeScreen } from "./screens/Home";
import { RecapScreen } from "./screens/Recap";
import { SettingsScreen } from "./screens/Settings";
import { TapeScreen } from "./screens/Tape";
import type { DeskSnapshot, FeedEvent } from "./types";
import { Icon } from "./ui";
import { TAP_SIZE_KEY, buyToast, defaultTapUsd, effectiveTapUsd, hardKillFollowUp, liveGateFollowUp, liveTapBlock, liveTapUsd, newIdemKey, sellToast, type BuyReply, type SellReply } from "./onetap";
import { PumpScreen } from "./pump/PumpScreen";
import { applyTheme, nextTheme, readThemePref, saveThemePref, THEME_OPTIONS, type ThemePref } from "./theme";

export const TABS = [
  { id: "home", label: "Home", icon: "home" },
  { id: "tape", label: "Tape", icon: "tape" },
  { id: "add", label: "Search", icon: "add" },
  { id: "recap", label: "Recap", icon: "recap" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "pump", label: "Pump", icon: "radar" }
] as const;
export type TabId = (typeof TABS)[number]["id"];

export interface Notice {
  ok: boolean;
  text: string;
  /** v13.3 one-tap result: floats above the tab bar so it shows wherever the tap was. */
  toast?: boolean;
}

/** One buy request waiting on the operator. Cooldown and hard kills both use "Buy anyway". */
export interface BuyAsk {
  mint: string;
  symbol: string;
  sizeUsd?: number;
  minutesLeft: number | null;
  hardKill?: string;
  confirmSize?: boolean;
  confirmHardKill?: boolean;
  /** v13.32 set when Buy anyway confirms a live tap. Omitted stays paper. */
  book?: "paper" | "live";
}

export interface DeskActions {
  notify: (notice: Notice) => void;
  /** Sends a paper buy. Returns true on a fill. Shows "Buy anyway" for a cooldown or a hard kill. */
  buy: (ask: BuyAsk) => Promise<boolean>;
  askBuy: (ask: BuyAsk) => void;
  sell: (mint: string, symbol: string, percent: 25 | 50 | 100, book?: "live") => Promise<void>;
  openAddCoin: (q: string) => void;
  /** v13.3 one tap: paper-buy now at the one-tap size. No dialog; every desk risk check still runs. */
  oneTapBuy: (mint: string, symbol: string, sizeUsd?: number) => Promise<void>;
  /** v13.9 one tap: real buy at the live size into the LIVE book. Never falls back to paper. */
  liveTapBuy?: (mint: string, symbol: string) => Promise<void>;
  /** v13.3 one tap: close the whole position now. No dialog. */
  oneTapSell: (mint: string, symbol: string, book?: "live") => Promise<void>;
  sellAll: () => Promise<void>;
  /** v13.3 one-tap size in dollars (this device). */
  tapUsd: number;
  /** v13.5 the desk is LIVE: one-tap buttons say so and use the live size. */
  live?: boolean;
  /** v13.7 armed desk keeping the AI on paper: a paper book and a separate live book. */
  split?: boolean;
  setTapUsd: (n: number) => void;
  /** v13.3 saves the entry (and optionally exit) slippage percent to the desk. */
  saveSlippage: (entryPct: number, exitPct?: number | null) => Promise<boolean>;
  /** Mints with a one-tap order in flight. */
  tapping: ReadonlySet<string>;
  theme: ThemePref;
  setTheme: (pref: ThemePref) => void;
}

function tabFromHash(): TabId {
  const raw = location.hash.replace(/^#/, "");
  return (TABS.find((t) => t.id === raw)?.id ?? "home") as TabId;
}

export function App() {
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const snapNow = useRef<DeskSnapshot | null>(null);
  snapNow.current = snap;
  const [offline, setOffline] = useState(false);
  const [denied, setDenied] = useState(false);
  const [history, setHistory] = useState<FeedEvent[]>([]);
  const [tab, setTabState] = useState<TabId>(() => (new URLSearchParams(location.search).get("add") ? "add" : tabFromHash()));
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice?.toast) return;
    const timer = window.setTimeout(() => setNotice((n) => (n === notice ? null : n)), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [buyAsk, setBuyAsk] = useState<BuyAsk | null>(null);
  const [addQuery, setAddQuery] = useState<{ q: string; n: number }>(() => ({ q: new URLSearchParams(location.search).get("add") ?? "", n: 0 }));
  const [busy, setBusy] = useState<string | null>(null);
  // v13.3 one tap. The ref is the double-tap guard (state updates are async); the set mirrors it for rendering.
  const inflight = useRef(new Set<string>());
  /** v13.5 current mode for confirm texts inside stable callbacks. */
  const modeRef = useRef<string>("paper");
  const splitRef = useRef(false);
  const [tapping, setTapping] = useState<ReadonlySet<string>>(() => new Set());
  const [tapSaved, setTapSaved] = useState<number | null>(() => {
    const raw = Number(localStorage.getItem(TAP_SIZE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  });
  const setTapUsd = useCallback((n: number) => {
    if (!Number.isFinite(n) || n <= 0) return;
    const v = Math.round(n * 100) / 100;
    setTapSaved(v);
    localStorage.setItem(TAP_SIZE_KEY, String(v));
  }, []);
  const [theme, setThemeState] = useState<ThemePref>(() => readThemePref());
  const setTheme = useCallback((pref: ThemePref) => {
    setThemeState(pref);
    saveThemePref(pref);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTab = useCallback((next: TabId) => {
    setTabState(next);
    if (location.hash !== `#${next}`) window.history.replaceState(null, "", `${location.pathname}${location.search}#${next}`);
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let stopped = false;
    void api<{ events?: FeedEvent[] }>("/api/events?limit=800").then((res) => {
      if (!stopped && res.ok) setHistory((prev) => mergeEvents(prev, res.body.events ?? []));
    });
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let seenSeq = 0;
    const apply = (data: DeskSnapshot) => {
      if (stopped) return;
      if (!acceptSnapshot(seenSeq, data)) return;
      if ((data.seq ?? 0) > seenSeq) seenSeq = data.seq ?? 0;
      setSnap(stampSnapshot(data, Date.now()));
      setHistory((prev) => mergeEvents(prev, data.events));
      setOffline(false);
      setDenied(false);
    };
    const pull = () => {
      fetch(withToken("/api/state"), { headers: authHeaders() })
        .then((res) => {
          if (res.status === 401) {
            setDenied(true);
            throw new Error("unauthorized");
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<DeskSnapshot>;
        })
        .then(apply)
        .catch(() => {
          if (!stopped) setOffline(true);
        });
    };
    pull();
    const poll = window.setInterval(pull, 2000);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    try {
      ws = new WebSocket(`${proto}://${location.host}${withToken("/ws")}`);
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as { type: string; data: unknown };
        if (msg.type === "snapshot") apply(msg.data as DeskSnapshot);
        // v13.2: small position-mark deltas between full snapshots.
        else if (msg.type === "marks" && !stopped) setSnap((prev) => mergeMarks(prev, msg.data as MarksDelta, Date.now()));
      };
      ws.onerror = () => setOffline(true);
    } catch {
      setOffline(true);
    }
    return () => {
      stopped = true;
      window.clearInterval(poll);
      ws?.close();
    };
  }, []);

  const minutesLeftFor = useCallback(
    (mint: string): number | null => {
      const row = snap?.cooldowns?.find((item) => item.mint === mint);
      return row && row.minutesLeft > 0 ? row.minutesLeft : null;
    },
    [snap]
  );

  const buy = useCallback(
    async (ask: BuyAsk): Promise<boolean> => {
      setBusy(ask.mint);
      const payload: Record<string, unknown> = { mint: ask.mint, book: ask.book === "live" ? "live" : "paper" };
      if (ask.sizeUsd != null) payload.sizeUsd = ask.sizeUsd;
      if (ask.minutesLeft != null || ask.book === "live") payload.ignoreCooldown = true;
      if (ask.confirmHardKill) payload.confirmHardKill = true;
      if (ask.confirmSize) payload.confirmSize = true;
      if (ask.book === "live") payload.idemKey = newIdemKey();
      const res = await api<{ symbol?: string; sizeUsd?: number; mode?: string; clampedFrom?: number }>("/api/positions/buy", { body: payload });
      setBusy(null);
      const body = res.body;
      if (body.code === "REVENGE_COOLDOWN" && ask.minutesLeft == null) {
        const parsed = /about (\d+) minute/.exec(body.error ?? "");
        setBuyAsk({ ...ask, symbol: body.symbol || ask.symbol, minutesLeft: parsed ? Number(parsed[1]) : minutesLeftFor(ask.mint) ?? 1 });
        return false;
      }
      if (body.code === "HARD_KILL" && !ask.confirmHardKill) {
        setBuyAsk({ ...ask, hardKill: body.error ?? "Hard kill." });
        return false;
      }
      setNotice({ ok: res.ok, text: formatBuyNotice(res.ok ? { ...body, ok: true } : { ...body, ok: false, error: body.error ?? `Buy failed (${res.status})` }) });
      return res.ok;
    },
    [minutesLeftFor]
  );

  const askBuy = useCallback(
    (ask: BuyAsk) => {
      if (snap?.positions.some((pos) => pos.mint === ask.mint)) {
        setNotice({ ok: false, text: `${ask.symbol} is already open. No add while that mint is open.` });
        return;
      }
      setBuyAsk({ ...ask, minutesLeft: ask.minutesLeft ?? minutesLeftFor(ask.mint) });
    },
    [snap, minutesLeftFor]
  );

  const sell = useCallback(async (mint: string, symbol: string, percent: 25 | 50 | 100, book?: "live") => {
    const verb = percent === 100 ? `Close ${symbol} at the mark?` : `Sell ${percent}% of ${symbol} at the mark?`;
    const how =
      book === "live" || (modeRef.current === "live" && !splitRef.current)
        ? "LIVE: a real on-chain sell from the desk wallet."
        : "Paper fill against the same pool model as a stop.";
    if (!window.confirm(`${verb} ${how} The hard stop still fires on its own.`)) return;
    setBusy(`${mint}:${percent}`);
    const res = await api<{ proceedsUsd?: number; error?: string; code?: string }>("/api/positions/sell", { body: { mint, percent, ...(book ? { book } : {}) } });
    setBusy(null);
    const refused = res.body.error ? `${res.body.error}${res.body.code ? ` (${res.body.code})` : ""}` : "Sell failed.";
    setNotice(
      res.ok
        ? { ok: true, text: percent === 100 ? `Closed ${symbol}.` : `Sold ${percent}% of ${symbol}${res.body.proceedsUsd != null ? ` for ${usd(res.body.proceedsUsd)}` : ""}.` }
        : { ok: false, text: refused }
    );
  }, []);

  const paperTapUsd = defaultTapUsd(tapSaved, snap?.prefs.defaultBuyUsd, snap?.positionCapUsd ?? 0);
  // Armed desk: the lightning button keeps the paper size. A non-split live desk still taps the live size.
  const tapUsd = snap?.liveBook != null ? paperTapUsd : effectiveTapUsd(snap?.mode, paperTapUsd, snap?.prefs.liveTradeUsd);

  const track = useCallback((key: string, on: boolean) => {
    if (on) inflight.current.add(key);
    else inflight.current.delete(key);
    setTapping(new Set(inflight.current));
  }, []);

  const oneTapBuy = useCallback(
    async (mint: string, symbol: string, sizeUsd?: number) => {
      const key = `buy:${mint}`;
      if (inflight.current.has(key)) return;
      track(key, true);
      const started = performance.now();
      const res = await api<BuyReply>("/api/positions/buy", { body: { mint, sizeUsd: sizeUsd ?? tapUsd, book: "paper", idemKey: newIdemKey(), oneTap: true } });
      track(key, false);
      const body = { ...res.body, ok: res.ok };
      const kill = hardKillFollowUp(body.code, body.error);
      if (kill) setBuyAsk({ mint, symbol, sizeUsd: sizeUsd ?? tapUsd, minutesLeft: null, hardKill: kill.reason });
      setNotice({ ok: res.ok, toast: true, text: buyToast(symbol, body, Math.round(performance.now() - started)) });
    },
    [tapUsd, track]
  );

  // v13.9: LIVE BUY on a paper card. Unarmed desk → plain message, no request, no paper trade.
  const liveTapBuy = useCallback(
    async (mint: string, symbol: string) => {
      const current = snapNow.current;
      const notArmed = liveTapBlock(current);
      if (notArmed) {
        setNotice({ ok: false, toast: true, text: `${symbol}: ${notArmed}` });
        return;
      }
      const key = `livebuy:${mint}`;
      if (inflight.current.has(key)) return;
      track(key, true);
      const started = performance.now();
      const sizeUsd = liveTapUsd(current);
      const res = await api<BuyReply>("/api/positions/buy", { body: { mint, sizeUsd, book: "live", idemKey: newIdemKey(), oneTap: true } });
      track(key, false);
      const body = { ...res.body, ok: res.ok };
      const held = liveGateFollowUp(body.code, body.error);
      if (held) {
        setBuyAsk({
          mint,
          symbol,
          sizeUsd,
          minutesLeft: held.cooldown ? 1 : null,
          hardKill: held.cooldown ? undefined : held.reason,
          book: "live"
        });
      }
      setNotice({ ok: res.ok, toast: true, text: buyToast(symbol, body, Math.round(performance.now() - started)) });
    },
    [track]
  );

  const oneTapSell = useCallback(
    async (mint: string, symbol: string, book?: "live") => {
      const key = `sell:${book ?? "paper"}:${mint}`;
      if (inflight.current.has(key)) return;
      track(key, true);
      const started = performance.now();
      const res = await api<SellReply>("/api/positions/sell", { body: { mint, percent: 100, idemKey: newIdemKey(), ...(book ? { book } : {}) } });
      track(key, false);
      setNotice({ ok: res.ok, toast: true, text: sellToast(symbol, { ...res.body, ok: res.ok }, Math.round(performance.now() - started)) });
    },
    [track]
  );

  const sellAll = useCallback(async () => {
    const key = "sell-all";
    if (inflight.current.has(key)) return;
    track(key, true);
    const started = performance.now();
    const res = await api<{ sold?: Array<{ symbol: string }>; failed?: Array<{ symbol: string; error: string }>; pnlUsd?: number }>("/api/positions/sell-all", {
      body: { confirm: true, idemKey: newIdemKey() }
    });
    track(key, false);
    const ms = Math.round(performance.now() - started);
    const sold = res.body.sold?.length ?? 0;
    const failed = res.body.failed ?? [];
    setNotice({
      ok: res.ok && failed.length === 0,
      toast: true,
      text: res.ok
        ? `Sold all: ${sold} closed${failed.length ? `, ${failed.length} failed (${failed.map((f) => f.symbol).join(", ")})` : ""} · ${signedUsd(res.body.pnlUsd ?? 0)} · ${ms} ms`
        : res.body.error ?? "Sell all failed."
    });
  }, [track]);

  const saveSlippage = useCallback(async (entryPct: number, exitPct?: number | null) => {
    const body: Record<string, unknown> = { maxEntrySlippage: Math.round(entryPct * 100) / 100 };
    if (exitPct !== undefined) body.maxExitSlippage = exitPct == null ? null : Math.round(exitPct * 100) / 100;
    const res = await api("/api/settings", { body });
    setNotice(res.ok ? { ok: true, text: `Max slippage ${entryPct}% saved. Buys past it are refused.` } : { ok: false, text: res.body.error ?? "Slippage save failed." });
    return res.ok;
  }, []);

  const actions: DeskActions = {
    notify: setNotice,
    oneTapBuy,
    liveTapBuy,
    live: snap?.mode === "live",
    split: snap?.liveBook != null,
    oneTapSell,
    sellAll,
    tapUsd,
    setTapUsd,
    saveSlippage,
    tapping,
    buy,
    askBuy,
    sell,
    openAddCoin: (q) => {
      setAddQuery((prev) => ({ q, n: prev.n + 1 }));
      setTab("add");
    },
    theme,
    setTheme
  };

  if (!snap) {
    return (
      <div className="loading">
        {denied ? "This desk is locked. Open it with ?token= and the DESK_TOKEN value." : offline ? "Night Desk is not answering on this port." : "Opening the book…"}
      </div>
    );
  }

  const openPnl = snap.positions.reduce((sum, pos) => sum + pos.pnlUsd, 0);
  modeRef.current = snap.mode;
  splitRef.current = snap.liveBook != null;
  const split = snap.liveBook != null;

  return (
    <div className={`shell${snap.mode === "live" ? " live-desk" : ""}`}>
      {snap.mode === "live" ? (
        <div className="live-strip" role="status">
          {split && snap.liveScope !== "all"
            ? `Live: manual only · AI: paper · your buys are real swaps, ${usd(snap.prefs.liveTradeUsd ?? 5)} each`
            : `LIVE · real swaps from the desk wallet · ${usd(snap.prefs.liveTradeUsd ?? 5)} per trade`}
        </div>
      ) : null}
      <header className={`top${tab === "tape" ? " on-tape" : ""}`}>
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <Icon name="moon" size={20} />
          </span>
          <div>
          <h1>
            Night <span>Desk</span>
          </h1>
          <p className={offline ? "warn" : "ok"}>
            {offline ? "Socket dropped · polling · " : ""}
            {pumpHeader(snap)}
            {snap.feed.dexLastPollAt ? " · DexScreener" : ""}
            {snap.feed.geckoLastPollAt ? " · Gecko" : ""}
            {snap.feed.jupiterLastPollAt ? " · Jupiter" : ""}
            {snap.feed.bitqueryLastPollAt ? " · Bitquery" : ""}
            {snap.feed.demo ? " · Replay tape on" : " · Replay off"}
            {snap.feed.mode === "replay" ? " · feed locked to replay" : ""}
          </p>
          </div>
        </div>
        <div className="top-right">
          <button
            className="theme-btn"
            type="button"
            aria-label={`Theme: ${THEME_OPTIONS.find((o) => o.id === theme)?.label}. Tap for ${THEME_OPTIONS.find((o) => o.id === nextTheme(theme))?.label}`}
            title="Theme"
            onClick={() => setTheme(nextTheme(theme))}
          >
            <Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "auto"} size={20} />
          </button>
        <div className={`lamp ${snap.mode}`} aria-label={`Trading mode ${snap.mode}`}>
          <i />
          {split ? (snap.liveScope === "all" ? "LIVE · AI + YOU" : "LIVE YOU · AI PAPER") : snap.mode === "live" ? "LIVE · REAL $" : "PAPER"}
        </div>
        </div>
        <div className={`metrics${tab === "home" ? " on-home" : ""}${tab === "tape" ? " on-tape" : ""}`}>
          <Metric label={snap.mode === "live" && !split ? "Live cash" : "Paper cash"} value={usd(snap.cashUsd)} hint={`book ${usd(snap.startingBalanceUsd)}`} />
          <Metric label="Marked equity" value={usd(snap.equityUsd)} hint="cash + marks" />
          <Metric label="Session P&L" value={signedUsd(snap.sessionPnlUsd)} hint={signedPct(snap.sessionPnlPct)} tone={tone(snap.sessionPnlUsd)} />
          <Metric label="Open" value={String(snap.positions.length)} hint={`${signedUsd(openPnl)} open`} tone={tone(openPnl)} />
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={`#${t.id}`}
            className={tab === t.id ? "on" : ""}
            onClick={(event) => {
              event.preventDefault();
              setTab(t.id);
            }}
          >
            <span className="tab-icon">
              <Icon name={t.icon} />
            </span>
            <span className="tab-label">{t.label}</span>
            {t.id === "home" && snap.positions.length ? <b>{snap.positions.length}</b> : null}
            {t.id === "add" && snap.watchlist?.length ? <b>{snap.watchlist.length}</b> : null}
          </a>
        ))}
      </nav>

      {notice ? (
        <div className={`${notice.ok ? "notice ok" : "notice"}${notice.toast ? " toast" : ""}`} role="status">
          <span>{notice.text}</span>
          <button className="ghost" type="button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {snap.armError ? <div className="banner">{snap.armError}</div> : null}
      {snap.feed.lastError ? <div className="banner">Feed: {snap.feed.lastError}</div> : null}

      <main className="screen">
        {tab === "home" ? <HomeScreen snap={snap} actions={actions} busy={busy} /> : null}
        {tab === "tape" ? <TapeScreen snap={snap} history={history} setHistory={setHistory} actions={actions} busy={busy} /> : null}
        {tab === "add" ? <AddCoinScreen snap={snap} actions={actions} query={addQuery} busy={busy} /> : null}
        {tab === "recap" ? <RecapScreen /> : null}
        {tab === "settings" ? <SettingsScreen snap={snap} actions={actions} /> : null}
        {tab === "pump" ? <PumpScreen /> : null}
      </main>

      {buyAsk ? <BuyModal ask={buyAsk} snap={snap} onCancel={() => setBuyAsk(null)} onConfirm={(ask) => {
        setBuyAsk(null);
        void buy(ask);
      }} /> : null}
    </div>
  );
}

function BuyModal({ ask, snap, onCancel, onConfirm }: { ask: BuyAsk; snap: DeskSnapshot; onCancel: () => void; onConfirm: (ask: BuyAsk) => void }) {
  const anyway = ask.minutesLeft != null || ask.hardKill != null;
  return (
    <div className="modal-back" role="presentation" onClick={onCancel}>
      <div className="modal" role="dialog" aria-labelledby="buy-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="buy-title">{anyway ? `Buy ${ask.symbol} anyway?` : `Buy ${ask.symbol}?`}</h2>
        {ask.book === "live" ? (
          <p>
            Live buy {usd(ask.sizeUsd ?? liveTapUsd(snap))}. Real money from the desk wallet. The engine, the analyst, a filter miss, the score, and a watch do not block it.
            Slippage, pool depth, the wallet check, the live size, and the daily cap still do.
          </p>
        ) : (
          <p>
            {ask.sizeUsd == null
              ? snap.positionCapUsd > 0
                ? `Size uses the position cap (${usd(snap.positionCapUsd)}).`
                : "Size uses the position cap."
              : `Size ${usd(ask.sizeUsd)}.${ask.confirmSize ? " Confirmed above the per-position cap (up to 100% of the book, still cut to cash)." : " A larger number is filled at the cap."}`}{" "}
            Paper fill only. A real swap is the LIVE button, and only after the checklist is marked.
          </p>
        )}
        {ask.minutesLeft != null ? (
          <p className="ban">Mint is banned after a hard stop. Cooldown has about {ask.minutesLeft} minute(s) left. Auto buys stay blocked.</p>
        ) : null}
        {ask.hardKill ? <p className="ban">{ask.hardKill}</p> : null}
        <p className="fine">Slippage cap, pool-depth exit check, cash and the −{(snap.rules.stopLossPct * 100).toFixed(0)}% hard stop still apply.</p>
        <div className="modal-actions">
          <button className="ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => onConfirm({ ...ask, confirmHardKill: ask.hardKill != null ? true : ask.confirmHardKill })}
          >
            {anyway ? "Buy anyway" : "Buy"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Metric({ label, value, hint, tone: t = "flat" }: { label: string; value: string; hint: string; tone?: "up" | "down" | "flat" }) {
  return (
    <div className="metric">
      <label>{label}</label>
      <strong className={t}>{value}</strong>
      <em>{hint}</em>
    </div>
  );
}

/** v13.3: the watchdog's stale state wins over the socket flag, so a silent stream never reads "live". */
export function pumpHeader(snap: DeskSnapshot): string {
  const src = snap.feed.sources?.find((s) => s.id === "pump");
  if (src?.state === "stale") return "Pump stream stale · reconnecting";
  if (src?.state === "down") return "Pump stream down";
  return snap.feed.pumpConnected ? "Pump stream live" : "Pump stream quiet";
}

export function tone(n: number): "up" | "down" | "flat" {
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}

export function mergeEvents(current: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  const map = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) map.set(event.id, event);
  return [...map.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}
