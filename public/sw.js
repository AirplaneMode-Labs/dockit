/*
 * dockit service worker (hand-written). The routing rules live in src/sw-logic.ts and are
 * bundled into this file as the SW_LOGIC global by the build; the precache list and build
 * hash are injected by scripts/inject-precache.mjs. Do not edit dist/sw.js by hand.
 *
 * This worker never caches a byte it has not hashed: every precache entry is fetched,
 * hashed with SHA-256 and compared to the list below before it is stored. On mismatch the
 * install fails and nothing is cached.
 */
/* global SW_LOGIC */
/* __SW_LOGIC__ */

const BUILD_HASH = '__BUILD_HASH__';
const PRECACHE = /* __PRECACHE__ */ [];

const CACHE_NAME = SW_LOGIC.cacheName(BUILD_HASH);
const SCOPE = self.registration.scope;
const ENTRIES = SW_LOGIC.resolvePrecache(PRECACHE, SCOPE);
const ROUTE_CONTEXT = {
  origin: self.location.origin,
  scopePath: new URL(SCOPE).pathname,
  precached: new Set(ENTRIES.map((e) => e.key)),
};

async function fetchVerified(key, sha256) {
  const response = await fetch(key, {
    cache: 'reload',
    credentials: 'same-origin',
    redirect: 'error',
    mode: 'same-origin',
  });
  if (!SW_LOGIC.isCacheable('GET', response)) {
    throw new Error(`precache: ${key} returned ${response.status} (${response.type})`);
  }
  const body = await response.arrayBuffer();
  const digest = SW_LOGIC.hex(await crypto.subtle.digest('SHA-256', body));
  if (digest !== sha256) {
    throw new Error(`precache: SHA-256 mismatch for ${key}`);
  }
  return new Response(body, { status: 200, statusText: 'OK', headers: response.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      let cache;
      try {
        const verified = await Promise.all(
          ENTRIES.map(async (e) => [e.key, await fetchVerified(e.key, e.sha256)]),
        );
        cache = await caches.open(CACHE_NAME);
        await Promise.all(verified.map(([key, response]) => cache.put(key, response)));
      } catch (err) {
        await caches.delete(CACHE_NAME);
        throw err;
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => !SW_LOGIC.isCurrentCache(name, BUILD_HASH))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(key, request) {
  const cached = await caches.match(key, { cacheName: CACHE_NAME });
  if (cached) return cached;
  const entry = ENTRIES.find((e) => e.key === key);
  try {
    const verified = await fetchVerified(key, entry.sha256);
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, verified.clone());
    return verified;
  } catch {
    // Fail closed (S1-023): the unverified network body is never served. Navigations get the
    // precached offline page; everything else a synthetic 503.
    const failure = SW_LOGIC.onVerifyFailure({ mode: request.mode }, ROUTE_CONTEXT);
    if (failure.action === 'offline-page') {
      const offline = await caches.match(failure.key, { cacheName: CACHE_NAME });
      if (offline) return offline;
    }
    return new Response('dockit: a stored file failed its integrity check and was not served.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}

async function networkFirst(request, route) {
  try {
    return await fetch(request);
  } catch {
    const fallbackKey = route.fallback === 'shell' ? route.shell : route.offline;
    const fallback = await caches.match(fallbackKey, { cacheName: CACHE_NAME });
    if (fallback) return fallback;
    return new Response('dockit is offline and this page is not stored on this device.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const route = SW_LOGIC.decideRoute(
    {
      method: request.method,
      url: request.url,
      mode: request.mode,
      hasRange: request.headers.has('range'),
    },
    ROUTE_CONTEXT,
  );
  if (route.action === 'pass-through') return;
  if (route.action === 'cache-first') {
    event.respondWith(cacheFirst(route.key, request));
    return;
  }
  event.respondWith(networkFirst(request, route));
});
