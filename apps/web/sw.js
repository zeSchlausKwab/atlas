// App shell only: map packages are explicitly saved and reopened by the user.
const CACHE = "atlas-shell-v18";
let generation = 0;
let paused = false;
const writes = new Set();
self.addEventListener("message", (event) => {
  if (event.data === "restore-atlas-shell") {
    const epoch = generation;
    const restore = (async () => {
      if (paused) throw new Error("App cache is paused after purge");
      const cache = await caches.open(CACHE);
      await Promise.all(
        SHELL.map(async (path) => {
          if (await cache.match(path)) return;
          const response = await fetch(path, { cache: "no-store" });
          if (!response.ok) throw new Error(`Could not cache ${path}`);
          if (paused || epoch !== generation)
            throw new Error("App cache was purged");
          await cache.put(path, response);
        }),
      );
    })();
    writes.add(restore);
    event.waitUntil(
      restore
        .then(
          () => event.ports[0]?.postMessage({ ok: true }),
          (error) => event.ports[0]?.postMessage({ error: String(error) }),
        )
        .finally(() => writes.delete(restore)),
    );
    return;
  }
  if (event.data !== "purge-atlas-caches") return;
  paused = true;
  generation++;
  event.waitUntil(
    (async () => {
      try {
        await Promise.allSettled([...writes]);
        await Promise.all(
          (await caches.keys())
            .filter((k) => k.startsWith("atlas-shell-"))
            .map((k) => caches.delete(k)),
        );
        event.ports[0]?.postMessage({ ok: true });
      } catch (error) {
        event.ports[0]?.postMessage({ error: String(error) });
      }
    })(),
  );
});
const SHELL = [
  "/",
  "/styles.css",
  "/main.js",
  "/offline-worker.js",
  "/routing-worker.js",
  "/wasm/atlas_renderer_bg.wasm",
  "/wasm/atlas_routing_wasm_bg.wasm",
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
  if (event.request.mode === "navigate") paused = false;
  const epoch = generation;
  const network = fetch(event.request);
  event.waitUntil(
    network
      .then((response) => {
        if (!response.ok || paused || epoch !== generation) return;
        const copy = response.clone();
        const write = (async () => {
          const cache = await caches.open(CACHE);
          if (!paused && epoch === generation)
            await cache.put(event.request, copy);
        })();
        writes.add(write);
        return write.finally(() => writes.delete(write));
      })
      .catch(() => {}),
  );
  event.respondWith(
    network.catch(() =>
      caches
        .match(url.pathname)
        .then((response) => response || Response.error()),
    ),
  );
});
