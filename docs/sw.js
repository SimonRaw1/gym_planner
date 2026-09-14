/* Service worker: caches the app shell so it opens with no connection at all.
 * All workout data is in IndexedDB, so there is nothing else to fetch.
 *
 * Bump CACHE when any shell file changes; the next online launch picks up the
 * new files and the one after that runs them.
 */

const CACHE = 'gym-planner-v5';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Cached copy first, refreshed in the background when there is a network.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
      if (cached) {
        network.catch(() => {});
        return cached;
      }
      return network.catch(() =>
        request.mode === 'navigate' ? caches.match('index.html') : Response.error()
      );
    })
  );
});
