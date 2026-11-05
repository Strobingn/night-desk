/**
 * Browser notification body. The service worker shows it, so a backgrounded
 * tab still alerts. `silent` is the silent delivery mode. Full-screen asks
 * the page for a takeover and keeps the notification on screen.
 */
import type { DeskAlert } from "./engine.js";

export interface WebPushNote {
  title: string;
  options: {
    body: string;
    tag: string;
    silent: boolean;
    requireInteraction: boolean;
    renotify: boolean;
    data: { id: string; kind: string; mint: string; delivery: DeskAlert["delivery"]; fullscreen: boolean };
  };
}

export function webPushPayload(alert: DeskAlert): WebPushNote {
  const fullscreen = alert.delivery === "fullscreen";
  return {
    title: "Night Desk",
    options: {
      body: alert.message,
      tag: alert.id,
      silent: alert.delivery === "silent",
      requireInteraction: fullscreen,
      renotify: alert.delivery !== "silent",
      data: { id: alert.id, kind: alert.kind, mint: alert.mint, delivery: alert.delivery, fullscreen }
    }
  };
}
