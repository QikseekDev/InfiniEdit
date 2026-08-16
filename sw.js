/* InfiniEdit service worker — minimal app-shell cache so the app
   installs and keeps working offline. Everything InfiniEdit does
   (editing, analysis, graph view) runs client-side already; the only
   thing that needs the network is the optional live recipe lookup,
   which is left to fail naturally when offline rather than cached. */
const CACHE_NAME = "infiniedit-shell-v2";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/styles.css",
  "/script.js",
  "/manifest.webmanifest",
  "/favicon.png",
  "/android-chrome-192x192.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

/* Cache-first for the app shell, falling back to network. Anything not
   in the shell list (e.g. the InfiniBrowser recipe API) just goes to
   the network as normal and is not cached. */
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && SHELL_FILES.includes(url.pathname)) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
