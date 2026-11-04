import { useEffect, useState } from "react";
import { api, withToken } from "../api";
import { enableBrowserAlerts, pushAlert, type DeskNote } from "../pump/notify";
import { applyNight, readNight, saveNight, type NightWindow } from "../pump/night";

interface Rule {
  id: string;
  kind: string;
  mint: string;
  threshold: number;
  hysteresis: number;
  cooldownMs: number;
  delivery: "silent" | "sound" | "fullscreen";
  enabled: boolean;
}

interface Fired {
  id: string;
  message: string;
  delivery?: string;
  at?: number;
}

const KINDS = ["price", "mcap", "curve", "large_buy", "holders", "graduation", "whale_sell"] as const;

/** 24/7 desk alerts: rules, delivery, and the night-mode schedule. */
export function Alerts() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [night, setNight] = useState<NightWindow>(() => readNight());
  const [active, setActive] = useState(false);
  const [perm, setPerm] = useState("default");
  const [takeover, setTakeover] = useState<DeskNote | null>(null);
  const [log, setLog] = useState<Fired[]>([]);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("curve");
  const [threshold, setThreshold] = useState("50");
  const [delivery, setDelivery] = useState<Rule["delivery"]>("sound");

  useEffect(() => {
    const stop = window.setInterval(() => setActive(applyNight(night)), 30_000);
    setActive(applyNight(night));
    return () => window.clearInterval(stop);
  }, [night]);

  useEffect(() => {
    void api<{ rules: Rule[] }>("/api/pump/alert-rules").then((res) => {
      if (res.body.rules) setRules(res.body.rules);
    });
    const onFull = (event: Event) => setTakeover((event as CustomEvent<DeskNote>).detail);
    window.addEventListener("desk-alert-fullscreen", onFull);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${proto}://${location.host}${withToken("/ws")}`);
      ws.onopen = () => ws?.send(JSON.stringify({ op: "subscribe", topic: "pump.alerts" }));
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as { type?: string; topic?: string; data?: { id?: string; message?: string; data?: { delivery?: Rule["delivery"]; desk?: boolean } } };
        if (msg.type !== "pump" || msg.topic !== "pump.alerts" || !msg.data?.data?.desk) return;
        const deliveryMode = msg.data.data.delivery ?? "sound";
        const note: DeskNote = { id: msg.data.id || String(Date.now()), message: msg.data.message || "Desk alert", delivery: deliveryMode };
        setLog((prev) => [note, ...prev].slice(0, 20));
        void pushAlert(note);
      };
    } catch {
      ws = null;
    }
    return () => {
      window.removeEventListener("desk-alert-fullscreen", onFull);
      ws?.close();
    };
  }, []);

  async function saveRules(next: Rule[]) {
    setRules(next);
    await api("/api/pump/alert-rules", { body: { rules: next } });
  }

  function addRule() {
    const value = Number(threshold);
    if (!Number.isFinite(value)) return;
    const next: Rule = {
      id: `${kind}-${value}-${Date.now()}`,
      kind,
      mint: "",
      threshold: value,
      hysteresis: kind === "curve" ? 5 : Math.max(1, Math.round(value * 0.1)),
      cooldownMs: 60_000,
      delivery,
      enabled: true
    };
    void saveRules([...rules, next]);
  }

  function saveSchedule(next: NightWindow) {
    setNight(next);
    saveNight(next);
    setActive(applyNight(next));
    void api("/api/pump/night", { body: { night: next } });
  }

  return (
    <section className="card" aria-label="Desk alerts">
      <h2>Desk alerts</h2>
      <p className="dim">Price, mcap milestones, curve, large buys, new holders, graduation, and whale sells. Each rule fires once per crossing, then waits for the hysteresis band.</p>
      <p className="dim">{active ? "Night mode is on: dark theme, brightness reduced." : "Night mode is off."} Notifications use the service worker, including while this tab is in the background.</p>
      <div className="settings-actions">
        <button type="button" className="primary sm" onClick={() => void enableBrowserAlerts().then(setPerm)}>
          Allow notifications ({perm})
        </button>
      </div>
      <div className="slider-row">
        <div className="slider-head">
          <b>Night mode</b>
        </div>
        <label className="toggle-row">
          <span>Schedule</span>
          <input type="checkbox" checked={night.enabled} onChange={(event) => saveSchedule({ ...night, enabled: event.target.checked })} />
        </label>
        <label className="dim">
          From <input className="num-input" type="time" value={minToTime(night.startMin)} onChange={(event) => saveSchedule({ ...night, startMin: timeToMin(event.target.value) })} />
        </label>
        <label className="dim">
          Until <input className="num-input" type="time" value={minToTime(night.endMin)} onChange={(event) => saveSchedule({ ...night, endMin: timeToMin(event.target.value) })} />
        </label>
        <label className="dim">
          Brightness {night.brightness.toFixed(2)}
          <input type="range" min={0.2} max={1} step={0.05} value={night.brightness} onChange={(event) => saveSchedule({ ...night, brightness: Number(event.target.value) })} />
        </label>
      </div>
      <ul className="desk-rows">
        {rules.map((rule) => (
          <li key={rule.id}>
            <strong>{rule.kind}</strong>
            <em>
              {rule.threshold} · {rule.delivery} · hyst {rule.hysteresis}
            </em>
            <button type="button" className="ghost sm" onClick={() => void saveRules(rules.filter((item) => item.id !== rule.id))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="lookup-form">
        <select className="select" value={kind} onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}>
          {KINDS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <input className="num-input" value={threshold} onChange={(event) => setThreshold(event.target.value)} aria-label="Threshold" />
        <select className="select" value={delivery} onChange={(event) => setDelivery(event.target.value as Rule["delivery"])}>
          <option value="silent">silent</option>
          <option value="sound">sound</option>
          <option value="fullscreen">full-screen</option>
        </select>
        <button type="button" className="primary sm" onClick={addRule}>
          Add rule
        </button>
      </div>
      <ul className="checks">
        {log.map((item) => (
          <li key={item.id}>{item.message}</li>
        ))}
      </ul>
      {takeover ? (
        <div className="alert-takeover" role="alertdialog" aria-label="Full screen alert">
          <div>
            <h2>{takeover.message}</h2>
            <button type="button" className="primary" onClick={() => setTakeover(null)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function minToTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMin(value: string): number {
  const [h, m] = value.split(":").map((part) => Number(part));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}
