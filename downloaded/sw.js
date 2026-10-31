/* Kunooz shell cache — APIs and checkout always hit the network. */
const V = 'kunuz-v9';
const SHELL = [
  '/',
  '/catalog.js?v=kunuz2',
  '/kunuz-catalog.js?v=kunuz2',
  '/assets/kunuz-mark.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(V)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const networkFirst = async (req, fallbackKey) => {
  const c = await caches.open(V);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(fallbackKey || req, res.clone());
    return res;
  } catch {
    return (await c.match(fallbackKey || req)) || (await c.match('/')) || Response.error();
  }
};

const cacheFirst = async (req) => {
  const c = await caches.open(V);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') c.put(req, res.clone());
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
      e.respondWith(cacheFirst(req));
    }
    return;
  }
  if (/^\/(api|admin|pay|webhooks)(\/|$)/.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, '/'));
    return;
  }
  if (url.pathname === '/catalog.js' || url.pathname === '/kunuz-catalog.js' || url.pathname.endsWith('.webmanifest')) {
    e.respondWith(networkFirst(req));
    return;
  }
  if (/^\/(img|brand|assets)\//.test(url.pathname) || /\.(png|ico|webp|jpg|svg|js)$/.test(url.pathname)) {
    e.respondWith(cacheFirst(req));
  }
});
