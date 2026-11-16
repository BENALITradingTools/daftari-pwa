const CACHE_NAME = 'daftari-cache-v20';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './badge-96.png'
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
// 1) The page shows a local notification (registration.showNotification) when the app is opened.
// 2) A free Cloudflare Worker sends an EMPTY Web Push on the due day, so this worker also wakes up while the app is closed.

/* ======================= Web Push (empty payload) ======================= */
// The Worker only knows due-dates. The page keeps a device-local snapshot of upcoming dues in Cache Storage
// ('daftari-due'); it is read here to build a specific notification. Nothing leaves the device.
const DUE_CACHE = 'daftari-due';
const DUE_URL = () => new URL('./__due.json', self.registration.scope).href;
const sDiff = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);
function sNext(s, f) {
  const d = new Date(s + 'T00:00:00Z');
  if (f === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (f === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
function localToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
async function readDue() {
  try {
    const c = await caches.open(DUE_CACHE);
    const r = await c.match(DUE_URL());
    return r ? await r.json() : null;
  } catch (e) { return null; }
}

self.addEventListener('push', (event) => {
  // A notification MUST be shown for every push (userVisibleOnly), so there is always a fallback text.
  event.waitUntil((async () => {
    const snap = await readDue();
    const today = localToday();
    const parts = [], debtIds = [];
    if (snap && Array.isArray(snap.items)) {
      for (const it of snap.items) {
        if (it.k === 'd') {
          const k = sDiff(it.due, today);
          if (k <= 1 && k >= -30) { parts.push(it.text); debtIds.push(it.id); }
        } else if (it.k === 'r') {
          let n = sNext(it.l, it.f), g = 0;
          while (n < today && g++ < 40) n = sNext(n, it.f);
          const k = sDiff(n, today);
          if (k >= 0 && k <= 1) parts.push(it.text);
        }
      }
    }
    const data = { tab: debtIds.length ? 'tabDebts' : (parts.length ? 'tabSettings' : '') };
    const opts = {
      body: parts.length ? parts.join(' \u00b7 ') : ((snap && snap.generic) || '\u0644\u062f\u064a\u0643 \u0645\u0633\u062a\u062d\u0642\u0627\u062a \u0642\u0631\u064a\u0628\u0629'),
      icon: './icon-192.png', badge: './badge-96.png', tag: 'daftari-due', dir: 'auto', lang: (snap && snap.lang) || 'ar', data
    };
    if (debtIds.length === 1) {
      data.settle = debtIds[0];
      opts.actions = [{ action: 'settle', title: (snap && snap.settleLabel) || '\u062a\u0633\u062f\u064a\u062f' }];
    }
    await self.registration.showNotification((snap && snap.title) || '\u062f\u0641\u062a\u0631\u064a', opts);
  })());
});

// Focus the open app (and switch tab / open the settle dialog) or open it if closed.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const tab = d.tab || '';
  const settle = event.action === 'settle' ? (d.settle || '') : '';
  const q = [];
  if (tab) q.push('tab=' + encodeURIComponent(tab));
  if (settle) q.push('settle=' + encodeURIComponent(settle));
  const target = q.length ? './?' + q.join('&') : './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'OPEN_TAB', tab });
          if (settle) client.postMessage({ type: 'OPEN_SETTLE', id: settle });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
