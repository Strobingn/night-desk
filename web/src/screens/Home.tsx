import { useEffect, useMemo, useState } from "react";
import { OpenOrdersCard, OrderChips, OrderTicket } from "./Orders";
import { liveAgeMs, markFreshness, sourceAgeLabel, updatedLabel } from "../marks";
import { api } from "../api";
import { chartLinks, clock, liveCashLabel, px, signedPct, signedUsd, usd } from "../format";
import type { AdviceNote, DeskSnapshot, LiveReadiness, PositionView } from "../types";
import { tone, type DeskActions } from "../App";
import { CoinAvatar, CoinSpark, PnlChip, Sparkline, StopTrailBar } from "../ui";
import { dayBase } from "../coins";
import { crashOnHome } from "../../../src/desk/crash-card";
import { exitLabel } from "../../../src/desk/gap";
import { LiveTapPair, OneTapBar, TapSellButton } from "./OneTap";
import { WalletCard } from "./Wallet";



const STAGES = [
  ["01", "Scout", "scouted", "New pairs"],
  ["02", "Filter", "filteredKill", "Hard kills"],
  ["03", "Analyst", "analystTrade", "Scores ≥ line"],
  ["04", "Executor", "fills", "Paper fills"],
  ["05", "Risk", "riskExits", "Hard stops"],
  ["06", "Logger", "scouted", "Append-only"]
] as const;

