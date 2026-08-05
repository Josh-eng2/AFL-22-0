/**
 * Service worker — makes Can You Go 22-0? installable as a PWA and keeps
 * core playable assets available offline after the first visit.
 *
 * Strategy:
 *   - Precache the app shell + local static assets on install
 *   - Cache-first for same-origin static files (CSS/JS/icons/SVG)
 *   - Network-first for HTML navigations (so deploys show up quickly)
 *   - Leave third-party CDNs (Firebase, fonts, CrazyGames, etc.) alone
 *
 * Every path here is RELATIVE. This game is served from a GitHub Pages
 * subpath (/AFL-22-0/), so a leading-slash path would resolve to the domain
 * root and silently precache nothing. Registration is likewise './sw.js',
 * which also scopes the worker to the subpath rather than the whole origin.
 *
 * Bump CACHE_VERSION when shipping asset changes so old caches are dropped.
 * A stale precache otherwise serves an old build indefinitely.
 */
const CACHE_VERSION = '220-v1';
const PRECACHE = `precache-${CACHE_VERSION}`;
const RUNTIME  = `runtime-${CACHE_VERSION}`;

// Keep in step with the js/ tree — a module missing here means the installed
// app half-loads offline, which is worse than not caching at all.
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './logo-badge.svg',
  './css/tailwind.css',
  './css/styles.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  // App shell modules — enough for Classic play offline after install.
  './js/main.js',
  './js/data/players.js',
  './js/ui/events.js',
  './js/ui/render.js',
  './js/ui/shareCard.js',
  './js/logic/state.js',
  './js/logic/draft.js',
  './js/logic/era.js',
  './js/logic/positions.js',
  './js/logic/chemistry.js',
  './js/logic/simulation.js',
  './js/logic/seasonTier.js',
  './js/logic/challenge.js',
  './js/logic/modes.js',
  './js/logic/playoffs.js',
  './js/logic/aiDraft.js',
  './js/logic/dynastyDuel.js',
  './js/utils/storage.js',
  './js/utils/firebase.js',
  './js/utils/crazygames.js',
  './js/utils/gamedistribution.js',
  './js/utils/pageIntegrity.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(PRECACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== PRECACHE && k !== RUNTIME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Third-party (fonts, Firebase, confetti CDN, portal SDKs) goes straight to
  // the network — caching someone else's endpoints here would only add a
  // stale layer the game already degrades gracefully without.
  if (url.origin !== self.location.origin) return;

  // Network-first for navigations so a fresh deploy is picked up promptly,
  // falling back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(RUNTIME).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for same-origin static assets.
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(RUNTIME).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});
