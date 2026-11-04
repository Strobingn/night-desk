/**
 * FCM HTTP payload for a desk alert.
 * Delivery needs `FCM_SERVER_KEY` and a device token. Without them the call
 * reports `local-only` and the phone evaluates rules itself.
 * Data-only: a `notification` block is drawn by the system tray and never
 * reaches FcmService after the app is swiped away. The phone posts the alert.
 */
import type { DeskAlert } from "./engine.js";

export interface FcmPayload {
  to: string;
  priority: "normal" | "high";
  data: {
    id: string;
    kind: string;
    mint: string;
    delivery: string;
    fullscreen: "0" | "1";
    value: string;
    threshold: string;
    title: string;
    body: string;
  };
}

export function fcmPayload(alert: DeskAlert, token: string): FcmPayload {
  const silent = alert.delivery === "silent";
  return {
    to: token,
    priority: silent ? "normal" : "high",
    data: {
      id: alert.id,
      kind: alert.kind,
      mint: alert.mint,
      delivery: alert.delivery,
      fullscreen: alert.delivery === "fullscreen" ? "1" : "0",
      value: String(alert.value),
      threshold: String(alert.threshold),
      title: "Night Desk",
      body: alert.message
    }
  };
}

export async function sendFcm(
  alert: DeskAlert,
  opts: { token?: string | null; serverKey?: string | null; fetchImpl?: typeof fetch }
): Promise<{ delivered: boolean; reason: string }> {
  const token = opts.token?.trim() ?? "";
  const serverKey = opts.serverKey?.trim() ?? "";
  if (!token || !serverKey) return { delivered: false, reason: "local-only" };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const payload = fcmPayload(alert, token);
  const res = await fetchImpl("https://fcm.googleapis.com/fcm/send", {
    method: "POST",
    headers: { authorization: `key=${serverKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return { delivered: false, reason: `HTTP ${res.status}` };
  return { delivered: true, reason: "sent" };
}
