// Kept service worker: offline shell for the manage and guard pages, push notifications.
const CACHE = "kept-v1";
const SHELL = ["/", "/static/app.css", "/static/icon.svg"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => null)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.startsWith("/static/")) e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { caches.open(CACHE).then((c) => c.put(e.request, res.clone())); return res; })));
  else if (u.pathname.startsWith("/manage") || u.pathname.startsWith("/dashboard")) e.respondWith(fetch(e.request).catch(() => caches.match("/")));
});
self.addEventListener("push", (e) => {
  let d = { title: "Kept", body: "", url: "/" };
  try { d = Object.assign(d, e.data.json()); } catch (_) { d.body = e.data ? e.data.text() : ""; }
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, data: { url: d.url }, icon: "/static/icon.svg", badge: "/static/icon.svg" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window" }).then((cs) => { for (const c of cs) if ("focus" in c) { c.navigate(e.notification.data.url); return c.focus(); } return clients.openWindow(e.notification.data.url); }));
});
