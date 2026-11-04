import { useEffect, useState } from "react";
import { api } from "../../api";

interface SniperJob {
  mint: string;
  phase: string;
  progressPct: number;
  poolClass: string | null;
  reason: string | null;
  buyArmed: boolean;
  simulateOnly: boolean | null;
  solLamports: string;
  slippageBps: number;
  priorityFeeMicroLamports: number;
  minVolumeLamports: string | null;
  volumeLamports: string;
  unsignedTx: string | null;
}

interface MigrationView {
  venue: string;
  poolClass: string;
  canonical: boolean;
  lpSupply: string;
  lpBurnedPct: number;
  locked: boolean;
  stillLocked: boolean | null;
  owners: Array<{ owner: string; pct: number; label: string; amount: string }>;
  lockers: Array<{ name: string; amount: string }>;
  quoteLamports: string;
}

const PHASES = ["watching", "ready", "sent", "filled", "expired", "failed"];

/** Graduation sniper controls and the migration / LP card. The worker keeps running if this tab closes. */
export function GraduationScreen() {
  const [mint, setMint] = useState("");
  const [wallet, setWallet] = useState("");
  const [slippageBps, setSlippage] = useState("100");
  const [priority, setPriority] = useState("0");
  const [minVolume, setMinVolume] = useState("");
  const [buyArmed, setBuyArmed] = useState(false);
  const [job, setJob] = useState<SniperJob | null>(null);
  const [migration, setMigration] = useState<MigrationView | null>(null);
  const [note, setNote] = useState("Simulate-only until this process is armed. The wallet signs. One shot, no resubmit.");

  useEffect(() => {
    if (!mint.trim()) return;
    let gone = false;
    const pull = () => {
      void api<{ jobs?: SniperJob[] }>("/api/pump/sniper").then((res) => {
        if (gone) return;
        const found = res.body.jobs?.find((row) => row.mint === mint.trim()) ?? null;
        if (found) setJob(found);
      });
      void api<{ migration?: MigrationView }>(`/api/pump/migration?mint=${encodeURIComponent(mint.trim())}`).then((res) => {
        if (!gone && res.body.migration) setMigration(res.body.migration);
      });
    };
    pull();
    const timer = window.setInterval(pull, 2000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [mint]);

  async function watch() {
    const res = await api<{ job?: SniperJob }>("/api/pump/sniper/watch", {
      method: "POST",
      body: {
        mint: mint.trim(),
        wallet: wallet.trim(),
        slippageBps: Number(slippageBps),
        priorityFeeMicroLamports: Number(priority),
        minVolumeLamports: minVolume.trim() ? solToLamports(minVolume.trim()) : undefined,
        buyArmed
      }
    });
    setNote(res.body.error ?? (res.body.job ? `Watching. Phase ${res.body.job.phase}.` : "Watch saved."));
    if (res.body.job) setJob(res.body.job);
  }

  async function toggle() {
    const next = !buyArmed;
    setBuyArmed(next);
    const res = await api<{ jobs?: SniperJob[] }>("/api/pump/sniper/toggle", { method: "POST", body: { armed: next } });
    setNote(res.body.error ?? (next ? "Buy armed. Still simulate-only until the session is armed." : "Buy toggle off."));
    const found = res.body.jobs?.find((row) => row.mint === mint.trim());
    if (found) setJob(found);
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3>Graduation</h3>
      <p className="dim">{note}</p>
      <label className="dim">
        Mint
        <input value={mint} onChange={(event) => setMint(event.target.value)} placeholder="token mint" style={{ width: "100%", margin: "4px 0 8px" }} />
      </label>
      <label className="dim">
        Wallet (signs, never stored as a key)
        <input value={wallet} onChange={(event) => setWallet(event.target.value)} placeholder="fee payer" style={{ width: "100%", margin: "4px 0 8px" }} />
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label className="dim">
          Slippage bps
          <input value={slippageBps} onChange={(event) => setSlippage(event.target.value)} inputMode="numeric" style={{ width: 100, marginLeft: 6 }} />
        </label>
        <label className="dim">
          Priority fee µ-lamports
          <input value={priority} onChange={(event) => setPriority(event.target.value)} inputMode="numeric" style={{ width: 120, marginLeft: 6 }} />
        </label>
        <label className="dim">
          Min volume SOL / 60s
          <input value={minVolume} onChange={(event) => setMinVolume(event.target.value)} placeholder="off" style={{ width: 80, marginLeft: 6 }} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="button" onClick={() => void watch()}>
          Watch curve
        </button>
        <button type="button" onClick={() => void toggle()} className={buyArmed ? "on" : ""}>
          {buyArmed ? "Buy armed" : "Arm market buy"}
        </button>
      </div>
      {job ? (
        <p>
          Phase <strong>{job.phase}</strong>
          {job.poolClass === "non-canonical" ? " · non-canonical, not sniped" : ""}
          {job.simulateOnly ? " · simulate-only" : ""}
          {job.reason ? ` · ${job.reason}` : ""}
        </p>
      ) : null}
      <p className="dim">Phases: {PHASES.join(" → ")}. A sent buy is not rebuilt.</p>
      <MigrationSummary view={migration} />
    </div>
  );
}

export function MigrationSummary({ view }: { view: MigrationView | null }) {
  if (!view) return <p className="dim">After graduation the coin view follows its PumpSwap or Raydium pool. LP burn, ownership, and lockers show up here.</p>;
  const locked = view.stillLocked == null ? (view.locked ? "locked" : "unlocked") : view.stillLocked ? "still locked" : "lock dropped";
  return (
    <div>
      <p>
        {view.venue} · {view.canonical ? "canonical" : "non-canonical"} · LP {view.lpSupply} · burned {view.lpBurnedPct}% · {locked}
      </p>
      {view.owners.length ? (
        <ul className="scout-status">
          {view.owners.map((owner) => (
            <li key={owner.owner}>
              <strong>{owner.label}</strong>
              <em>
                {owner.pct}% · {owner.amount}
              </em>
            </li>
          ))}
        </ul>
      ) : null}
      {view.lockers.length ? <p className="dim">{view.lockers.map((locker) => `${locker.name} ${locker.amount}`).join(" · ")}</p> : null}
    </div>
  );
}

function solToLamports(sol: string): string | undefined {
  if (!/^\d+(\.\d{1,9})?$/.test(sol)) return undefined;
  const [whole, frac = ""] = sol.split(".");
  return (BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"))).toString();
}
