import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { usd } from "../format";
import { SETTINGS_FIELDS, SETTING_GROUPS, changedPatch, draftFrom, type Draft, type SettingField, type SliderField } from "../settingsSchema";
import type { DeskSnapshot } from "../types";
import type { DeskActions } from "../App";
import { Icon } from "../ui";
import { THEME_OPTIONS } from "../theme";
import { WalletCard } from "./Wallet";

const GROUP_META: Record<string, { icon: string; text: string }> = {
  "Live wallet": { icon: "shield", text: "Real-money settings. Used only when the desk host runs with LIVE_TRADING=true." },
  "Sizing / risk": { icon: "shield", text: "How much each buy uses, and the brakes on the whole book." },
  "Filter / Analyst gates": { icon: "filter", text: "What a new pair must clear before the Analyst scores it." },
  "Exits / stops": { icon: "exit", text: "The hard stop, the cooldown after it, and the optional trailing take profit." },
  "Scout sources": { icon: "radar", text: "Where new pairs come from. Pump is always on." },
  Alerts: { icon: "bell", text: "What the phone pings you about." }
};

export function SettingsScreen({ snap, actions }: { snap: DeskSnapshot; actions: DeskActions }) {
  const stateLike = snap as unknown as { rules: Record<string, unknown>; prefs: Record<string, unknown> };
  const saved = useMemo(() => draftFrom(stateLike), [JSON.stringify(snap.rules), JSON.stringify(snap.prefs)]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);

  const patch = changedPatch(saved, draft);
  const changed = Object.keys(patch);

  function set(key: string, value: number | boolean | null) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  async function save() {
    if (!changed.length) {
      setDirty(false);
      return;
    }
    setSaving(true);
    setError(null);
    const res = await api("/api/settings", { body: patch });
    setSaving(false);
    if (!res.ok) {
      setError(res.body.error ?? `Save failed (HTTP ${res.status})`);
      return;
    }
    setDirty(false);
    actions.notify({ ok: true, text: `Saved ${changed.length} setting${changed.length === 1 ? "" : "s"}.` });
  }

  return (
    <form
      className="settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="settings-bar">
        <div>
          <h2>Settings</h2>
          <p className="fine">
            {snap.mode === "live" ? "LIVE" : "Paper mode"} · LIVE_TRADING stays off from here. Only changed fields are sent.
          </p>
        </div>
        <div className="settings-actions">
          {dirty && changed.length ? <span className="unsaved">Unsaved changes ({changed.length})</span> : null}
          <button className="ghost" type="button" disabled={!dirty} onClick={() => { setDraft(saved); setDirty(false); setError(null); }}>
            Reset
          </button>
          <button className="primary" type="submit" disabled={saving || !changed.length}>
            {saving ? "Saving" : "Apply"}
          </button>
        </div>
      </div>
      {error ? <div className="banner">{error}</div> : null}
      <section className="card setting-group appearance" aria-label="Appearance">
        <header className="group-head">
          <span className="group-icon">
            <Icon name="palette" size={20} />
          </span>
          <div>
            <h3>Appearance</h3>
            <p>Theme for this device only. It is not a desk setting and is never sent to the desk.</p>
          </div>
        </header>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={actions.theme === opt.id}
              className={actions.theme === opt.id ? "on" : ""}
              onClick={() => actions.setTheme(opt.id)}
            >
              <Icon name={opt.id === "dark" ? "moon" : opt.id === "light" ? "sun" : "auto"} size={16} /> {opt.label}
            </button>
          ))}
        </div>
        <small className="fine">System follows the phone or computer setting.</small>
      </section>
      <details className="card">
        <summary>Crash log</summary>
        <pre className="fine">{snap.lastClientCrash?.text || snap.lastClientCrash?.brief || "No crash recorded."}</pre>
      </details>
      {SETTING_GROUPS.map((group) => (
        <section className={`card setting-group${group === "Live wallet" ? " live-group" : ""}`} key={group}>
          <header className="group-head">
            <span className="group-icon">
              <Icon name={GROUP_META[group]?.icon ?? "settings"} size={20} />
            </span>
            <div>
              <h3>{group}</h3>
              <p>{GROUP_META[group]?.text}</p>
            </div>
          </header>
          {group === "Live wallet" ? (
            <>
              <WalletCard snap={snap} />
              <p className="fine">
                AI auto-buys stay on the paper book. The server refuses a request to send them live. Your live buys, sells, limits and stops are separate. Live size stays $5 and the saved live daily cap is kept. Paper position size and the paper cap are a different book: a saved cap (including 29.5%) and a blank paper dollar size are not rewritten. These limits are not a tested profit system. Turning live on does not place a trade, and the paper cash ledger is left as it is.
              </p>
            </>
          ) : null}
          {group === "Sizing / risk" ? (
            <p className="fine">
              Cap now {usd(snap.positionCapUsd)} per auto buy · manual max {usd(snap.manualMaxUsd ?? 0)} with confirm · exposure {usd(snap.exposureUsd ?? 0)}. Slippage, pool depth, cash and the hard stop still apply to every size.
            </p>
          ) : null}
          {SETTINGS_FIELDS.filter((field) => field.group === group).map((field) => (
            <Field key={field.key} field={field} value={draft[field.key]} savedValue={saved[field.key]} onChange={(v) => set(field.key, v)} />
          ))}
          {group === "Exits / stops" ? (
            <p className="hard-stop">
              Hard stop −{(snap.rules.stopLossPct * 100).toFixed(0)}% from the fill. It stays fixed. Entry slippage cap {((snap.rules.maxEntrySlippage ?? 0.03) * 100).toFixed(2)}%. A quote above that cap is refused. A stop cannot prevent a gap: when price jumps past it between marks, the exit fills at the real price and is labelled gap/rug. Mint authority and dev rugs stay hard kills.
            </p>
          ) : null}
        </section>
      ))}
      <div className="settings-foot">
        <button className="primary" type="submit" disabled={saving || !changed.length}>
          {saving ? "Saving" : changed.length ? `Apply ${changed.length} change${changed.length === 1 ? "" : "s"}` : "Apply"}
        </button>
      </div>
    </form>
  );
}

