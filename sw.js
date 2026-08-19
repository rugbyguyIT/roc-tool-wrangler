// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — Service Worker
// Network-first: always fetch fresh. Cache is an offline-only fallback,
// which matters because the sheds and trailers at NRG have patchy wifi —
// a leader opening the board out of coverage should see the last view
// rather than a browser error page.
//
// Bump CACHE_VERSION on EVERY release (in step with APP_VERSION in
// js/config.js) to force all clients to update instantly.
//
// No push handler in rev 1 — notifications are deliberately out of
// scope. When they land, add 'push' + 'notificationclick' listeners
// here; nothing else in this file changes.
// ─────────────────────────────────────────────────────────────
const CACHE_VERSION = 'hlsr-assets-0.10.2';

self.addEventListener('install', () => {
  self.skipWaiting(); // activate the new SW immediately
});

self.addEventListener('activate', e => {
  // Wipe ALL old caches on every deploy
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls — custody data must never be served stale.
  if (url.pathname.startsWith('/api/')) return;

  // Never intercept cross-origin (fonts, Font Awesome CDN, etc.)
  if (url.origin !== self.location.origin) return;

  // config.js and sw.js must NEVER be served stale — force a fresh,
  // cache-bypassing network fetch so version updates always propagate.
  const alwaysFresh = url.pathname === '/js/config.js' || url.pathname === '/sw.js';
  const request = alwaysFresh ? new Request(e.request, { cache: 'no-store' }) : e.request;

  e.respondWith(
    fetch(request)
      .then(res => {
        if (!alwaysFresh && e.request.method === 'GET' && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
