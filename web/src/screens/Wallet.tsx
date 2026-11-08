import { useState } from "react";
import { api } from "../api";
import { usd } from "../format";
import type { DeskSnapshot, WalletView } from "../types";
import { shortAddress, walletLines } from "../walletText";

export function WalletCard({ snap }: { snap: DeskSnapshot }) {
  const [view, setView] = useState<WalletView | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const w = view && snap.wallet && view.balanceAt != null && (snap.wallet.balanceAt ?? 0) < view.balanceAt ? view : snap.wallet;
  const status = walletLines(w, snap.mode);
  async function refresh() {
    setBusy(true);
    const res = await api<WalletView>("/api/wallet");
    setBusy(false);
    if (res.ok) setView(res.body as WalletView);
  }
  return (
    <section className={`card wallet-card ${status.tone}`} aria-label="Live wallet">
      <header>
        <h3>Live wallet</h3>
        <span className={`live-badge ${status.tone}`}>{status.badge}</span>
      </header>
      <dl className="wallet-grid">
        <div>
          <dt>Address</dt>
          <dd title={w?.publicKey ?? ""}>{shortAddress(w?.publicKey)}</dd>
        </div>
        <div>
          <dt>SOL</dt>
          <dd>{w?.solBalance != null ? w.solBalance.toFixed(4) : "—"}</dd>
        </div>
        <div>
          <dt>USDC</dt>
          <dd>{w?.usdcBalance != null ? usd(w.usdcBalance) : "—"}</dd>
        </div>
        <div>
          <dt>Key loaded</dt>
          <dd className={w?.keyLoaded ? "up" : "down"}>{w?.keyLoaded ? "Yes" : "No"}</dd>
        </div>
      </dl>
      <p className="wallet-rules">
        Live: {usd(w?.liveTradeUsd ?? 5)} per trade · {w?.liveDailyCapUsd != null ? `daily cap ${usd(w.liveDailyCapUsd)}` : "no daily cap"} · trail {(((w?.liveTrailPct ?? 0.01) * 100)).toFixed(1)}% · hard stop −{(snap.rules.stopLossPct * 100).toFixed(0)}%
        {w?.liveSpentTodayUsd ? ` · ${usd(w.liveSpentTodayUsd)} spent today` : ""}
      </p>
      <ul>
        {status.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="wallet-actions">
        {w?.publicKey ? (
          <button className="ghost sm" type="button" onClick={() => void navigator.clipboard?.writeText(w.publicKey!)}>
            Copy address
          </button>
        ) : null}
        <button className="ghost sm" type="button" disabled={busy} onClick={() => void refresh()}>
          {busy ? "Reading…" : "Refresh balance"}
        </button>
      </div>
      <p className="fine">Read-only. A Jupiter buy spends USDC and keeps about {w?.minFeeSol ?? 0.005} SOL for fees. A pump curve buy spends SOL. The private key never leaves the desk host and is never shown here.{w?.balanceError ? ` Balance is not current: ${w.balanceError}` : ""}</p>
    </section>
  );
}
