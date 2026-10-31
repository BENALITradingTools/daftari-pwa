const CACHE_NAME = 'daftari-cache-v17';
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

// Hosts whose requests must NEVER be cached or intercepted
// (Firebase Auth / Firestore / FCM use long-lived GET streams; caching them breaks sync).
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'fcmregistrations.googleapis.com',
  'firebaseinstallations.googleapis.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => { if (res.ok) return cache.put(url, res); })
            .catch(() => {})
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('daftari-cache-') && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (BYPASS_HOSTS.includes(url.hostname)) return; // let the network handle it

  const isAppDoc =
    event.request.mode === 'navigate' ||
    NETWORK_FIRST.some((p) => url.pathname.endsWith(p.replace('./', '/')) || url.pathname.endsWith(p));

  if (isAppDoc) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Only cache good responses (avoid storing 404/500 pages as the offline copy)
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

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

/* ======================= Local notifications ======================= */
// Notifications are created by the page itself (registration.showNotification) when the app is opened.
// There is no server push: nothing is received while the app is closed.

// Focus the open app (and switch tab) or open it if closed.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const tab = (event.notification.data && event.notification.data.tab) || '';
  const target = tab ? './?tab=' + encodeURIComponent(tab) : './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'OPEN_TAB', tab });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
