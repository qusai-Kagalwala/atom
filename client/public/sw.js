/* ATOM service worker (Phase 14). Scope: /Atom/.
   - Keeps the app's own files (hashed /Atom/assets/*, fonts, icons) so it opens fast.
   - Pages: always from the network; when offline, the "You're offline" page.
   - Never stores API answers, uploads or anything personal (/Atom/api, /Atom/socket.io are not touched).
   - Push: shows the notification; tapping it opens ATOM there (company / role switched by the app). */
const VERSION = 'atom-v1';
const SHELL = ['/Atom/offline.html', '/Atom/icons/icon-192.png', '/Atom/icons/badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page asks the waiting worker to take over ("New version — Reload").
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/Atom/')) return;
  if (url.pathname.startsWith('/Atom/api/') || url.pathname.startsWith('/Atom/socket.io/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/Atom/offline.html')));
    return;
  }
  // Built files have a hash in the name: once cached, they never change.
  if (/^\/Atom\/(assets|fonts|icons)\//.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
  }
});

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'ATOM', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'ATOM', {
      body: data.body || '',
      tag: data.tag,
      icon: '/Atom/icons/icon-192.png',
      badge: '/Atom/icons/badge-96.png',
      data: { url: data.url || '/Atom/notifications' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/Atom/notifications', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).pathname.startsWith('/Atom/'));
      if (open) return open.navigate(target).then((c) => (c || open).focus());
      return self.clients.openWindow(target);
    })
  );
});
