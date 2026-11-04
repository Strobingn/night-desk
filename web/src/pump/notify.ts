/**
 * Browser alerts through the service worker.
 * `showNotification` runs in the worker, so it still fires when this tab is backgrounded.
 * Full-screen delivery also opens an in-page takeover while the tab is visible.
 */

export interface DeskNote {
  id: string;
  title?: string;
  message: string;
  delivery: "silent" | "sound" | "fullscreen";
  mint?: string;
}

export interface WebPushNote {
  title: string;
  options: {
    body: string;
    tag: string;
    silent: boolean;
    requireInteraction: boolean;
    renotify: boolean;
    data: { id: string; mint: string; delivery: DeskNote["delivery"]; fullscreen: boolean };
  };
}

export function toNotification(note: DeskNote): WebPushNote {
  const fullscreen = note.delivery === "fullscreen";
  return {
    title: note.title || "Night Desk",
    options: {
      body: note.message,
      tag: note.id,
      silent: note.delivery === "silent",
      requireInteraction: fullscreen,
      renotify: note.delivery !== "silent",
      data: { id: note.id, mint: note.mint || "", delivery: note.delivery, fullscreen }
    }
  };
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export async function enableBrowserAlerts(): Promise<"granted" | "denied" | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  await ensureServiceWorker();
  if (Notification.permission === "granted") return "granted";
  const result = await Notification.requestPermission();
  return result === "granted" ? "granted" : "denied";
}

/** Hands the alert to the worker. A backgrounded tab still gets the notification. */
export async function pushAlert(note: DeskNote): Promise<"shown" | "fullscreen" | "blocked"> {
  if (typeof Notification !== "undefined" && Notification.permission !== "granted") return "blocked";
  const payload = toNotification(note);
  const registration = await ensureServiceWorker();
  const worker = registration?.active ?? registration?.waiting ?? registration?.installing;
  if (worker) worker.postMessage({ type: "SHOW_ALERT", alert: payload });
  else if (registration) await registration.showNotification(payload.title, payload.options);
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  if (note.delivery === "fullscreen" && visible && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("desk-alert-fullscreen", { detail: note }));
    return "fullscreen";
  }
  return "shown";
}
