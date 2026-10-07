// App shell cache for instant launch + push notifications.
const VERSION = 'abai-v4';
const SHELL = ['/', '/app.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = e.request.mode === 'navigate' ? '/' : url.pathname;
  if (!SHELL.includes(key)) return;
  // stale-while-revalidate: open instantly from cache, refresh in the background
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(key);
      const fresh = fetch(e.request).then((res) => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      }).catch(() => cached);
      return cached || fresh;
    }),
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification('اجـاك اشعار', {
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag || 'chat',
      renotify: true,
      lang: 'ar',
      dir: 'rtl',
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('/');
    }),
  );
});
