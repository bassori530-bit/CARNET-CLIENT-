const CACHE_NAME = "carnet-client-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.jsx",
  "./storage-idb.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Fichiers du même domaine (squelette de l'app) : cache d'abord, réseau en repli.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request)
            .then((res) => {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
              return res;
            })
            .catch(() => cached)
      )
    );
    return;
  }
  // Ressources externes (CDN React, etc.) : réseau d'abord, laissées passer normalement.
});
