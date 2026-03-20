// Service Worker — Red Alert LED Map PWA
// Caches all app files on first load. App works fully offline after that.
// Network-first for API calls to ESP32, cache-first for app shell.

const CACHE = 'redalert-v1';
const APP_SHELL = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Pass through all ESP32 API calls — never cache device responses
  if (url.hostname !== location.hostname) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"error":"offline"}',
      {headers:{'Content-Type':'application/json'}})));
    return;
  }
  // App shell: cache-first
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
    )
  );
});
