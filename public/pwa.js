// Register the service worker and, on request, subscribe to web push.
(async () => {
  if ("serviceWorker" in navigator) { try { await navigator.serviceWorker.register("/sw.js"); } catch (_) {} }
  const btn = document.getElementById("push-sub");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      const { key } = await fetch("/push/public-key").then((r) => r.json());
      if (!key) { alert("Web push is not configured on this server yet (VAPID keys missing). The simulator at /dashboard/channels still shows every message."); return; }
      const reg = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
      const r = await fetch("/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) }).then((r) => r.json());
      btn.textContent = r.subscribed ? "enabled" : "failed";
    } catch (e) { alert("Push subscription failed: " + e.message); }
  });
})();
