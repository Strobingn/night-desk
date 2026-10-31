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
  return (
    <section className="onetap card" aria-label="One-tap trading">
      <div className="ot-row">
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
        One tap = paper buy {usd(actions.tapUsd)} now (cut to the {usd(snap.positionCapUsd)} cap and cash). No dialog, but the slippage cap ({slip}%), pool-depth, crash
        guard, hard kills, cooldown and the −{(snap.rules.stopLossPct * 100).toFixed(0)}% stop all still apply. A stop cannot prevent a gap.
      </p>
    </section>
  );
}

/** The one-tap Buy button for a coin card, watchlist row or looked-up coin. */
export function TapBuyButton({ mint, symbol, actions, sizeUsd, className = "primary sm tap-buy" }: { mint: string; symbol: string; actions: DeskActions; sizeUsd?: number; className?: string }) {
  const inFlight = actions.tapping.has(`buy:${mint}`);
  const size = sizeUsd ?? actions.tapUsd;
  return (
    <button
      className={className}
      type="button"
      disabled={inFlight}
      aria-label={`One-tap buy ${symbol} for ${usd(size)}`}
      onClick={(event) => {
        event.stopPropagation();
        void actions.oneTapBuy(mint, symbol, sizeUsd);
      }}
    >
      {inFlight ? "Buying…" : `⚡ Buy ${usd(size, size >= 100 ? 0 : 2)}`}
    </button>
  );
}

/** The one-tap Sell button for an open position (closes 100%, no dialog). */
export function TapSellButton({ mint, symbol, actions }: { mint: string; symbol: string; actions: DeskActions }) {
  const inFlight = actions.tapping.has(`sell:${mint}`);
  return (
    <button
      className="danger tap-sell"
      type="button"
      disabled={inFlight}
      aria-label={`One-tap sell ${symbol}`}
      onClick={(event) => {
        event.stopPropagation();
        void actions.oneTapSell(mint, symbol);
      }}
    >
      {inFlight ? "Selling…" : "⚡ Sell now"}
    </button>
  );
}
