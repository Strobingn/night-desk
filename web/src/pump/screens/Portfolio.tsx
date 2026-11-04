import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { notifyFillsImported } from "../fillRevision";
import { attachWalletStandard, browserHost, connectInjected, connectStandard, injectedChoices, type StandardWallet } from "../wallet/provider";

interface Position {
  wallet: string;
  mint: string;
  symbol?: string;
  venues: string[];
  sources: string[];
  tokenAmount: string;
  avgEntryLamportsPerToken: string | null;
  costBasis: "known" | "unknown";
  costBasisReason?: string;
  realizedPnlLamports: string | null;
  realizedReason?: string;
  unrealizedPnlLamports: string | null;
  unrealizedReason?: string;
  marketCapLamports: string | null;
  progressPct: number | null;
  curvePosition: string;
}

interface Snapshot {
  wallets: Array<{ pubkey: string; label?: string }>;
  positions: Position[];
  totals: {
    realizedPnlLamports: string | null;
    realizedReason?: string;
    unrealizedPnlLamports: string | null;
    unrealizedReason?: string;
  };
  score: { score: number; formula: string; volumeLamports: string; holdFactor: number; volumeFactor: number };
}

/** Read-only wallets and pump.fun positions, including fills that did not start on this desk. */
export function PortfolioScreen() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [manual, setManual] = useState("");
  const standards = useRef<StandardWallet[]>([]);

  async function refresh() {
    const res = await api<{ portfolio?: Snapshot }>("/api/pump/portfolio");
    if (!res.ok || !res.body.portfolio) {
      setError(res.body.error ?? "Portfolio unavailable.");
      return;
    }
    setSnap(res.body.portfolio);
    setError("");
  }

  useEffect(() => {
    const detach = attachWalletStandard(browserHost(), (wallet) => {
      standards.current = [...standards.current.filter((item) => item.name !== wallet.name), wallet];
    });
    void refresh();
    return detach;
  }, []);

  async function connect(pubkey?: string) {
    try {
      const address = pubkey ?? (await connectAdapter(standards.current)).address;
      const res = await api("/api/pump/portfolio/wallets", { method: "POST", body: { pubkey: address } });
      if (!res.ok) throw new Error(res.body.error ?? "Could not save that address.");
      setManual("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connect failed.");
    }
  }

  async function importHistory(pubkey: string) {
    const res = await api("/api/pump/portfolio/import", { method: "POST", body: { wallet: pubkey, fromChain: true } });
    if (!res.ok) {
      setError(res.body.error ?? "Import failed.");
      return;
    }
    await refresh();
    notifyFillsImported();
  }

  const totals = snap?.totals;
  return (
    <section className="card" aria-label="Portfolio">
      <header>
        <h3>Portfolio</h3>
        <span>{snap ? `score ${snap.score.score}` : ""}</span>
      </header>
      <p className="fine">Addresses only. Connect uses the desk wallet adapter and does not sign. Positions include Night Desk fills and other pump.fun buys on the curve and on PumpSwap.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
        <button type="button" className="primary sm" onClick={() => void connect()}>
          Connect wallet
        </button>
        <input aria-label="Wallet address" value={manual} onChange={(event) => setManual(event.target.value)} placeholder="Paste a public key" style={{ flex: 1, minWidth: 160 }} />
        <button type="button" className="ghost sm" onClick={() => void connect(manual)} disabled={!manual.trim()}>
          Add address
        </button>
      </div>
      {error ? <p className="warn">{error}</p> : null}
      {totals ? (
        <p className="fine">
          Realized {money(totals.realizedPnlLamports, totals.realizedReason)} · Unrealized {money(totals.unrealizedPnlLamports, totals.unrealizedReason)}
        </p>
      ) : null}
      <ul className="scout-status">
        {(snap?.wallets ?? []).map((wallet) => (
          <li key={wallet.pubkey}>
            <strong>{wallet.label ?? short(wallet.pubkey)}</strong>
            <em>
              <button type="button" className="ghost sm" onClick={() => void importHistory(wallet.pubkey)}>
                Import chain history
              </button>
            </em>
          </li>
        ))}
        {(snap?.positions ?? []).map((position) => (
          <li key={`${position.wallet}:${position.mint}`}>
            <strong>
              {position.symbol ?? short(position.mint)} · {position.curvePosition.replaceAll("_", " ")}
            </strong>
            <em>
              {position.venues.join(" + ")} · {position.sources.join(" + ")} · size {position.tokenAmount}
              {position.avgEntryLamportsPerToken ? ` · avg ${position.avgEntryLamportsPerToken} lamports/token` : ""}
              {position.progressPct != null ? ` · curve ${position.progressPct}%` : ""}
              {position.costBasis === "unknown" ? ` · ${position.costBasisReason}` : ` · realized ${money(position.realizedPnlLamports, position.realizedReason)}`}
              {position.unrealizedReason ? ` · ${position.unrealizedReason}` : ""}
            </em>
          </li>
        ))}
      </ul>
      {snap ? <p className="fine">{snap.score.formula}</p> : null}
    </section>
  );
}

async function connectAdapter(standards: readonly StandardWallet[]) {
  const injected = injectedChoices(browserHost())[0];
  if (injected) return connectInjected(injected.name, injected.provider);
  const standard = standards[0];
  if (!standard) throw new Error("No wallet adapter is available.");
  return connectStandard(standard);
}

function money(raw: string | null, reason?: string): string {
  if (raw == null) return reason ?? "withheld";
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  if (!/^\d+$/.test(body)) return raw;
  const whole = BigInt(body) / 1_000_000_000n;
  const frac = (BigInt(body) % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole.toString();
  return `${neg ? "-" : "+"}${text} SOL`;
}

function short(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}