function Field({ field, value, savedValue, onChange }: { field: SettingField; value: number | boolean | null | undefined; savedValue: unknown; onChange: (v: number | boolean | null) => void }) {
  const edited = value !== savedValue;
  if (field.kind === "toggle") {
    return (
      <label className={`toggle-row${edited ? " edited" : ""}`}>
        <span>
          <b>{field.label}</b>
          {field.hint ? <small>{field.hint}</small> : null}
        </span>
        <input type="checkbox" role="switch" aria-label={field.label} checked={value === true} disabled={field.locked} onChange={(event) => onChange(event.target.checked)} />
      </label>
    );
  }
  return <SliderRow field={field} value={typeof value === "number" ? value : null} edited={edited} onChange={onChange} />;
}

function SliderRow({ field, value, edited, onChange }: { field: SliderField; value: number | null; edited: boolean; onChange: (v: number | null) => void }) {
  const off = value == null;
  const shown = off ? field.min : value;
  const outOfBand = !off && (value < field.min || value > field.max);
  const fill = ((Math.min(field.max, Math.max(field.min, shown)) - field.min) / (field.max - field.min || 1)) * 100;
  return (
    <div className={`slider-row${edited ? " edited" : ""}${off ? " off" : ""}`}>
      <div className="slider-head">
        <b>{field.label}</b>
        <span className="val">{off ? "—" : fmt(field, value)}</span>
      </div>
      {field.nullable ? (
        <label className="null-toggle">
          <input type="checkbox" checked={off} onChange={(event) => onChange(event.target.checked ? null : field.nullDefault ?? (field.min > 10 ? field.min : 25))} />
          {field.nullable}
        </label>
      ) : null}
      <div className="slider-line">
        <input
          type="range"
          style={{ ["--fill" as string]: `${fill}%` }}
          aria-label={field.label}
          min={field.min}
          max={field.max}
          step={field.step}
          value={Math.min(field.max, Math.max(field.min, shown))}
          disabled={off}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <input
          className="num"
          aria-label={`${field.label} value`}
          inputMode="decimal"
          disabled={off}
          value={off ? "" : String(value)}
          onChange={(event) => {
            const n = Number(event.target.value);
            if (event.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
          }}
        />
      </div>
      {field.hint ? <small>{field.hint}</small> : null}
      {outOfBand ? <small className="warn">Outside {fmt(field, field.min)}–{fmt(field, field.max)}. The desk will refuse or clamp it.</small> : null}
    </div>
  );
}

function fmt(field: SliderField, n: number): string {
  switch (field.unit) {
    case "$":
      return usd(n, n >= 1000 ? 0 : 2);
    case "%":
      return `${n}%`;
    case "min":
      return `${n} min`;
    case "h":
      return `${n} h`;
    case "s":
      return `${n} s`;
    case "SOL":
      return `${n} SOL`;
    case "score":
      return n.toFixed(2);
    default:
      return String(n);
  }
}
