// Install-only service worker: nothing is cached, so the console never shows stale orders or quotes.
// Page loads go to the network; when that fails, a short offline notice is shown instead.
const OFFLINE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>QMT Bridge</title>
<style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;background:#f2f2f7;color:#1c1c1e;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
button{margin-top:16px;padding:10px 22px;border:0;border-radius:999px;background:#007aff;color:#fff;font-size:15px}</style>
</head><body><div><h2>网络不可用</h2><p>QMT Bridge 需要联网才能显示挂单和行情。</p>
<button onclick="location.reload()">重试</button></div></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } })
    )
  );
});
