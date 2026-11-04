import { useEffect, useState } from "react";
import { api } from "../api";

interface Row {
  mint: string;
  symbol?: string;
  score: number;
  rug: string[];
  progressPct?: number;
  uniqueBuyers?: number;
  volumeLamports?: number;
}

interface BuyResult {
  reason?: string;
  simulateOnly?: boolean;
  armed?: boolean;
  intent?: { mode?: string; simulateOnly?: boolean; mint?: string; unsignedTx?: string | null } | null;
}

/** Top 20 new coins, refreshed every 5 seconds. Auto-buy only prepares an intent. */
export function Scanner() {
  const [rows, setRows] = useState<Row[]>([]);
  const [wallet, setWallet] = useState("");
  const [sol, setSol] = useState("5000000");
  const [enabled, setEnabled] = useState(false);
  const [live, setLive] = useState(false);
  const [result, setResult] = useState<BuyResult | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await api<{ coins: Row[] }>("/api/pump/scanner");
    if (res.body.coins) setRows(res.body.coins);
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  async function buy() {
    setError("");
    const res = await api<BuyResult>("/api/pump/scanner/auto-buy", {
      body: { enabled, wallet, solLamports: sol, live }
    });
    if (!res.ok && res.body.error) {
      setError(res.body.error);
      setResult(null);
      return;
    }
    setResult(res.body);
  }

  const intent = result?.intent;
  const simulate = intent ? intent.simulateOnly !== false : result?.simulateOnly !== false;

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
      <p className="dim">Prepares one unsigned buy at most every 10 minutes, inside the caps. It stays simulate-only unless this process is armed. You approve it in your wallet.</p>
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
          {result.reason || "done"}. {simulate ? "Simulate-only. Nothing was sent." : "Armed. The transaction is still unsigned — approve it in your wallet."}
          {intent?.unsignedTx ? " Unsigned transaction is ready." : ""}
        </p>
      ) : null}
    </section>
  );
}
