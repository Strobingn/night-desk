import { useEffect, useState } from "react";
import { api } from "../api";
import { age, compactUsd, px, signedPct, usd } from "../format";
import type { CoinLookup, DeskSnapshot, WatchItem } from "../types";
import type { DeskActions } from "../App";

const DOLLAR_CHIPS = [10, 25, 50, 100, 250] as const;

export function AddCoinScreen({ snap, actions, query, busy }: { snap: DeskSnapshot; actions: DeskActions; query: { q: string; n: number }; busy: string | null }) {
  const [input, setInput] = useState(query.q);
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<CoinLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number>(0);
  const [confirmSize, setConfirmSize] = useState(false);
  const [watchBusy, setWatchBusy] = useState<string | null>(null);

  async function lookup(raw: string) {
    const q = raw.trim();
    if (!q) {
      setError("Paste a Solana mint or a DexScreener, pump.fun, Birdeye, GMGN, Jupiter, Raydium, Photon, BullX or Solscan link.");
      return;
    }
    setLooking(true);
    setError(null);
    setResult(null);
    const res = await api<CoinLookup>(`/api/lookup?q=${encodeURIComponent(q)}`);
    setLooking(false);
    if (!res.ok || (res.body as { ok?: boolean }).ok === false) {
      setError(res.body.error ?? `Lookup failed (HTTP ${res.status}). No buy without a reliable price.`);
      return;
    }
    const found = res.body as CoinLookup;
    setResult(found);
    setConfirmSize(false);
    const start = snap.prefs.defaultBuyUsd ?? found.positionCapUsd;
    setSize(Math.max(1, Math.floor(Math.min(start, sliderMax(found)))));
  }

  useEffect(() => {
    if (query.q) {
      setInput(query.q);
      void lookup(query.q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.n]);

  async function watch(q: string) {
    setWatchBusy(q);
    const res = await api<{ item?: WatchItem }>("/api/watchlist", { body: { q } });
    setWatchBusy(null);
    actions.notify(res.ok ? { ok: true, text: `Watching ${res.body.item?.symbol ?? "coin"}.` } : { ok: false, text: res.body.error ?? "Watchlist add failed." });
    if (res.ok && result) setResult({ ...result, watching: true });
  }

  async function unwatch(item: WatchItem) {
    setWatchBusy(item.mint);
    const res = await api("/api/watchlist/remove", { body: { mint: item.mint } });
    setWatchBusy(null);
    if (!res.ok) actions.notify({ ok: false, text: res.body.error ?? "Remove failed." });
    if (res.ok && result?.mint === item.mint) setResult({ ...result, watching: false });
  }

  const max = result ? sliderMax(result) : 0;
  const overCap = result != null && size > result.positionCapUsd + 0.005;
  const overPool = result != null && size > result.poolMaxUsd + 0.005;
  const capPct = (snap.rules.maxPositionPct * 100).toFixed(0);

  return (
    <div className="add-screen">
      <section className="card add-card">
        <header>
          <h3>Add coin</h3>
          <span>paper only</span>
        </header>
        <form
          className="lookup-form"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup(input);
          }}
        >
          <input
            aria-label="Mint or link"
            placeholder="Mint, or a DexScreener / pump.fun / Birdeye / GMGN / Jupiter link"
            value={input}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setInput(event.target.value)}
          />
          <button className="primary" type="submit" disabled={looking}>
            {looking ? "Looking" : "Look up"}
          </button>
        </form>
        <p className="fine">Works with a Solana mint or a DexScreener, pump.fun, Birdeye, GMGN, Jupiter, Raydium, Photon, BullX or Solscan link. A DexScreener pair resolves to its token.</p>
        {error ? <div className="banner">{error}</div> : null}
      </section>

      {result ? (
        <section className="card coin">
          <header>
            <div>
              <h3>{result.symbol}</h3>
              <p className="sub">
                {result.name} · <span className="chip tag">{result.tag}</span>
                {result.dex ? ` · ${result.dex}` : ""}
              </p>
            </div>
            <a className="ghost" href={result.dexscreenerUrl} target="_blank" rel="noopener noreferrer">
              DexScreener
            </a>
          </header>
          <dl>
            <div>
              <dt>Price</dt>
              <dd>
                ${px(result.priceUsd)} <small>{result.priceSource === "jupiter" ? "Jupiter" : "DexScreener"}</small>
              </dd>
            </div>
            <div>
              <dt>Liquidity</dt>
              <dd>{compactUsd(result.liquidityUsd)}</dd>
            </div>
            <div>
              <dt>1h volume</dt>
              <dd>{compactUsd(result.volume1hUsd)}</dd>
            </div>
            <div>
              <dt>Mcap</dt>
              <dd>{compactUsd(result.marketCapUsd)}</dd>
            </div>
            <div>
              <dt>Age</dt>
              <dd>{age(result.ageSeconds)}</dd>
            </div>
            <div>
              <dt>Analyst</dt>
              <dd className={result.analyst.pass ? "up" : "down"}>
                {result.analyst.score.toFixed(2)} <small>line {result.analyst.line.toFixed(2)}</small>
              </dd>
            </div>
          </dl>
          <div className={`verdict ${result.filterPass && result.analyst.pass ? "pass" : result.hardKills.length ? "kill" : "fail"}`}>
            {result.filterPass && result.analyst.pass
              ? "Clears every Filter gate and the Analyst line."
              : result.hardKills.length
                ? `Hard kill: ${result.hardKills.map((k) => k.code).join(", ")}. Buy needs "Buy anyway".`
                : "Misses at least one gate. You can still paper-buy it manually."}
          </div>
          <ul className="checks">
            {result.checks.map((check) => (
              <li key={check.code} className={check.pass ? "pass" : "fail"}>
                <i>{check.pass ? "✓" : "✕"}</i>
                <span>
                  <code>{check.code}</code> {check.message}
                </span>
              </li>
            ))}
            <li className={result.analyst.pass ? "pass" : "fail"}>
              <i>{result.analyst.pass ? "✓" : "✕"}</i>
              <span>
                <code>ANALYST</code> score {result.analyst.score.toFixed(2)} vs line {result.analyst.line.toFixed(2)}
              </span>
            </li>
          </ul>

          {result.canBuy ? (
            <div className="sizer">
              <div className="slider-head">
                <b>Paper buy size</b>
                <span className="val">{usd(size)}</span>
              </div>
              <input
                type="range"
                aria-label="Buy size in dollars"
                min={1}
                max={Math.max(1, max)}
                step={1}
                value={Math.min(size, Math.max(1, max))}
                onChange={(event) => {
                  setSize(Number(event.target.value));
                  setConfirmSize(false);
                }}
              />
              <div className="chips">
                {DOLLAR_CHIPS.filter((n) => n <= max).map((n) => (
                  <button key={n} type="button" className={size === n ? "on" : ""} onClick={() => { setSize(n); setConfirmSize(false); }}>
                    ${n}
                  </button>
                ))}
                <button type="button" onClick={() => { setSize(Math.max(1, Math.floor(result.positionCapUsd * 100) / 100)); setConfirmSize(false); }}>
                  Cap {usd(result.positionCapUsd, 0)}
                </button>
                <button type="button" onClick={() => { setSize(Math.max(1, Math.floor(max))); setConfirmSize(false); }}>
                  Max {usd(max, 0)}
                </button>
              </div>
              <p className="fine">
                Cap {capPct}% = {usd(result.positionCapUsd)} · manual max {usd(result.manualMaxUsd)} with confirm · cash {usd(result.cashUsd)} · pool takes about {usd(result.poolMaxUsd)} under the {(result.maxEntrySlippage * 100).toFixed(1)}% slippage cap and exit-depth check.
              </p>
              {overCap ? (
                <label className="check confirm">
                  <input type="checkbox" checked={confirmSize} onChange={(event) => setConfirmSize(event.target.checked)} />
                  Confirm {usd(size)} — above the {capPct}% per-position cap. Without this the desk fills at the cap.
                </label>
              ) : null}
              {overPool ? <p className="warn">This pool only takes about {usd(result.poolMaxUsd)} under the slippage cap and pool-depth check. The desk refuses a bigger fill.</p> : null}
              <p className="fine">Hard stop −{(snap.rules.stopLossPct * 100).toFixed(0)}% from the fill applies. Tagged “{result.tag}” on the card.</p>
              <div className="buy-actions">
                <button
                  className="primary big"
                  type="button"
                  disabled={busy === result.mint || size <= 0}
                  onClick={() =>
                    actions.askBuy({
                      mint: result.mint,
                      symbol: result.symbol,
                      sizeUsd: size,
                      minutesLeft: null,
                      confirmSize: overCap && confirmSize,
                      hardKill: result.hardKills.length ? result.hardKills.map((k) => `${k.code}: ${k.message}`).join(" ") : undefined
                    })
                  }
                >
                  {busy === result.mint ? "Buying" : result.hardKills.length ? `Buy ${result.symbol} anyway…` : `Paper buy ${usd(size)}`}
                </button>
                <button className="ghost" type="button" disabled={result.watching || watchBusy === result.mint} onClick={() => void watch(result.mint)}>
                  {result.watching ? "Watching" : "Add to watchlist"}
                </button>
              </div>
            </div>
          ) : (
            <div className="sizer">
              <p className="warn">{result.buyBlockedReason ?? "Buy is blocked."}</p>
              <button className="ghost" type="button" disabled={result.watching || watchBusy === result.mint} onClick={() => void watch(result.mint)}>
                {result.watching ? "Watching" : "Add to watchlist"}
              </button>
            </div>
          )}
        </section>
      ) : null}

      <section className="card watch">
        <header>
          <h3>Watchlist</h3>
          <span>{snap.watchlist?.length ?? 0} · prices every 20s</span>
        </header>
        {!snap.watchlist?.length ? (
          <p className="empty">Nothing watched. Look a coin up and tap Add to watchlist. Saved on the desk under data/.</p>
        ) : (
          <div className="watch-rows">
            {snap.watchlist.map((item) => {
              const held = snap.positions.some((pos) => pos.mint === item.mint);
              return (
                <article className="watch-row" key={item.mint}>
                  <div>
                    <span className="sym">{item.symbol}</span>
                    <span className="sub">
                      {item.platform} · added {new Date(item.addedAt).toLocaleDateString()} at ${px(item.addedPriceUsd)}
                    </span>
                  </div>
                  <div className="num">
                    ${px(item.lastPriceUsd)}
                    <span className={`sub ${item.changePct == null ? "" : item.changePct >= 0 ? "up" : "down"}`}>{signedPct(item.changePct)} since added</span>
                  </div>
                  <div className="watch-actions">
                    <a className="ghost" href={item.dexscreenerUrl} target="_blank" rel="noopener noreferrer">
                      Chart
                    </a>
                    <button className="ghost buy" type="button" disabled={held} onClick={() => { setInput(item.mint); void lookup(item.mint); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                      {held ? "Open" : "Buy"}
                    </button>
                    <button className="ghost" type="button" disabled={watchBusy === item.mint} onClick={() => void unwatch(item)}>
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function sliderMax(found: CoinLookup): number {
  return Math.max(1, Math.floor(Math.min(found.manualMaxUsd, found.cashUsd)));
}
