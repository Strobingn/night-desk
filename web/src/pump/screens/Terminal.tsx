import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { newIdemKey } from "../../onetap";
import type { Caps, CurveState, ReverseQuote, TradeIntent } from "../../../../src/pump/types";
import { CurveChart } from "../CurveChart";
import { formatSol, prefillForTarget, solToLamports } from "../curve";
import { useCurveFeed } from "../useCurveFeed";
import { approveIntent } from "../wallet/sign";
import { attachWalletStandard, browserHost, connectInjected, connectStandard, injectedChoices, type ConnectedWallet, type StandardWallet } from "../wallet/provider";

interface PumpStatusBody {
  armed?: boolean;
  caps?: Caps;
}

/**
 * Bonding-curve terminal. The buy button pre-fills SOL from the core reverse
 * quote, then prepares an unsigned transaction. Simulate mode never opens a wallet.
 */
export function Terminal() {
  const [mint, setMint] = useState("");
  const [active, setActive] = useState("");
  const feed = useCurveFeed(active);
  const [targetSol, setTargetSol] = useState("");
  const [solField, setSolField] = useState("");
  const [quote, setQuote] = useState<ReverseQuote | null>(null);
  const [armed, setArmed] = useState(false);
  const [cap, setCap] = useState("5000000");
  const [live, setLive] = useState(false);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [wallets, setWallets] = useState<StandardWallet[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [deskHold, setDeskHold] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const stop = attachWalletStandard(browserHost(), (found) => {
      setWallets((prev) => (prev.some((item) => item.name === found.name) ? prev : [...prev, found]));
    });
    return stop;
  }, []);

  useEffect(() => {
    void api<PumpStatusBody>("/api/pump/status").then((res) => {
      if (!res.ok) return;
      setArmed(Boolean(res.body.armed));
      if (res.body.caps?.tradeLamports) setCap(res.body.caps.tradeLamports);
    });
  }, []);

  const injected = useMemo(() => injectedChoices(browserHost()), [wallets]);
  const curve = feed.curve;

  async function connectNamed(kind: "injected" | "standard", index: number) {
    setNote(null);
    try {
      if (kind === "standard") {
        const found = wallets[index];
        if (!found) return;
        setWallet(await connectStandard(found));
      } else {
        const found = injected[index];
        if (!found) return;
        setWallet(await connectInjected(found.name, found.provider));
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Wallet connect failed.");
    }
  }

  function applyPrefill(next: CurveState, target: bigint): ReverseQuote {
    const reverse = prefillForTarget(next, target);
    setQuote(reverse);
    setSolField(formatSol(reverse.solNeededLamports));
    return reverse;
  }

  async function buy() {
    if (!curve) {
      setNote("No curve yet.");
      return;
    }
    const target = solToLamports(targetSol);
    if (target == null) {
      setNote("Target market cap is a SOL amount with at most 9 decimals.");
      return;
    }
    const reverse = applyPrefill(curve, target);
    const amount = BigInt(reverse.solNeededLamports);
    const past = reverse.reachable ? "" : "That target is past graduation. The field shows the SOL left on the curve. ";
    if (amount <= 0n) {
      setNote("The curve is already at that market cap.");
      return;
    }
    const payer = wallet?.address ?? "";
    if (!payer) {
      setNote(`${past}Pre-filled ${formatSol(amount)} SOL. Connect Phantom or Solflare to prepare the transaction.`);
      return;
    }
    setBusy(true);
    const prepared = await api<{ intent?: TradeIntent }>("/api/pump/prepare", {
      body: {
        wallet: payer,
        mint: curve.mint,
        side: "buy",
        solLamports: reverse.solNeededLamports,
        venue: "curve",
        live: live && armed
      }
    });
    setBusy(false);
    const intent = prepared.body.intent;
    if (!prepared.ok || !intent) {
      setNote(prepared.body.error ?? "Prepare failed.");
      return;
    }
    const approved = await approveIntent({
      unsignedTx: intent.unsignedTx,
      wallet: payer,
      amountLamports: BigInt(intent.solLamports),
      capLamports: BigInt(cap),
      simulateOnly: intent.simulateOnly || intent.mode === "simulate" || !live,
      opener: wallet
    });
    const sim = intent.simulation?.ok === false ? ` Simulation: ${intent.simulation.err ?? "failed"}.` : intent.simulation ? " Simulation ok." : "";
    setNote(`${past}${approved.message}${sim}`);
  }

  /** Desk manual live buy for the watched mint. The curve prepare button above is unchanged. */
  async function deskLiveBuy(confirm: boolean) {
    const watched = curve?.mint;
    if (!watched) return;
    setBusy(true);
    const res = await api<{ ok?: boolean; error?: string; code?: string; warning?: string; symbol?: string; sizeUsd?: number; mode?: string }>(
      "/api/positions/buy",
      {
        body: {
          mint: watched,
          book: "live",
          idemKey: newIdemKey(),
          oneTap: true,
          ...(confirm ? { confirmHardKill: true, ignoreCooldown: true } : {})
        }
      }
    );
    setBusy(false);
    if (!res.ok && res.body.code === "HARD_KILL" && !confirm) {
      setDeskHold(res.body.error ?? "Hard kill.");
      setNote(res.body.error ?? "Hard kill. Tap Buy anyway to buy it with real money.");
      return;
    }
    setDeskHold(null);
    const err = res.body.error ? `${res.body.error}${res.body.code ? ` (${res.body.code})` : ""}` : "Desk live buy failed.";
    setNote(res.ok ? `Desk live buy filled${res.body.warning ? `. ${res.body.warning}` : "."}` : err);
  }

  return (
    <section className="card terminal" aria-label="Bonding curve terminal">
      <header>
        <h3>Bonding curve</h3>
        {feed.stale ? <span className="stale-badge">Stale</span> : <span className="dim">{feed.lastTickAt ? "Live" : "Waiting"}</span>}
      </header>
      <p className="fine">Simulate-only until this process is armed. The wallet signs. Night Desk does not broadcast or retry.</p>
      <form
        className="term-mint"
        onSubmit={(event) => {
          event.preventDefault();
          setActive(mint.trim());
        }}
      >
        <input value={mint} onChange={(event) => setMint(event.target.value)} placeholder="Mint" aria-label="Mint" spellCheck={false} />
        <button className="primary sm" type="submit">
          Watch
        </button>
      </form>
      <div className="term-grid">
        <Stat label="Market cap" value={solText(curve?.quoteIsSol, curve?.marketCapLamports, " SOL")} />
        <Stat label="Progress" value={curve?.progressPct != null ? `${curve.progressPct.toFixed(2)}%` : "—"} />
        <Stat label="SOL in curve" value={curve?.quoteIsSol === false || curve?.solInCurveLamports == null ? "—" : formatSol(curve.solInCurveLamports)} />
        <Stat label="SOL to graduate" value={solText(curve?.quoteIsSol, curve?.solRemainingLamports)} />
        <Stat label="Graduation mcap" value={solText(curve?.quoteIsSol, curve?.graduationMarketCapLamports, " SOL")} />
        <Stat label="Wallet" value={wallet ? short(wallet.address) : "Not connected"} />
      </div>
      <CurveChart points={feed.ticks} />
      {curve && curve.quoteIsSol === false ? <p className="fine">Quote mint is not SOL. SOL figures stay blank.</p> : null}
      {curve && curve.quoteIsSol !== false && curve.solInCurveLamports == null && curve.realQuoteReserves !== "0" ? (
        <p className="fine">Real quote is {curve.realQuoteReserves} raw and is not SOL deposited. The price uses virtual reserves.</p>
      ) : null}
      <ul className="tape" aria-label="Buy and sell tape">
        {feed.tape.length === 0 ? <li className="dim">No prints on the free stream.</li> : null}
        {feed.tape.map((row) => (
          <li key={row.id}>
            <span className={row.isBuy ? "up" : "down"}>{row.isBuy ? "Buy" : "Sell"}</span>
            <span>{formatSol(row.solAmountLamports)} SOL</span>
            <span className="dim">{short(row.user)}</span>
          </li>
        ))}
      </ul>
      {feed.tapeNote ? <p className="fine">{feed.tapeNote}</p> : null}
      <div className="term-buy">
        <label>
          Target mcap (SOL)
          <input value={targetSol} onChange={(event) => setTargetSol(event.target.value)} inputMode="decimal" aria-label="Target market cap" />
        </label>
        <label>
          SOL into curve
          <input value={solField} onChange={(event) => setSolField(event.target.value)} inputMode="decimal" aria-label="SOL amount" />
        </label>
        <button className="primary" type="button" disabled={busy || !curve} onClick={() => void buy()}>
          {busy ? "Preparing…" : "Buy into curve"}
        </button>
        <button
          className="ghost"
          type="button"
          disabled={busy || !curve}
          onClick={() => void deskLiveBuy(false)}
        >
          Desk LIVE BUY
        </button>
        {deskHold ? (
          <button className="ghost" type="button" disabled={busy} onClick={() => void deskLiveBuy(true)}>
            Buy anyway
          </button>
        ) : null}
        <label className="term-live">
          <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
          Live {armed ? "(session armed)" : "(session is simulate-only)"}
        </label>
      </div>
      {quote && !quote.reachable ? <p className="fine">Target sits past graduation. Pre-fill is the remaining curve quote.</p> : null}
      <div className="term-wallets">
        {injected.map((item, index) => (
          <button key={item.name} className="ghost sm" type="button" onClick={() => void connectNamed("injected", index)}>
            Connect {item.name}
          </button>
        ))}
        {wallets.map((item, index) => (
          <button key={item.name} className="ghost sm" type="button" onClick={() => void connectNamed("standard", index)}>
            Connect {item.name}
          </button>
        ))}
        {injected.length === 0 && wallets.length === 0 ? <span className="dim">No Phantom or Solflare detected.</span> : null}
      </div>
      {feed.error ? <p className="warn">{feed.error}</p> : null}
      {note ? <p className="fine">{note}</p> : null}
    </section>
  );
}

function solText(quoteIsSol: boolean | undefined, lamports: string | null | undefined, suffix = ""): string {
  if (quoteIsSol === false || lamports == null) return "—";
  return `${formatSol(lamports)}${suffix}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="term-stat">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function short(value: string): string {
  if (value.length < 12) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
