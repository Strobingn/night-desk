import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { approveIntent } from "../pump/wallet/sign";
import {
  attachWalletStandard,
  browserHost,
  connectInjected,
  connectStandard,
  injectedChoices,
  type ConnectedWallet,
  type StandardWallet
} from "../pump/wallet/provider";

interface Row {
  mint: string;
  symbol?: string;
  score: number;
  rug: string[];
  progressPct?: number;
  uniqueBuyers?: number;
  volumeLamports?: number;
}

interface BuyIntent {
  mode?: string;
  simulateOnly?: boolean;
  mint?: string;
  wallet?: string;
  solLamports?: string;
  unsignedTx?: string | null;
}

interface BuyResult {
  reason?: string;
  simulateOnly?: boolean;
  armed?: boolean;
  intent?: BuyIntent | null;
}

/** Top 20 new coins, refreshed every 5 seconds. An armed buy is signed once in the wallet. */
export function Scanner() {
  const [rows, setRows] = useState<Row[]>([]);
  const [wallet, setWallet] = useState("");
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [wallets, setWallets] = useState<StandardWallet[]>([]);
  const [sol, setSol] = useState("5000000");
  const [cap, setCap] = useState("5000000");
  const [enabled, setEnabled] = useState(false);
  const [live, setLive] = useState(false);
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<BuyResult | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const injected = useMemo(() => injectedChoices(browserHost()), [wallets]);

  async function load() {
    const res = await api<{ coins: Row[] }>("/api/pump/scanner");
    if (res.body.coins) setRows(res.body.coins);
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const stop = attachWalletStandard(browserHost(), (found) => {
      setWallets((prev) => (prev.some((item) => item.name === found.name) ? prev : [...prev, found]));
    });
    void api<{ armed?: boolean; caps?: { tradeLamports?: string } }>("/api/pump/status").then((res) => {
      if (!res.ok) return;
      setArmed(Boolean(res.body.armed));
      if (res.body.caps?.tradeLamports) setCap(res.body.caps.tradeLamports);
    });
    return stop;
  }, []);

  async function buy() {
    setError("");
    setNote("");
    const payer = connected?.address || wallet.trim();
    const res = await api<BuyResult>("/api/pump/scanner/auto-buy", {
      body: { enabled, wallet: payer, solLamports: sol, live: live && armed }
    });
    if (!res.ok && res.body.error) {
      setError(res.body.error);
      setResult(null);
      return;
    }
    setResult(res.body);
    const intent = res.body.intent;
    if (!intent) {
      setNote(res.body.reason || "No buy prepared.");
      return;
    }
    const simulateOnly = intent.simulateOnly !== false || intent.mode === "simulate";
    const approved = await approveIntent({
      unsignedTx: intent.unsignedTx ?? null,
      wallet: intent.wallet || payer,
      amountLamports: BigInt(intent.solLamports || sol || "0"),
      capLamports: BigInt(cap),
      simulateOnly,
      opener: connected
    });
    setNote(approved.message);
  }

  const intent = result?.intent;

  return (
    <section className="card" aria-label="Hot scanner">
      <h2>Hot scanner</h2>
      <p className="dim">Ranked by volume, curve progress, buy/sell ratio, unique buyers, holder growth, and age. A rug flag scores 0. Refreshes every 5 seconds.</p>
      <ul className="scout-status">
        {rows.length === 0 ? <li className="dim">No new coins in the book yet.</li> : null}
        {rows.map((row) => (
          <li key={row.mint}>
            <strong>{row.symbol || row.mint.slice(0, 4)}</strong>
            <em>
              score {row.score.toFixed(3)}
              {row.rug.length ? ` · rug: ${row.rug.join(", ")}` : ""} · curve {row.progressPct ?? 0}%
            </em>
          </li>
        ))}
      </ul>
      <label className="toggle-row">
        <span>Auto-buy best</span>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      </label>
      <p className="dim">
        Prepares one unsigned buy at most every 10 minutes, inside the caps. Simulate mode never opens the wallet.
        {armed ? " This process is armed, so a live buy is signed once in Phantom or Solflare." : " This process is simulate-only."}
      </p>
      <div className="chips">
        {wallets.map((item) => (
          <button key={item.name} type="button" className="ghost sm" onClick={() => void connectStandard(item).then(setConnected).catch((err: Error) => setError(err.message))}>
            {item.name}
          </button>
        ))}
        {injected.map((item) => (
          <button key={item.name} type="button" className="ghost sm" onClick={() => void connectInjected(item.name, item.provider).then(setConnected).catch((err: Error) => setError(err.message))}>
            {item.name}
          </button>
        ))}
      </div>
      <p className="dim">{connected ? `Connected ${connected.address}` : "Wallet not connected."}</p>
      <div className="lookup-form">
        <input value={wallet} onChange={(event) => setWallet(event.target.value)} placeholder="Wallet address" aria-label="Wallet" />
        <input className="num-input" value={sol} onChange={(event) => setSol(event.target.value)} aria-label="Lamports" />
      </div>
      <label className="toggle-row">
        <span>Ask for live (ignored unless armed)</span>
        <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
      </label>
      <button type="button" className="primary sm" onClick={() => void buy()} disabled={!enabled}>
        Prepare best
      </button>
      {error ? <p className="hard-stop">{error}</p> : null}
      {result ? (
        <p className="verdict">
          {result.reason || "done"}. {note || (intent?.simulateOnly === false ? "Armed. Waiting for the wallet." : "Simulate-only. The wallet stays closed.")}
        </p>
      ) : null}
    </section>
  );
}
