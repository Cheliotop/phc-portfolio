// Exists only so Chrome/Edge treat this app as installable (desktop icon).
// No caching: every screen here is live Supabase data (project status,
// pending pedidos, stock) — serving a cached response instead of hitting
// the network could show the admin stale/wrong data, which is worse than
// no offline support at all. Every request just passes straight through.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
