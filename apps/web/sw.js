// App shell only: map packages are explicitly saved and reopened by the user.
const CACHE = "atlas-shell-v16";
const SHELL = [
  "/",
  "/styles.css",
  "/main.js",
  "/offline-worker.js",
  "/routing-worker.js",
  "/wasm/atlas_renderer_bg.wasm",
];
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("atlas-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== location.origin ||
    !SHELL.includes(url.pathname)
  )
    return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches
        .match(url.pathname)
        .then((response) => response || Response.error()),
    ),
  );
});
