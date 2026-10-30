import { useEffect, useState } from "react";
import { api } from "../api";

const RECAP_WINDOWS = ["12h", "24h", "7d", "reset"] as const;
const RECAP_LABELS: Record<(typeof RECAP_WINDOWS)[number], string> = { "12h": "12h", "24h": "24h", "7d": "7d", reset: "Since reset" };

export function RecapScreen() {
  const [recapWindow, setRecapWindow] = useState<(typeof RECAP_WINDOWS)[number]>("12h");
  const [recap, setRecap] = useState<string | null>(null);
  const [recapError, setRecapError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadRecap(window: (typeof RECAP_WINDOWS)[number]) {
    setRecapError(null);
    setLoading(true);
    const res = await api<{ text?: string }>(`/api/recap?since=${window}`);
    setLoading(false);
    if (!res.ok) {
      setRecapError(`${res.body.error ?? "Recap failed"} (HTTP ${res.status})`);
      return;
    }
    setRecap(res.body.text ?? "No recap text.");
  }

  useEffect(() => {
    void loadRecap("12h");
  }, []);

  return (
    <div className="recap-screen">
      <div className="tape-head">
        <h2>Recap</h2>
        <button className="ghost" type="button" disabled={loading} onClick={() => void loadRecap(recapWindow)}>
          {loading ? "Loading" : recap ? "Refresh recap" : "Recap"}
        </button>
      </div>
      <div className="filters recap-windows" role="group" aria-label="Recap window">
        {RECAP_WINDOWS.map((window) => (
          <button
            key={window}
            type="button"
            className={recapWindow === window ? "on" : ""}
            onClick={() => {
              setRecapWindow(window);
              void loadRecap(window);
            }}
          >
            {RECAP_LABELS[window]}
          </button>
        ))}
      </div>
      {recapError ? <div className="banner">{recapError}</div> : null}
      {recap ? <pre className="recap">{recap}</pre> : <p className="empty">Pick a window. The recap reads the desk log and the book; it never trades.</p>}
    </div>
  );
}
