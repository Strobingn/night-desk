import { useEffect, useState } from "react";
import { api } from "../api";
import { Alerts } from "../screens/Alerts";
import { Scanner } from "../screens/Scanner";
import { PUMP_FEATURES } from "./registry";

interface PumpStatus {
  ok?: boolean;
  armed?: boolean;
  mode?: string;
  caps?: { tradeLamports?: string; dayLamports?: string; dayUsedLamports?: string };
}

/** One Pump tab. What it shows comes from the registry, so other chunks only append there. */
export function PumpScreen() {
  const [status, setStatus] = useState<PumpStatus | null>(null);
  const [tab, setTab] = useState(PUMP_FEATURES[0]?.id ?? "core");
  useEffect(() => {
    let gone = false;
    void api<PumpStatus>("/api/pump/status").then((res) => {
      if (!gone) setStatus(res.body);
    });
    return () => {
      gone = true;
    };
  }, []);
  const caps = status?.caps;
  return (
    <section className="card" aria-label="Pump">
      <h2>Pump</h2>
      <p className="dim">
        {status?.armed ? "This process is armed. The wallet still signs." : "Simulate-only. Arming is per process and a restart clears it."}
      </p>
      {caps ? (
        <p className="dim">
          Caps {lamports(caps.tradeLamports)} SOL / trade, {lamports(caps.dayLamports)} SOL / day. Used today {lamports(caps.dayUsedLamports)} SOL.
        </p>
      ) : null}
      <div className="chips">
        {PUMP_FEATURES.map((feature) => (
          <button key={feature.id} type="button" className={tab === feature.id ? "primary sm" : "ghost sm"} onClick={() => setTab(feature.id)}>
            {feature.label}
          </button>
        ))}
      </div>
      {tab === "alerts" ? <Alerts /> : null}
      {tab === "scanner" ? <Scanner /> : null}
    </section>
  );
}

function lamports(raw: string | undefined): string {
  if (!raw) return "0";
  const n = Number(raw) / 1_000_000_000;
  if (!Number.isFinite(n)) return raw;
  return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
