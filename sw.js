const CACHE_NAME = 'daftari-cache-v10';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png'
];

// Files that should always be fetched fresh from the network first
// (so updates pushed to GitHub show up immediately), falling back to
// cache only when there's no connection.
const NETWORK_FIRST = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // { cache: 'reload' } forces a real network fetch during install
      // instead of letting the browser's HTTP cache hand back a stale copy.
      Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => cache.put(url, res))
            .catch(() => {}) // ignore individual failures (e.g. offline install)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Allow the page to force this worker to activate immediately
// (used together with the update-detection code in index.html).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isAppDoc =
    event.request.mode === 'navigate' ||
    NETWORK_FIRST.some((p) => url.pathname.endsWith(p.replace('./', '/')) || url.pathname.endsWith(p));

  if (isAppDoc) {
    // Network-first: always try to get the latest index.html/manifest when
    // online, so a new version pushed to GitHub is picked up right away.
    // Falls back to the cached copy when offline.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for everything else, including cross-origin (fonts, Chart.js CDN),
  // so the app keeps working offline once each resource has loaded at least once.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && (response.status === 200 || response.type === 'opaque')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
