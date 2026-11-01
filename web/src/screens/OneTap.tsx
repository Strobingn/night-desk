import { capHint } from "../tickerText";
import { useEffect, useState } from "react";
import { usd } from "../format";
import type { DeskSnapshot } from "../types";
import type { DeskActions } from "../App";

/**
 * v13.3 one-tap bar: the one-tap size and max slippage sit right next to the Buy buttons,
 * plus Sell all when anything is open. Every buy still runs the desk's full risk checks.
 */
export function OneTapBar({ snap, actions, showSellAll = true }: { snap: DeskSnapshot; actions: DeskActions; showSellAll?: boolean }) {
  const [sizeText, setSizeText] = useState(String(actions.tapUsd));
  const slipNow = Math.round((snap.rules.maxEntrySlippage ?? 0.03) * 10_000) / 100;
  const [slip, setSlip] = useState(slipNow);
  const [slipText, setSlipText] = useState(String(slipNow));
  const [armed, setArmed] = useState(false);
  useEffect(() => setSizeText(String(actions.tapUsd)), [actions.tapUsd]);
  useEffect(() => {
    setSlip(slipNow);
    setSlipText(String(slipNow));
  }, [slipNow]);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3_000);
    return () => window.clearTimeout(t);
  }, [armed]);
  const maxSize = Math.max(10, Math.floor(Math.max(snap.manualMaxUsd ?? 0, snap.positionCapUsd, actions.tapUsd)));
  const commitSlip = (v: number) => {
    if (!Number.isFinite(v)) return;
    const c = Math.min(50, Math.max(0.5, Math.round(v * 2) / 2));
    setSlip(c);
    setSlipText(String(c));
    if (c !== slipNow) void actions.saveSlippage(c);
  };
  const selling = actions.tapping.has("sell-all");
  const live = snap.mode === "live";
  return (
    <section className={`onetap card${live ? " live" : ""}`} aria-label="One-tap trading">
      {live ? (
        <div className="ot-live">
          <span className="live-badge live">LIVE</span>
          <span>
            One tap = real buy of {usd(snap.prefs.liveTradeUsd ?? 5)} · trail {(((snap.prefs.liveTrailPct ?? 0.01) * 100)).toFixed(1)}% · stop −{(snap.rules.stopLossPct * 100).toFixed(0)}%. Change the size in Settings → Live wallet.
          </span>
        </div>
      ) : null}
      <div className="ot-row">
        {live ? null : (
        <label className="ot-field">
          <span>One-tap size</span>
          <input
            type="range"
            aria-label="One-tap size slider"
            min={1}
            max={maxSize}
            step={1}
            value={Math.min(maxSize, actions.tapUsd)}
            onChange={(e) => actions.setTapUsd(Number(e.target.value))}
          />
          <span className="ot-num">
            $
            <input
              className="num"
              aria-label="One-tap size in dollars"
              inputMode="decimal"
              value={sizeText}
              onChange={(e) => {
                setSizeText(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value.trim() !== "" && Number.isFinite(n) && n > 0) actions.setTapUsd(n);
              }}
            />
          </span>
        </label>
        )}
        <label className="ot-field">
          <span>Max slippage</span>
          <input
            type="range"
            aria-label="Max slippage slider"
            min={0.5}
            max={50}
            step={0.5}
            value={slip}
            onChange={(e) => {
              setSlip(Number(e.target.value));
              setSlipText(e.target.value);
            }}
            onPointerUp={(e) => commitSlip(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commitSlip(Number((e.target as HTMLInputElement).value))}
          />
          <span className="ot-num">
            <input
              className="num"
              aria-label="Max slippage percent"
              inputMode="decimal"
              value={slipText}
              onChange={(e) => setSlipText(e.target.value)}
              onBlur={() => commitSlip(Number(slipText))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitSlip(Number(slipText));
              }}
            />
            %
          </span>
        </label>
        {showSellAll && snap.positions.length ? (
          <button
            className={`danger sell-all${armed ? " armed" : ""}`}
            type="button"
            disabled={selling}
            onClick={() => {
              if (!armed) return setArmed(true);
              setArmed(false);
              void actions.sellAll();
            }}
          >
            {selling ? "Selling all" : armed ? `Tap again: sell all ${snap.positions.length}` : `Sell all (${snap.positions.length})`}
          </button>
        ) : null}
      </div>
      <p className="fine">
        {live ? "LIVE: " : ""}One tap = {live ? "LIVE" : "paper"} buy {usd(actions.tapUsd)} now ({live ? `live size, cut to the ${usd(snap.positionCapUsd)} cap and wallet USDC` : capHint(snap.capWhy, snap.positionCapUsd, actions.tapUsd)}). No dialog, but the slippage cap ({slip}%), pool-depth, crash
        guard, hard kills, cooldown and the −{(snap.rules.stopLossPct * 100).toFixed(0)}% stop all still apply. A stop cannot prevent a gap.
      </p>
    </section>
  );
}

/** The one-tap Buy button for a coin card, watchlist row or looked-up coin. */
export function TapBuyButton({ mint, symbol, actions, sizeUsd, className = "primary sm tap-buy" }: { mint: string; symbol: string; actions: DeskActions; sizeUsd?: number; className?: string }) {
  const inFlight = actions.tapping.has(`buy:${mint}`);
  const live = actions.live === true;
  // v13.5: a LIVE desk always taps the live size.
  const size = live ? actions.tapUsd : sizeUsd ?? actions.tapUsd;
  return (
    <button
      className={`${className}${live ? " live" : ""}`}
      type="button"
      disabled={inFlight}
      aria-label={`One-tap ${live ? "LIVE " : ""}buy ${symbol} for ${usd(size)}`}
      onClick={(event) => {
        event.stopPropagation();
        void actions.oneTapBuy(mint, symbol, live ? undefined : sizeUsd);
      }}
    >
      {inFlight ? "Buying…" : `⚡ Buy ${usd(size, size >= 100 ? 0 : 2)}${live ? " LIVE" : ""}`}
    </button>
  );
}

/** The one-tap Sell button for an open position (closes 100%, no dialog). */
export function TapSellButton({ mint, symbol, actions }: { mint: string; symbol: string; actions: DeskActions }) {
  const inFlight = actions.tapping.has(`sell:${mint}`);
  const live = actions.live === true;
  return (
    <button
      className={`danger tap-sell${live ? " live" : ""}`}
      type="button"
      disabled={inFlight}
      aria-label={`One-tap ${live ? "LIVE " : ""}sell ${symbol}`}
      onClick={(event) => {
        event.stopPropagation();
        void actions.oneTapSell(mint, symbol);
      }}
    >
      {inFlight ? "Selling…" : live ? "⚡ Sell now LIVE" : "⚡ Sell now"}
    </button>
  );
}
