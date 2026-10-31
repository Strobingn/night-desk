import { useCallback, useEffect, useState } from "react";
import { mergeMarks, stampSnapshot } from "./marks";
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
import { applyTheme, nextTheme, readThemePref, saveThemePref, THEME_OPTIONS, type ThemePref } from "./theme";

export const TABS = [
  { id: "home", label: "Home", icon: "home" },
  { id: "tape", label: "Tape", icon: "tape" },
  { id: "add", label: "Add coin", icon: "add" },
  { id: "recap", label: "Recap", icon: "recap" },
  { id: "settings", label: "Settings", icon: "settings" }
] as const;
export type TabId = (typeof TABS)[number]["id"];

export interface Notice {
  ok: boolean;
  text: string;
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
}

export interface DeskActions {
  notify: (notice: Notice) => void;
  /** Sends a paper buy. Returns true on a fill. Shows "Buy anyway" for a cooldown or a hard kill. */
  buy: (ask: BuyAsk) => Promise<boolean>;
  askBuy: (ask: BuyAsk) => void;
  sell: (mint: string, symbol: string, percent: 25 | 50 | 100) => Promise<void>;
  openAddCoin: (q: string) => void;
  theme: ThemePref;
  setTheme: (pref: ThemePref) => void;
}

function tabFromHash(): TabId {
  const raw = location.hash.replace(/^#/, "");
  return (TABS.find((t) => t.id === raw)?.id ?? "home") as TabId;
}

export function App() {
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [denied, setDenied] = useState(false);
  const [history, setHistory] = useState<FeedEvent[]>([]);
  const [tab, setTabState] = useState<TabId>(() => (new URLSearchParams(location.search).get("add") ? "add" : tabFromHash()));
  const [notice, setNotice] = useState<Notice | null>(null);
  const [buyAsk, setBuyAsk] = useState<BuyAsk | null>(null);
  const [addQuery, setAddQuery] = useState<{ q: string; n: number }>(() => ({ q: new URLSearchParams(location.search).get("add") ?? "", n: 0 }));
  const [busy, setBusy] = useState<string | null>(null);
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
    const apply = (data: DeskSnapshot) => {
      if (stopped) return;
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
      const payload: Record<string, unknown> = { mint: ask.mint };
      if (ask.sizeUsd != null) payload.sizeUsd = ask.sizeUsd;
      if (ask.minutesLeft != null) payload.ignoreCooldown = true;
      if (ask.confirmHardKill) payload.confirmHardKill = true;
      if (ask.confirmSize) payload.confirmSize = true;
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

  const sell = useCallback(async (mint: string, symbol: string, percent: 25 | 50 | 100) => {
    const verb = percent === 100 ? `Close ${symbol} at the mark?` : `Sell ${percent}% of ${symbol} at the mark?`;
    if (!window.confirm(`${verb} Paper fill against the same pool model as a stop. The hard stop still fires on its own.`)) return;
    setBusy(`${mint}:${percent}`);
    const res = await api<{ proceedsUsd?: number }>("/api/positions/sell", { body: { mint, percent } });
    setBusy(null);
    setNotice(
      res.ok
        ? { ok: true, text: percent === 100 ? `Closed ${symbol}.` : `Sold ${percent}% of ${symbol}${res.body.proceedsUsd != null ? ` for ${usd(res.body.proceedsUsd)}` : ""}.` }
        : { ok: false, text: res.body.error ?? "Sell failed." }
    );
  }, []);

  const actions: DeskActions = {
    notify: setNotice,
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

  return (
    <div className="shell">
      <header className="top">
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
            {snap.feed.pumpConnected ? "Pump stream live" : "Pump stream quiet"}
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
          {snap.mode === "live" ? "LIVE" : "PAPER"}
        </div>
        </div>
        <div className={`metrics${tab === "home" ? " on-home" : ""}`}>
          <Metric label={snap.mode === "live" ? "Live cash" : "Paper cash"} value={usd(snap.cashUsd)} hint={`book ${usd(snap.startingBalanceUsd)}`} />
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
        <div className={notice.ok ? "notice ok" : "notice"} role="status">
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
        <p>
          {ask.sizeUsd == null
            ? snap.positionCapUsd > 0
              ? `Size uses the position cap (${usd(snap.positionCapUsd)}).`
              : "Size uses the position cap."
            : `Size ${usd(ask.sizeUsd)}.${ask.confirmSize ? " Confirmed above the per-position cap (up to 100% of the book, still cut to cash)." : " A larger number is filled at the cap."}`}{" "}
          {snap.mode === "live" ? "The desk is already live, so this sends a real swap." : "Paper fill only. This does not turn on live trading."}
        </p>
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

export function tone(n: number): "up" | "down" | "flat" {
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}

export function mergeEvents(current: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  const map = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) map.set(event.id, event);
  return [...map.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}
