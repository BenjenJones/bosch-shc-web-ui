// Service worker — makes the UI installable as a PWA and keeps the app shell
// (HTML/JS/CSS/i18n/icons) available when the network drops.
//
// Strategy: network-first for every same-origin GET outside /api/. A fresh
// response always wins (so a deploy never serves a stale UI) and is copied
// into the cache; the cached copy is only used when the fetch fails. /api/*
// (live data, auth, the SSE stream) is never touched — it must always reach
// the server.
//
// All paths are relative to the worker's own location, so the app also works
// when mounted under a sub-path (e.g. a reverse proxy or HA ingress).
const CACHE = 'shc-shell-v1';

self.addEventListener('install', (event) => {
  // Pre-cache only the entry page; everything else is cached on first use.
  event.waitUntil(caches.open(CACHE).then(c => c.add('./')).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  const rel = url.pathname.slice(scope.pathname.length);
  if (rel.startsWith('api/')) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true })
        // Navigations to any in-scope URL fall back to the cached entry page.
        || (req.mode === 'navigate' ? await caches.match('./') : undefined);
      if (cached) return cached;
      throw err;
    }
  })());
});
