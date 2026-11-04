import { useEffect, useState } from "react";
import { api, withToken } from "../api";
import { EMPTY_FEED, isFeedStale, reducePumpFrame, type FeedState } from "./curve";
import type { CurveState, TradeEvent } from "../../../src/pump/types";

export interface CurveFeed extends FeedState {
  stale: boolean;
  error: string | null;
}

/**
 * Live curve + trade tape for one mint.
 * A tick older than 5s raises `stale` (the terminal shows a badge).
 */
export function useCurveFeed(mint: string): CurveFeed {
  const [state, setState] = useState<FeedState>(EMPTY_FEED);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const trimmed = mint.trim();
    setState(EMPTY_FEED);
    setError(null);
    if (!trimmed) return;
    let stopped = false;
    const apply = (data: unknown) => {
      if (stopped) return;
      setState((prev) => reducePumpFrame(prev, data, Date.now()));
    };
    const pull = async () => {
      const [curve, trades] = await Promise.all([
        api<{ curve?: CurveState }>(`/api/pump/curve?mint=${encodeURIComponent(trimmed)}`),
        api<{ trades?: TradeEvent[] }>(`/api/pump/trades?mint=${encodeURIComponent(trimmed)}&limit=40`)
      ]);
      if (stopped) return;
      if (curve.ok && curve.body.curve) apply(curve.body.curve);
      if (trades.ok && trades.body.trades) {
        for (const trade of trades.body.trades) apply(trade);
      }
      if (!curve.ok && curve.status !== 404) setError(curve.body.error ?? "Curve request failed.");
    };
    void api("/api/pump/watch", { body: { mint: trimmed } });
    void pull();
    const poll = window.setInterval(() => void pull(), 4000);
    let ws: WebSocket | null = null;
    try {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}${withToken("/ws")}`);
      ws.onopen = () => {
        ws?.send(JSON.stringify({ op: "subscribe", topic: "pump.coin", mint: trimmed }));
      };
      ws.onmessage = (event) => {
        let msg: { type?: string; topic?: string; data?: unknown };
        try {
          msg = JSON.parse(String(event.data)) as typeof msg;
        } catch {
          return;
        }
        if (msg.type !== "pump" || !msg.topic) return;
        if (msg.topic !== `pump.coin:${trimmed}` && msg.topic !== "pump.trades") return;
        const data = msg.data;
        if (data && typeof data === "object" && "mint" in data && (data as { mint?: string }).mint !== trimmed) return;
        apply(data);
      };
    } catch {
      /* polling still runs */
    }
    return () => {
      stopped = true;
      window.clearInterval(poll);
      ws?.close();
    };
  }, [mint]);

  return { ...state, stale: isFeedStale(state.lastTickAt, now), error };
}
