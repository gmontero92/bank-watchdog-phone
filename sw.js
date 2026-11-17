// Makes the app installable and quick to open. It keeps a copy of the page itself and of the Python
// engine (Pyodide, ~14 MB, downloaded once). It NEVER stores anything from GitHub: your data is fetched
// fresh every time and only lives in memory while the app is open.
const SHELL = "bw-shell-v3", ENGINE = "bw-pyodide-314.0.8";
const FILES = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== ENGINE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (u.pathname.includes("/pyodide@") || u.pathname.includes("/pyodide/")) {        // engine: cache first
    e.respondWith(caches.open(ENGINE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
  } else if (u.origin === self.location.origin) {                                   // the page: network first
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) caches.open(SHELL).then((c) => c.put(e.request, r.clone()));
      return r;
    }).catch(() => caches.match(e.request)));
  }                                                                                 // GitHub API: untouched
});