export function HomeScreen({ snap, actions, busy }: { snap: DeskSnapshot; actions: DeskActions; busy: string | null }) {
  const openPnl = snap.positions.reduce((sum, pos) => sum + pos.pnlUsd, 0);
  const [readyBusy, setReadyBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const maxKill = Math.max(1, ...Object.values(snap.killReasons));

  async function markReady(operatorReady: boolean) {
    setReadyBusy(true);
    const res = await api("/api/live/ready", { body: { operatorReady } });
    setReadyBusy(false);
    if (!res.ok) actions.notify({ ok: false, text: res.body.error ?? "Checklist update failed" });
  }

  async function resetBook() {
    const amount = snap.prefs.paperResetUsd ?? 100;
    const ok = window.confirm(
      `Reset the paper book to ${usd(amount, 0)}? Open positions are dropped and session PnL starts over. No order is sent. The log, advisor memory, and 1h volume floor stay. ${snap.liveBook ? "The live book and its real positions are not touched." : "Live trading stays off."}`
    );
    if (!ok) return;
    setResetting(true);
    const res = await api("/api/paper/reset", { body: { confirm: true } });
    setResetting(false);
    actions.notify(res.ok ? { ok: true, text: `Paper book reset to ${usd(amount, 0)}.` } : { ok: false, text: res.body.error ?? "Reset failed" });
  }

  return (
    <div className="home">
      {crashOnHome(snap.lastClientCrash, snap.appVersion ?? "") ? <LastCrashCard crash={snap.lastClientCrash!} actions={actions} /> : null}

      <HeroCard snap={snap} openPnl={openPnl} />

      {snap.liveBook ? <LiveBookSection snap={snap} actions={actions} busy={busy} /> : null}

      <div className="section-head">
        <h2>{snap.liveBook ? "Paper positions · AI" : "Open positions"}</h2>
        <span className={tone(openPnl)}>
          {signedUsd(openPnl)} · {snap.positions.length} open · exposure {usd(snap.exposureUsd ?? 0)}
          {snap.prefs.maxExposurePct != null && snap.prefs.maxExposurePct < 1 ? ` of ${(snap.prefs.maxExposurePct * 100).toFixed(0)}% cap` : ""}
        </span>
      </div>

      <OneTapBar snap={snap} actions={actions} />

      {snap.positions.length === 0 ? (
        <p className="empty">Flat. A name has to clear every hard filter and score at least {snap.rules.analystMinScore.toFixed(2)}. Or add one yourself on Add coin.</p>
      ) : (
        <div className="positions">
          {snap.positions.map((pos, index) => (
            <PositionCard key={`${pos.mint}#${index}`} pos={pos} actions={actions} busy={busy} armPct={snap.rules.trailArmPct} trailOn={snap.prefs.trailTakeProfit === true} snap={snap} />
          ))}
        </div>
      )}

      <OpenOrdersCard snap={snap} actions={actions} />

      <section className="card chart-card">
        <header>
          <h3>Equity</h3>
          <span className={snap.sessionPnlUsd >= 0 ? "up" : "down"}>{signedUsd(snap.sessionPnlUsd)}</span>
          {snap.mode === "paper" || snap.liveBook ? (
            <button className="ghost reset" type="button" disabled={resetting} onClick={() => void resetBook()}>
              {resetting ? "Resetting" : "Reset book"}
            </button>
          ) : null}
        </header>
        <EquityChart points={snap.equity} baseline={snap.startingBalanceUsd} />
        {snap.mode === "paper" || snap.liveBook ? <p className="fine">Reset paper book refills to {usd(snap.prefs.paperResetUsd ?? 100, 0)} (Settings → Sizing / risk).</p> : null}
      </section>

      <WalletCard snap={snap} />

      <LiveReadyCard readiness={snap.readiness} busy={readyBusy} onReady={(ready) => void markReady(ready)} />

      <section className="card advice" aria-label="Advisor">
        <header>
          <h3>Advisor</h3>
          <span>Learns from the book · never places a trade</span>
        </header>
        {(snap.advice ?? []).length === 0 ? (
          <p className="empty">Watching kills, fills, and open marks. Hard stop still fires on its own. Take profit with Sell.</p>
        ) : (
          (snap.advice ?? []).map((note) => (
            <AdviceRow
              key={note.id}
              note={note}
              onBuy={(mint, symbol) => actions.askBuy({ mint, symbol, minutesLeft: null })}
              onLiveBuy={(mint, symbol) => void actions.liveTapBuy?.(mint, symbol)}
            />
          ))
        )}
      </section>

      <section className="card">
        <header>
          <h3>Recent trades</h3>
          <span>{snap.closed.length}</span>
        </header>
        {snap.closed.length === 0 ? (
          <p className="empty">No realized trades yet. Hard stops and manual closes land here.</p>
        ) : (
          <div className="trades">
            {[...snap.closed].reverse().slice(0, 20).map((trade) => (
              <div className="trade" key={trade.id}>
                <div>
                  <span className="sym">{trade.symbol}</span>
                  <span className="sub">
                    entry {px(trade.entryPrice ?? 0)} → exit {px(trade.exitPrice ?? 0)} · <span className={trade.exitCode === "GAP_RUG" ? "gap-label" : undefined}>{exitLabel(trade.exitCode)}</span> · {clock(trade.closedAt)}
                  </span>
                </div>
                <div className={trade.pnlUsd >= 0 ? "up num" : "down num"}>
                  {signedUsd(trade.pnlUsd)}
                  <span className="sub">{signedPct(trade.pnlPct)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <header>
          <h3>Pipeline</h3>
          <span>since start</span>
        </header>
        <div className="stages">
          {STAGES.map(([idx, name, key, hint]) => (
            <article className="stage" key={name}>
              <span className="idx">{idx}</span>
              <div>
                <b>{name}</b>
                <small>{hint}</small>
              </div>
              <span className="count">{name === "Logger" ? snap.events.length : snap.pipeline[key]}</span>
            </article>
          ))}
        </div>
        <p className="rules-text">
          <strong>Hard lines.</strong> Mint revoked. LP locked once a pool exists; Pump curve mints skip that check. Top 10 ≤ {(snap.rules.maxTop10Pct * 100).toFixed(0)}% after curve and LP vaults are removed.
          Volume ≥ {usd(snap.rules.minVolume1hUsd, 0)} / hour. No known rug deployer. Analyst ≥ {snap.rules.analystMinScore.toFixed(2)}.
          Position ≤ {(snap.rules.maxPositionPct * 100).toFixed(0)}%. Hard stop −{(snap.rules.stopLossPct * 100).toFixed(0)}% from the fill.
          Winners are not auto-sold unless the trail is on. Sell them from the book. Peak is a hint.
          No adds. {snap.rules.revengeCooldownMs > 0 ? `${Math.round(snap.rules.revengeCooldownMs / 3_600_000)}h ban after a hard stop.` : "No ban after a hard stop."}
        </p>
      </section>

      <KillList reasons={snap.killReasons} max={maxKill} />
    </div>
  );
}

/** v13.2 live "updated Xs ago". Ticks every second; amber past 10 s, red past 30 s. */
export function MarkUpdated({ pos }: { pos: PositionView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // v13.8: 4 Hz so a streamed on-chain mark reads "0.3s", not "just now".
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const age = liveAgeMs(pos, now);
  const fresh = markFreshness(age);
  return (
    <p className={`mark-updated is-${fresh}`} aria-label={`Mark ${updatedLabel(age)}`}>
      <i className="dot" />
      {sourceAgeLabel(pos.markFeed, age)}
      {fresh === "red" ? " · stale" : ""}
    </p>
  );
}

function PositionCard({ pos, actions, busy, armPct, trailOn, snap }: { pos: PositionView; actions: DeskActions; busy: string | null; armPct: number; trailOn: boolean; snap?: DeskSnapshot }) {
  const tag = pos.tag ?? (pos.entry === "manual" ? "manual" : null);
  const live = pos.book === "live";
  const valueUsd = pos.marketValueUsd;
  const stopDist = pos.markPrice > 0 ? pos.stopPrice / pos.markPrice - 1 : null;
  // v13.11 order ticket on this position (take profit / stop).
  const [ticket, setTicket] = useState<null | "take_profit" | "stop_sell">(null);
  return (
    <article className={`pos-card ${pos.pnlUsd >= 0 ? "is-up" : "is-down"}${live ? " live-pos" : ""}`}>
      <header>
        <CoinAvatar symbol={pos.symbol} mint={pos.mint} tone={tone(pos.pnlUsd)} />
        <div className="pos-title">
          <h3>
            <button className="pos-open" type="button" title={`Open the ${pos.symbol} coin card`} onClick={() => actions.openAddCoin(pos.mint)}>
              {pos.symbol} <span aria-hidden="true">›</span>
            </button>
          </h3>
          <p className="sub">
            {live ? <span className="live-badge live">LIVE</span> : snap ? <span className="book-tag paper">PAPER</span> : null} {tag ? <span className="chip tag">{tag}</span> : <span className="chip">{pos.source}</span>} score {pos.score.toFixed(2)}
            {pos.lpUnlocked ? " · LP unlocked" : ""}
            {pos.safetyChip ? <span className="chip">{pos.safetyChip}</span> : null}
            {pos.bundleChip ? <span className="chip">{pos.bundleChip}</span> : null}
          </p>
        </div>
        <div className="pnl">
          <PnlChip usd={pos.pnlUsd} pct={pos.pnlPct} />
          <span className="pos-value">{usd(valueUsd)}</span>
          <span className={`net-line ${pos.netPnlUsd == null ? "flat" : pos.netPnlUsd >= 0 ? "up" : "down"}`}>
            {pos.netPnlUsd == null
              ? "Net —"
              : `Net ${signedUsd(pos.netPnlUsd)}${pos.netPnlPct != null ? ` · ${signedPct(pos.netPnlPct)}` : ""}${pos.exitSlippage != null ? ` · slip ${(pos.exitSlippage * 100).toFixed(2)}%` : ""}`}
          </span>
        </div>
      </header>
      <MarkUpdated pos={pos} />
      <CoinSpark points={pos.marks ?? []} entry={pos.entryPrice} />
      <StopTrailBar stop={pos.stopPrice} entry={pos.entryPrice} mark={pos.markPrice} peak={pos.peakPrice} armPct={armPct} trailOn={trailOn} />
      <dl>
        <div>
          <dt>Value</dt>
          <dd>{usd(valueUsd)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{usd(pos.costUsd)}</dd>
        </div>
        <div>
          <dt>Entry</dt>
          <dd>{px(pos.entryPrice)}</dd>
        </div>
        <div>
          <dt>Mark</dt>
          <dd>{px(pos.markPrice)}</dd>
        </div>
        <div>
          <dt>Stop</dt>
          <dd className="down">
            {px(pos.stopPrice)}
            {stopDist != null ? <small> {signedPct(stopDist)}</small> : null}
          </dd>
        </div>
        <div>
          <dt>Peak</dt>
          <dd>
            {px(pos.peakPrice)}
            {pos.trailHintPrice != null ? <small> hint {px(pos.trailHintPrice)}</small> : null}
          </dd>
        </div>
      </dl>
      {/* v13.9: real-money buttons beside the paper position. The paper numbers above stay paper. */}
      {!live && snap ? <LiveTapPair snap={snap} mint={pos.mint} symbol={pos.symbol} actions={actions} /> : null}
      <div className="sells" role="group" aria-label={`Sell ${pos.symbol}`}>
        {!live && snap ? <span className="book-tag paper sells-tag">PAPER</span> : null}
        <TapSellButton mint={pos.mint} symbol={pos.symbol} actions={actions} book={pos.book} />
        {/* v13.7: live positions close in full only (no partial live sells). */}
        {(live ? ([] as const) : ([25, 50] as const)).map((pct) => (
          <button key={pct} className="tonal" type="button" disabled={busy === `${pos.mint}:${pct}`} onClick={() => void actions.sell(pos.mint, pos.symbol, pct)}>
            Sell {pct}%
          </button>
        ))}
        <button className="danger close" type="button" disabled={busy === `${pos.mint}:100`} onClick={() => void actions.sell(pos.mint, pos.symbol, 100, pos.book)}>
          {busy === `${pos.mint}:100` ? "Closing" : "Close"} 100%{live ? " LIVE" : ""}
        </button>
      </div>
      {snap ? (
        <>
          <div className="order-bar" role="group" aria-label={`Orders on ${pos.symbol}`}>
            <span className="ob-label">Orders{live ? " · LIVE" : ""}</span>
            <button type="button" className={`ot-chip side-take_profit${ticket === "take_profit" ? " on" : ""}`} onClick={() => setTicket(ticket === "take_profit" ? null : "take_profit")}>
              ▲ Take profit
            </button>
            <button type="button" className={`ot-chip side-stop_sell${ticket === "stop_sell" ? " on" : ""}`} onClick={() => setTicket(ticket === "stop_sell" ? null : "stop_sell")}>
              ▼ Stop
            </button>
          </div>
          <OrderChips snap={snap} actions={actions} mint={pos.mint} book={pos.book === "live" ? "live" : "paper"} />
          {ticket ? (
            <OrderTicket
              key={ticket}
              snap={snap}
              actions={actions}
              mint={pos.mint}
              symbol={pos.symbol}
              sides={ticket === "take_profit" ? ["take_profit", "stop_sell"] : ["stop_sell", "take_profit"]}
              book={live ? "live" : "paper"}
              mark={pos.markPrice > 0 ? pos.markPrice : null}
              entry={pos.entryPrice > 0 ? pos.entryPrice : null}
              stopPrice={pos.stopPrice}
              onClose={() => setTicket(null)}
            />
          ) : null}
        </>
      ) : null}
      <div className="links">
        {chartLinks(pos.mint).map((link) => (
          <a key={link.label} className="ghost" href={link.href} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
        ))}
      </div>
    </article>
  );
}

function liveBookCash(snap: DeskSnapshot): string {
  const lb = snap.liveBook;
  if (!lb) return "USDC unknown";
  return liveCashLabel({
    sol: snap.wallet?.solBalance,
    solUsd: snap.wallet?.solPriceUsd,
    usdc: snap.wallet?.usdcBalance,
    cashUsd: lb.cashUsd,
    cashKnown: lb.cashKnown,
    balanceError: lb.balanceError
  });
}

/** v13.7 armed desk: the live book (real money), apart from the AI's paper book. */
function LiveBookSection({ snap, actions, busy }: { snap: DeskSnapshot; actions: DeskActions; busy: string | null }) {
  const lb = snap.liveBook!;
  return (
    <section className="live-book" aria-label="Live positions">
      <div className="section-head">
        <h2>
          <span className="live-badge live">LIVE</span> Live positions · real $
        </h2>
        <span className={tone(lb.openPnlUsd)}>
          {signedUsd(lb.openPnlUsd)} · {lb.positions.length} open · {liveBookCash(snap)} · {lb.cashKnown === false ? (lb.cashUsd > 0 ? "equity stale" : "equity unknown") : `equity ${usd(lb.equityUsd)}`}
        </span>
      </div>
      <p className="fine live-scope">
        {lb.scope === "all" ? "Live: manual + AI." : "Live: manual only · AI: paper."} {usd(lb.tradeUsd)} per trade · trail {(lb.trailPct * 100).toFixed(1)}% · hard stop −
        {(snap.rules.stopLossPct * 100).toFixed(0)}% · {lb.dailyCapUsd != null ? `daily cap ${usd(lb.dailyCapUsd)}` : "no daily max"}.
      </p>
      {lb.positions.length === 0 ? (
        <p className="empty">No live positions. One-tap Buy on the Tape, Add coin or Advisor sends a real {usd(lb.tradeUsd)} buy.</p>
      ) : (
        <div className="positions">
          {lb.positions.map((pos, index) => (
            <PositionCard key={`live:${pos.mint}#${index}`} pos={pos} actions={actions} busy={busy} armPct={snap.rules.trailArmPct} trailOn={snap.prefs.trailTakeProfit === true} snap={snap} />
          ))}
        </div>
      )}
    </section>
  );
}

function HeroCard({ snap, openPnl }: { snap: DeskSnapshot; openPnl: number }) {
  const base = dayBase(snap.equity, snap.startingBalanceUsd);
  const day = snap.equityUsd - base;
  const dayPct = base > 0 ? day / base : null;
  return (
    <section className="hero" aria-label="Book">
      <div className="hero-top">
        <span className="kicker">Marked equity</span>
        <span className={`mode-chip ${snap.liveBook ? "paper" : snap.mode}`}>{snap.liveBook ? "PAPER · AI" : snap.mode === "live" ? "LIVE" : "PAPER"}</span>
      </div>
      <strong className="hero-value">{usd(snap.equityUsd)}</strong>
      <div className="hero-chips">
        <span className={`hchip ${tone(day)}`}>
          Today {signedUsd(day)} {dayPct != null ? `· ${signedPct(dayPct)}` : ""}
        </span>
        <span className={`hchip ${tone(snap.sessionPnlUsd)}`}>
          Session {signedUsd(snap.sessionPnlUsd)} · {signedPct(snap.sessionPnlPct)}
        </span>
      </div>
      <Sparkline points={snap.equity} baseline={snap.startingBalanceUsd} />
      <div className="hero-stats">
        <div>
          <label>Cash</label>
          <b>{usd(snap.cashUsd)}</b>
          <em>book {usd(snap.startingBalanceUsd)}</em>
        </div>
        <div>
          <label>Open</label>
          <b>{snap.positions.length}</b>
          <em className={tone(openPnl)}>{signedUsd(openPnl)}</em>
        </div>
        <div>
          <label>Cap / buy</label>
          <b>{usd(snap.positionCapUsd)}</b>
          <em>exp. {usd(snap.exposureUsd ?? 0)}</em>
        </div>
      </div>
    </section>
  );
}

function LastCrashCard({ crash, actions }: { crash: { at: number; version: string; brief: string }; actions: DeskActions }) {
  const [busy, setBusy] = useState(false);
  async function dismiss() {
    setBusy(true);
    const res = await api("/api/client-crash/dismiss", { body: {} });
    setBusy(false);
    if (!res.ok) actions.notify({ ok: false, text: res.body.error ?? "Could not dismiss the crash card" });
  }
  return (
    <section className="card crash" aria-label="Last crash">
      <header>
        <h3>Last crash on the desk</h3>
        <span>
          {new Date(crash.at).toLocaleString([], { hour12: false })} · {crash.version}
        </span>
      </header>
      <pre>{crash.brief}</pre>
      <button className="ghost" type="button" disabled={busy} onClick={() => void dismiss()}>
        Dismiss
      </button>
    </section>
  );
}

function AdviceRow({ note, onBuy, onLiveBuy }: { note: AdviceNote; onBuy: (mint: string, symbol: string) => void; onLiveBuy: (mint: string, symbol: string) => void }) {
  return (
    <article className="advice-row">
      <span className={`stance ${note.stance}`}>{note.stance}</span>
      <div>
        <p>{note.text}</p>
        {note.stance === "near-miss" && note.mint ? (
          <>
            <button className="ghost buy" type="button" onClick={() => onBuy(note.mint!, note.symbol || "this mint")}>
              Buy
            </button>
            <button className="ghost buy" type="button" onClick={() => onLiveBuy(note.mint!, note.symbol || "this mint")}>
              LIVE BUY
            </button>
          </>
        ) : null}
      </div>
    </article>
  );
}

function LiveReadyCard({ readiness, busy, onReady }: { readiness: LiveReadiness; busy: boolean; onReady: (ready: boolean) => void }) {
  return (
    <section className="card ready" aria-label="Live ready">
      <header>
        <h3>Live ready</h3>
        <span>{readiness.mode === "live" ? "LIVE" : "STILL PAPER"}</span>
      </header>
      <ul>
        {readiness.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <label className="check">
        <input type="checkbox" checked={readiness.operatorReady} disabled={busy} onChange={(event) => onReady(event.target.checked)} />
        Mark checklist ready
      </label>
      <p className="fine">
        This note does not enable live trading and does not save a seed or private key. The wallet key lives only in WALLET_PRIVATE_KEY (or WALLET_KEYPAIR_PATH) on the desk host. Night Desk has no wallet vault.
      </p>
    </section>
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
    <svg viewBox="0 0 320 112" role="img" aria-label="Equity curve" preserveAspectRatio="none">
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
