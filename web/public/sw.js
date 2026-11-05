/* Night Desk alerts. Showing from the worker is what reaches a backgrounded tab. */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "SHOW_ALERT" || !data.alert) return;
  const note = data.alert;
  event.waitUntil(self.registration.showNotification(note.title || "Night Desk", note.options || {}));
});

self.addEventListener("push", (event) => {
  let note = { title: "Night Desk", options: { body: "Desk alert" } };
  try {
    if (event.data) note = event.data.json();
  } catch {
    /* keep the fallback copy */
  }
  event.waitUntil(self.registration.showNotification(note.title || "Night Desk", note.options || {}));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.fullscreen ? "/?alert=1" : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
