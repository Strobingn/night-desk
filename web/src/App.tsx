import { useEffect, useMemo, useState } from "react";
import type { AdviceNote, DeskSnapshot, FeedEvent } from "./types";

const LOG_STAGES = ["all", "scout", "filter", "analyst", "executor", "risk", "system", "logger"] as const;

const STAGES = [
  ["01", "Scout", "scouted", "New pairs"],
  ["02", "Filter", "filteredKill", "Hard kills"],
  ["03", "Analyst", "analystTrade", "Scores ≥ line"],
  ["04", "Executor", "fills", "Paper fills"],
  ["05", "Risk", "riskExits", "Hard stops"],
  ["06", "Logger", "scouted", "Append-only"]
] as const;

const deskToken = rememberDeskToken();

/** Look-only feeds. These open the mint in a browser. They do not send a desk order. */
function chartLinks(mint: string): { label: string; href: string }[] {
  return [
    { label: "Chart", href: `https://dexscreener.com/solana/${mint}` },
    { label: "Birdeye", href: `https://birdeye.so/token/${mint}?chain=solana` },
    { label: "Jupiter", href: `https://jup.ag/tokens/${mint}` }
  ];
}

export function App() {
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [denied, setDenied] = useState(false);
  const [recap, setRecap] = useState<string | null>(null);
  const [recapError, setRecapError] = useState<string | null>(null);
  const [history, setHistory] = useState<FeedEvent[]>([]);
  const [stageFilter, setStageFilter] = useState<(typeof LOG_STAGES)[number]>("all");
  const [logError, setLogError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [volumeText, setVolumeText] = useState("");
  const [volumeDirty, setVolumeDirty] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let stopped = false;
    const pull = async () => {
      try {
        const res = await fetch(withToken("/api/events?limit=800"), { headers: authHeaders() });
        if (!res.ok) throw new Error(`Log failed (${res.status})`);
        const body = (await res.json()) as { events?: FeedEvent[] };
        if (!stopped) {
          setHistory((prev) => mergeEvents(prev, body.events ?? []));
          setLogError(null);
        }
      } catch (err) {
        if (!stopped) setLogError(err instanceof Error ? err.message : "Log failed");
      }
    };
    void pull();
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!volumeDirty && snap) setVolumeText(String(Math.round(snap.rules.minVolume1hUsd)));
  }, [snap, volumeDirty]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    const apply = (data: DeskSnapshot) => {
      if (!stopped) {
        setSnap(data);
        setHistory((prev) => mergeEvents(prev, data.events));
        setOffline(false);
        setDenied(false);
      }
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
    const wsUrl = `${proto}://${location.host}${withToken("/ws")}`;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as { type: string; data: DeskSnapshot };
        if (msg.type === "snapshot") apply(msg.data);
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

  async function loadRecap() {
    setRecapError(null);
    try {
      const res = await fetch(withToken("/api/recap?since=12h"), { headers: authHeaders() });
      if (res.status === 401) throw new Error("Desk token missing or wrong.");
      if (!res.ok) throw new Error(`Recap failed (${res.status})`);
      const body = (await res.json()) as { text?: string };
      setRecap(body.text ?? "No recap text.");
    } catch (err) {
      setRecapError(err instanceof Error ? err.message : "Recap failed");
    }
  }

  async function saveVolume() {
    const raw = Number(volumeText);
    setLogError(null);
    try {
      const res = await fetch(withToken("/api/settings"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ minVolume1hUsd: raw })
      });
      if (res.status === 401) throw new Error("Desk token missing or wrong.");
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; minVolume1hUsd?: number };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `Volume update failed (${res.status})`);
      setVolumeDirty(false);
      if (body.minVolume1hUsd != null) setVolumeText(String(body.minVolume1hUsd));
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Volume update failed");
    }
  }

  async function resetBook() {
    if (snap?.mode !== "paper") return;
    const ok = window.confirm(
      "Reset the paper book to $100? Open positions are dropped and session PnL starts over. No order is sent. The log, advisor memory, and 1h volume floor stay. Live trading stays off."
    );
    if (!ok) return;
    setResetting(true);
    setLogError(null);
    try {
      const res = await fetch(withToken("/api/paper/reset"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      if (res.status === 401) throw new Error("Desk token missing or wrong.");
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `Reset failed (${res.status})`);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  }

  async function closeMint(mint: string, symbol: string) {
    if (!window.confirm(`Close ${symbol} at the mark? Winners leave only from this button. The hard stop still fires on its own.`)) return;
    setClosing(mint);
    try {
      const res = await fetch(withToken("/api/positions/close"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mint })
      });
      if (res.status === 401) throw new Error("Desk token missing or wrong.");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Close failed (${res.status})`);
      }
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Close failed");
    } finally {
      setClosing(null);
    }
  }

  async function loadEarlier() {
    const oldest = history[0]?.ts;
    if (!oldest) return;
    try {
      const res = await fetch(withToken(`/api/events?limit=800&before=${oldest}`), { headers: authHeaders() });
      if (!res.ok) throw new Error(`Log failed (${res.status})`);
      const body = (await res.json()) as { events?: FeedEvent[] };
      setHistory((prev) => mergeEvents(body.events ?? [], prev));
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Log failed");
    }
  }

  if (!snap) {
    return (
      <div className="loading">
        {denied
          ? "This desk is locked. Open it with ?token= and the DESK_TOKEN value."
          : offline
            ? "Night Desk is not answering on this port."
            : "Opening the book…"}
      </div>
    );
  }

  const events = history.filter((event) => stageFilter === "all" || event.stage === stageFilter);
  const maxKill = Math.max(1, ...Object.values(snap.killReasons));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>
            NIGHT <span>DESK</span>
          </h1>
          <p>Solana memecoins · preservation before size · six hard handoffs</p>
        </div>
        <div className="metrics">
          <Metric
            label={snap.mode === "live" ? "Live cash" : "Paper cash"}
            value={usd(snap.cashUsd)}
            hint={`book ${usd(snap.startingBalanceUsd)}`}
          />
          <Metric label="Marked equity" value={usd(snap.equityUsd)} hint="cash + marks" />
          <Metric
            label="Session P&L"
            value={signedUsd(snap.sessionPnlUsd)}
            hint={signedPct(snap.sessionPnlPct)}
            tone={snap.sessionPnlUsd > 0 ? "up" : snap.sessionPnlUsd < 0 ? "down" : "flat"}
          />
          <Metric label="Open" value={String(snap.positions.length)} hint={`${snap.pipeline.filteredKill} filter kills`} />
        </div>
        <div className="mode">
          <div className={`lamp ${snap.mode}`} aria-label={`Trading mode ${snap.mode}`}>
            <i />
            {snap.mode === "live" ? "LIVE" : "PAPER"}
          </div>
          <div className="feed-note">
            {snap.feed.demo ? "Replay tape on" : "Replay off"}
            {" · "}
            {snap.feed.pumpConnected ? "Pump stream live" : "Pump stream quiet"}
            {snap.feed.mode === "replay" ? " · feed locked to replay" : ""}
          </div>
        </div>
      </header>

      <aside className="rail">
        <p className="section-label">Pipeline</p>
        <div className="stages">
          {STAGES.map(([idx, name, key, hint]) => (
            <article className="stage" key={name}>
              <span className="idx">{idx}</span>
              <div>
                <b>{name}</b>
                <small>{hint}</small>
              </div>
              <span className="count">
                {name === "Logger" ? snap.events.length : snap.pipeline[key]}
              </span>
            </article>
          ))}
        </div>
        <div className="rules">
          <p>
            <strong>Hard lines.</strong> Mint revoked. LP locked once a pool exists; Pump curve mints skip that check. Top 10 ≤ {(snap.rules.maxTop10Pct * 100).toFixed(0)}% after curve and LP vaults are removed.
            Volume ≥ {usd(snap.rules.minVolume1hUsd, 0)} / hour. No known rug deployer. Analyst ≥ {snap.rules.analystMinScore.toFixed(2)}.
            Position ≤ {(snap.rules.maxPositionPct * 100).toFixed(0)}%. Hard stop −{(snap.rules.stopLossPct * 100).toFixed(0)}% from the fill.
            Winners are not auto-sold. Close them from the book. Peak is a hint.
            No adds. {Math.round(snap.rules.revengeCooldownMs / 3_600_000)}h ban after a hard stop.
          </p>
          <form
            className="volume-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveVolume();
            }}
          >
            <label>
              1h volume floor
              <input
                aria-label="1h volume floor in dollars"
                inputMode="decimal"
                min={1000}
                max={500000}
                step={1000}
                value={volumeText}
                onChange={(event) => {
                  setVolumeDirty(true);
                  setVolumeText(event.target.value);
                }}
              />
            </label>
            <button className="ghost" type="submit">
              Apply
            </button>
          </form>
        </div>
      </aside>

      <main className="tape">
        <section className="advice" aria-label="Advisor">
          <header>
            <h2>Advisor</h2>
            <span>Learns from the book · never places a trade</span>
          </header>
          {(snap.advice ?? []).length === 0 ? (
            <p className="empty">Watching kills, fills, and open marks. Hard stop still fires on its own. Take profit with Close.</p>
          ) : (
            (snap.advice ?? []).map((note) => <AdviceRow key={note.id} note={note} />)
          )}
        </section>
        <div className="tape-head">
          <h2>Activity log</h2>
          <button className="ghost" type="button" onClick={() => void loadRecap()}>
            {recap ? "Refresh 12h recap" : "Morning recap"}
          </button>
        </div>
        <div className="filters" role="tablist" aria-label="Log stage">
          {LOG_STAGES.map((stage) => (
            <button
              key={stage}
              type="button"
              className={stageFilter === stage ? "on" : ""}
              onClick={() => setStageFilter(stage)}
            >
              {stage}
            </button>
          ))}
        </div>
        {snap.armError ? <div className="banner">{snap.armError}</div> : null}
        {offline ? <div className="banner">Live socket dropped. Polling the book until it returns.</div> : null}
        {snap.feed.lastError ? <div className="banner">Feed: {snap.feed.lastError}</div> : null}
        {recapError ? <div className="banner">{recapError}</div> : null}
        {logError ? <div className="banner">{logError}</div> : null}
        {recap ? <pre className="recap">{recap}</pre> : null}
        <div className="rows" aria-live="polite">
          <button className="ghost earlier" type="button" onClick={() => void loadEarlier()}>
            Load earlier
          </button>
          {events.length === 0 ? (
            <p className="empty">No lines for this filter. The desk log on disk keeps every stage across restarts.</p>
          ) : (
            events.map((event) => <Row key={event.id} event={event} />)
          )}
        </div>
      </main>

      <aside className="side">
        <section className="chart-card">
          <header>
            <h3>Equity</h3>
            <span className={snap.sessionPnlUsd >= 0 ? "up" : "down"}>{signedUsd(snap.sessionPnlUsd)}</span>
            {snap.mode === "paper" ? (
              <button className="ghost reset" type="button" disabled={resetting} onClick={() => void resetBook()}>
                {resetting ? "Resetting" : "Reset book"}
              </button>
            ) : null}
          </header>
          <EquityChart points={snap.equity} baseline={snap.startingBalanceUsd} />
        </section>

        <section className="card">
          <header>
            <h3>Open positions</h3>
            <span>{snap.positions.length ? `${snap.positions.length} live` : "flat"}</span>
          </header>
          {snap.positions.length === 0 ? (
            <p className="empty">Flat. A name has to clear every hard filter and score at least {snap.rules.analystMinScore.toFixed(2)}.</p>
          ) : (
            <table className="positions">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>PnL</th>
                  <th>Stop</th>
                </tr>
              </thead>
              <tbody>
                {snap.positions.map((pos) => (
                  <tr key={pos.mint}>
                    <td>
                      <span className="sym">{pos.symbol}</span>
                      <Sparkline mint={pos.mint} symbol={pos.symbol} marks={pos.marks} entryPrice={pos.entryPrice} />
                      <span className="sub">
                        {pos.source} · score {pos.score.toFixed(2)} · peak {px(pos.peakPrice)}
                        {pos.trailHintPrice != null ? ` · hint ${px(pos.trailHintPrice)}` : ""}
                      </span>
                      <span className="pos-actions">
                        {chartLinks(pos.mint).map((link) => (
                          <a
                            key={link.label}
                            className="ghost"
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {link.label}
                          </a>
                        ))}
                      </span>
                    </td>
                    <td>
                      <span className={pos.pnlUsd >= 0 ? "up" : "down"}>{signedUsd(pos.pnlUsd)}</span>
                      <span className="sub">mark {signedPct(pos.pnlPct)}</span>
                      <NetLine pos={pos} />
                    </td>
                    <td>
                      {px(pos.stopPrice)}
                      <span className="sub">hard stop · entry {px(pos.entryPrice)}</span>
                      <button
                        className="ghost close"
                        type="button"
                        disabled={closing === pos.mint}
                        onClick={() => void closeMint(pos.mint, pos.symbol)}
                      >
                        {closing === pos.mint ? "Closing" : "Close"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <header>
            <h3>Last exits</h3>
            <span>{snap.closed.length}</span>
          </header>
          {snap.closed.length === 0 ? (
            <p className="empty">No realized trades yet. Hard stops and manual closes land here.</p>
          ) : (
            <table>
              <tbody>
                {[...snap.closed].reverse().map((trade) => (
                  <tr key={trade.id}>
                    <td>
                      <span className="sym">{trade.symbol}</span>
                      <span className="sub">{trade.exitCode}</span>
                    </td>
                    <td className={trade.pnlUsd >= 0 ? "up" : "down"}>
                      {signedUsd(trade.pnlUsd)}
                      <span className="sub">{signedPct(trade.pnlPct)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <KillList reasons={snap.killReasons} max={maxKill} />
      </aside>
    </div>
  );
}

function Metric({ label, value, hint, tone = "flat" }: { label: string; value: string; hint: string; tone?: "up" | "down" | "flat" }) {
  return (
    <div className="metric">
      <label>{label}</label>
      <strong className={tone}>{value}</strong>
      <em>{hint}</em>
    </div>
  );
}

function AdviceRow({ note }: { note: AdviceNote }) {
  return (
    <article className="advice-row">
      <span className={`stance ${note.stance}`}>{note.stance}</span>
      <p>{note.text}</p>
    </article>
  );
}

function Row({ event }: { event: FeedEvent }) {
  return (
    <article className={`row ${event.kind}`}>
      <time className="when">{clock(event.ts)}</time>
      <span className={`tag ${event.stage}`}>{event.stage}</span>
      <p className="msg">
        {event.code ? <code>{event.code}</code> : null} {event.code ? "· " : null}
        {event.message}
        {event.detail ? <span className="detail"> · {event.detail}</span> : null}
      </p>
    </article>
  );
}

function NetLine({ pos }: { pos: { netPnlUsd: number | null; netPnlPct: number | null; exitSlippage: number | null; entrySlippage: number | null; markStale: boolean } }) {
  if (pos.netPnlUsd == null || pos.netPnlPct == null) {
    return <span className="sub net-hold">{pos.markStale ? "net — stale mark" : "net —"}</span>;
  }
  const bits = [
    pos.exitSlippage != null ? `exit slip ${(pos.exitSlippage * 100).toFixed(2)}%` : "",
    pos.entrySlippage != null ? `buy ${(pos.entrySlippage * 100).toFixed(2)}% in cost` : ""
  ].filter(Boolean);
  return (
    <>
      <span className={`net-line ${pos.netPnlUsd >= 0 ? "up" : "down"}`}>
        net {signedUsd(pos.netPnlUsd)} {signedPct(pos.netPnlPct)}
      </span>
      {bits.length ? <span className="sub">{bits.join(" · ")}</span> : null}
    </>
  );
}

function Sparkline({
  mint,
  symbol,
  marks,
  entryPrice
}: {
  mint: string;
  symbol: string;
  marks: { t: number; priceUsd: number }[];
  entryPrice: number;
}) {
  const path = useMemo(() => {
    const series = marks.filter((point) => point.priceUsd > 0);
    if (series.length === 0) return null;
    const values = series.map((point) => point.priceUsd);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.max(Math.abs(max) * 0.02, 1e-12);
    const w = 140;
    const h = 36;
    const coords = series.map((point, index) => {
      const x = series.length === 1 ? w / 2 : (index / (series.length - 1)) * w;
      const y = h - ((point.priceUsd - min) / span) * (h - 8) - 4;
      return [x, y] as const;
    });
    const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
    const lastPx = series[series.length - 1]?.priceUsd ?? entryPrice;
    const up = lastPx >= (series[0]?.priceUsd ?? entryPrice);
    const last = coords[coords.length - 1] ?? [w / 2, h / 2];
    return { line, up, last };
  }, [marks, entryPrice]);

  if (!path) return null;
  const stroke = path.up ? "#dff25a" : "#ff6a45";
  const gid = `spark-${mint.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg className="spark" viewBox="0 0 140 36" role="img" aria-label={`${symbol} price`}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.45" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path.line} L140,36 L0,36 Z`} fill={`url(#${gid})`} />
      <path d={path.line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={path.last[0]} cy={path.last[1]} r="2.4" fill="#e7f0d8" />
    </svg>
  );
}

function EquityChart({ points, baseline }: { points: { t: number; equity: number }[]; baseline: number }) {
  const path = useMemo(() => {
    const series = points.length ? points : [{ t: 0, equity: baseline }];
    const values = series.map((p) => p.equity);
    const min = Math.min(baseline, ...values);
    const max = Math.max(baseline, ...values);
    const span = max - min || 1;
    const w = 320;
    const h = 112;
    const coords = series.map((point, index) => {
      const x = series.length === 1 ? w / 2 : (index / (series.length - 1)) * w;
      const y = h - ((point.equity - min) / span) * (h - 16) - 8;
      return [x, y] as const;
    });
    const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
    const area = `${line} L${w},${h} L0,${h} Z`;
    const last = coords[coords.length - 1] ?? [0, h / 2];
    return { line, area, last, up: (series[series.length - 1]?.equity ?? baseline) >= baseline };
  }, [points, baseline]);

  return (
    <svg viewBox="0 0 320 112" role="img" aria-label="Equity curve">
      <defs>
        <linearGradient id="eq" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={path.up ? "#8dface" : "#ff6a45"} stopOpacity="0.35" />
          <stop offset="100%" stopColor={path.up ? "#8dface" : "#ff6a45"} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={path.area} fill="url(#eq)" />
      <path d={path.line} fill="none" stroke={path.up ? "#dff25a" : "#ff6a45"} strokeWidth="2" />
      <circle cx={path.last[0]} cy={path.last[1]} r="3.5" fill="#e7f0d8" />
    </svg>
  );
}

function KillList({ reasons, max }: { reasons: Record<string, number>; max: number }) {
  const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  return (
    <section className="card">
      <header>
        <h3>Filter kills</h3>
        <span>{entries.reduce((sum, [, n]) => sum + n, 0)}</span>
      </header>
      {entries.length === 0 ? (
        <p className="empty">No kills yet.</p>
      ) : (
        <div className="kills">
          {entries.map(([code, count]) => (
            <div key={code}>
              <div className="kill">
                <span>{code}</span>
                <span>{count}</span>
              </div>
              <div className="bar">
                <span style={{ width: `${(count / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function usd(n: number, digits = 2): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function signedUsd(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${usd(Math.abs(n))}`;
}

function signedPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n * 100).toFixed(2)}%`;
}

function px(n: number): string {
  if (!(n > 0)) return "—";
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

function mergeEvents(current: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  const map = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) map.set(event.id, event);
  return [...map.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function rememberDeskToken(): string {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("token");
  if (fromUrl) {
    sessionStorage.setItem("night-desk-token", fromUrl);
    params.delete("token");
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
    return fromUrl;
  }
  return sessionStorage.getItem("night-desk-token") ?? "";
}

function withToken(path: string): string {
  const url = new URL(path, location.origin);
  if (deskToken && !url.searchParams.has("token")) url.searchParams.set("token", deskToken);
  return `${url.pathname}${url.search}`;
}

function authHeaders(): HeadersInit {
  return deskToken ? { "X-Desk-Token": deskToken } : {};
}
