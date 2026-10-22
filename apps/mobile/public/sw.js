// ERP service worker. Network first for pages (status must be fresh),
// cache first for build assets, and an offline page that always offers 112.
const VERSION = 'erp-v2';
const SHELL = ['/', '/report', '/offline.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache the API: live status and money must come from the server.
  if (url.origin !== self.location.origin) return;
  // Development: no caching, so code changes show at once (the worker is here for alerts).
  if (self.location.hostname === 'localhost') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/offline.html'))),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/') || url.pathname.endsWith('.svg')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
  }
});

// Alerts from the server (web push): offers, assignments, report updates. Offers stay on screen
// until the officer acts, vibrate, and replace an earlier alert for the same report.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'ERP', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'ERP';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.urgent,
      requireInteraction: !!data.urgent,
      vibrate: data.urgent ? [300, 100, 300, 100, 300] : [100],
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { link: data.link || null },
    }),
  );
});

// Tapping an alert opens the app on the right page (the app maps the server's link for this person).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data && event.notification.data.link;
  const target = link ? '/open?link=' + encodeURIComponent(link) : '/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.navigate(target).then((w) => (w || open).focus());
      return self.clients.openWindow(target);
    }),
  );
});
