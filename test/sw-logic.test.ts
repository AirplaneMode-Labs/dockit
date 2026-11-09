import { describe, expect, it } from 'vitest';
import {
  CACHE_PREFIX,
  cacheName,
  decideRoute,
  hex,
  isCacheable,
  isCurrentCache,
  isStaleOwnCache,
  normaliseKey,
  onVerifyFailure,
  resolvePrecache,
  type RouteContext,
  type RouteRequest,
} from '../src/sw-logic.ts';

const ORIGIN = 'http://127.0.0.1:4173';
const SCOPE = `${ORIGIN}/`;
const PRECACHE = [
  { url: './index.html', sha256: 'a'.repeat(64) },
  { url: './offline.html', sha256: 'b'.repeat(64) },
  { url: './app/index-abc123.js', sha256: 'c'.repeat(64) },
  { url: './app/index-def456.css', sha256: 'd'.repeat(64) },
  { url: './manifest.webmanifest', sha256: 'e'.repeat(64) },
];

function ctx(overrides: Partial<RouteContext> = {}): RouteContext {
  const entries = resolvePrecache(PRECACHE, SCOPE);
  return {
    origin: ORIGIN,
    scopePath: '/',
    precached: new Set(entries.map((e) => e.key)),
    ...overrides,
  };
}

function req(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { method: 'GET', url: `${ORIGIN}/app/index-abc123.js`, hasRange: false, ...overrides };
}

describe('pass-through rules (the worker must not call respondWith)', () => {
  it('passes through any request that is not GET', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']) {
      const route = decideRoute(req({ method, url: `${ORIGIN}/index.html` }), ctx());
      expect(route).toEqual({ action: 'pass-through', reason: 'non-get' });
    }
  });

  it('passes through cross-origin requests even when the path looks precached', () => {
    const route = decideRoute(req({ url: 'https://example.invalid/app/index-abc123.js' }), ctx());
    expect(route).toEqual({ action: 'pass-through', reason: 'cross-origin' });
  });

  it('treats a different port on the same host as cross-origin', () => {
    const route = decideRoute(req({ url: 'http://127.0.0.1:9999/index.html' }), ctx());
    expect(route).toEqual({ action: 'pass-through', reason: 'cross-origin' });
  });

  it('passes through any request carrying a Range header, even for a precached URL', () => {
    const route = decideRoute(req({ hasRange: true }), ctx());
    expect(route).toEqual({ action: 'pass-through', reason: 'range' });
  });

  it('passes through requests whose path starts with /assets/', () => {
    const route = decideRoute(req({ url: `${ORIGIN}/assets/x.bin` }), ctx());
    expect(route).toEqual({ action: 'pass-through', reason: 'assets-path' });
  });

  it('passes through /assets/ relative to a non-root scope', () => {
    const route = decideRoute(
      req({ url: `${ORIGIN}/dockit/assets/model.bin` }),
      ctx({ scopePath: '/dockit/' }),
    );
    expect(route).toEqual({ action: 'pass-through', reason: 'assets-path' });
  });

  it('passes through requests whose path ends with /manifest.json', () => {
    for (const url of [`${ORIGIN}/manifest.json`, `${ORIGIN}/models/manifest.json`]) {
      expect(decideRoute(req({ url }), ctx())).toEqual({
        action: 'pass-through',
        reason: 'manifest-json',
      });
    }
  });

  it('does not confuse the web app manifest with a runtime manifest.json', () => {
    const route = decideRoute(req({ url: `${ORIGIN}/manifest.webmanifest` }), ctx());
    expect(route.action).toBe('cache-first');
  });

  it('passes through same-origin GETs that are neither precached nor navigations', () => {
    const route = decideRoute(req({ url: `${ORIGIN}/api/anything` }), ctx());
    expect(route).toEqual({ action: 'pass-through', reason: 'not-precached' });
  });

  it('checks non-GET before everything else', () => {
    const route = decideRoute(
      req({ method: 'POST', url: `${ORIGIN}/assets/x.bin`, hasRange: true }),
      ctx(),
    );
    expect(route).toEqual({ action: 'pass-through', reason: 'non-get' });
  });
});

describe('cache decisions', () => {
  it('serves precached files cache-first with a normalised key', () => {
    const route = decideRoute(req({ url: `${ORIGIN}/app/index-abc123.js?v=1#frag` }), ctx());
    expect(route).toEqual({ action: 'cache-first', key: `${ORIGIN}/app/index-abc123.js` });
  });

  it('serves the shell navigation network-first with the shell as fallback', () => {
    for (const url of [`${ORIGIN}/`, `${ORIGIN}/index.html`, `${ORIGIN}/?source=pwa`]) {
      const route = decideRoute(req({ url, mode: 'navigate' }), ctx());
      expect(route).toEqual({
        action: 'network-first',
        fallback: 'shell',
        shell: `${ORIGIN}/index.html`,
        offline: `${ORIGIN}/offline.html`,
      });
    }
  });

  it('serves other navigations network-first with offline.html as fallback', () => {
    const route = decideRoute(req({ url: `${ORIGIN}/reports/42`, mode: 'navigate' }), ctx());
    expect(route).toEqual({
      action: 'network-first',
      fallback: 'offline',
      shell: `${ORIGIN}/index.html`,
      offline: `${ORIGIN}/offline.html`,
    });
  });

  it('resolves the shell under a non-root scope', () => {
    const scope = `${ORIGIN}/dockit/`;
    const entries = resolvePrecache(PRECACHE, scope);
    const c = ctx({ scopePath: '/dockit/', precached: new Set(entries.map((e) => e.key)) });
    const route = decideRoute(req({ url: `${ORIGIN}/dockit/`, mode: 'navigate' }), c);
    expect(route).toMatchObject({ fallback: 'shell', shell: `${ORIGIN}/dockit/index.html` });
  });

  describe('offline.css requested from a deep path under the scope', () => {
    // The offline fallback page links `./offline.css`; served for a navigation to
    // /dockit/reports/42 that resolves to /dockit/reports/offline.css, which is answered by the
    // precached scope-level copy so the fallback is styled at any depth.
    const scope = `${ORIGIN}/dockit/`;
    const entries = resolvePrecache(
      [...PRECACHE, { url: './offline.css', sha256: 'f'.repeat(64) }],
      scope,
    );
    const c = ctx({ scopePath: '/dockit/', precached: new Set(entries.map((e) => e.key)) });

    it('maps <scope>**/offline.css to the precached <scope>offline.css, cache-first', () => {
      for (const path of ['/dockit/reports/offline.css', '/dockit/a/b/c/offline.css']) {
        const route = decideRoute(req({ url: `${ORIGIN}${path}` }), c);
        expect(route).toEqual({ action: 'cache-first', key: `${ORIGIN}/dockit/offline.css` });
      }
    });

    it('still serves <scope>offline.css itself cache-first under the same key', () => {
      const route = decideRoute(req({ url: `${ORIGIN}/dockit/offline.css?v=2` }), c);
      expect(route).toEqual({ action: 'cache-first', key: `${ORIGIN}/dockit/offline.css` });
    });

    it('passes through offline.css outside the scope', () => {
      const route = decideRoute(req({ url: `${ORIGIN}/other/offline.css` }), c);
      expect(route).toEqual({ action: 'pass-through', reason: 'not-precached' });
    });

    it('passes through a cross-origin offline.css', () => {
      const route = decideRoute(req({ url: 'https://example.invalid/dockit/offline.css' }), c);
      expect(route).toEqual({ action: 'pass-through', reason: 'cross-origin' });
    });

    it('does not match a file that merely ends in offline.css without a path separator', () => {
      const route = decideRoute(req({ url: `${ORIGIN}/dockit/reports/not-offline.css` }), c);
      expect(route).toEqual({ action: 'pass-through', reason: 'not-precached' });
    });
  });

  it('caches only GET responses with status 200 and type basic', () => {
    expect(isCacheable('GET', { status: 200, type: 'basic' })).toBe(true);
    expect(isCacheable('GET', { status: 206, type: 'basic' })).toBe(false);
    expect(isCacheable('GET', { status: 304, type: 'basic' })).toBe(false);
    expect(isCacheable('GET', { status: 404, type: 'basic' })).toBe(false);
    expect(isCacheable('GET', { status: 200, type: 'opaque' })).toBe(false);
    expect(isCacheable('GET', { status: 200, type: 'cors' })).toBe(false);
    expect(isCacheable('GET', { status: 200, type: 'opaqueredirect' })).toBe(false);
  });

  it('never caches POST responses', () => {
    expect(isCacheable('POST', { status: 200, type: 'basic' })).toBe(false);
    expect(isCacheable('post', { status: 200, type: 'basic' })).toBe(false);
  });
});

describe('cache naming and precache resolution', () => {
  it('derives the cache name from the build hash', () => {
    expect(cacheName('0123abcd')).toBe(`${CACHE_PREFIX}0123abcd`);
    expect(isCurrentCache(`${CACHE_PREFIX}0123abcd`, '0123abcd')).toBe(true);
    expect(isCurrentCache(`${CACHE_PREFIX}ffffffff`, '0123abcd')).toBe(false);
    expect(isCurrentCache('some-other-cache', '0123abcd')).toBe(false);
  });

  it('rejects an empty build hash', () => {
    expect(() => cacheName('')).toThrow(TypeError);
  });

  describe('activate cleanup on a shared origin deletes only stale dockit caches', () => {
    const HASH = '0123abcd';

    it('keeps caches that belong to other demos on the same origin', () => {
      expect(isStaleOwnCache('runtime-test', HASH)).toBe(false);
      expect(isStaleOwnCache('airplanemode-localdata', HASH)).toBe(false);
      expect(isStaleOwnCache('airplanemode-runtime', HASH)).toBe(false);
    });

    it('deletes a dockit cache from an earlier build', () => {
      expect(isStaleOwnCache('dockit-precache-old', HASH)).toBe(true);
      expect(isStaleOwnCache(`${CACHE_PREFIX}ffffffff`, HASH)).toBe(true);
    });

    it('keeps the current build cache', () => {
      expect(isStaleOwnCache(`${CACHE_PREFIX}${HASH}`, HASH)).toBe(false);
      expect(isStaleOwnCache(cacheName(HASH), HASH)).toBe(false);
    });

    it('does not treat a name that merely contains the prefix as its own', () => {
      expect(isStaleOwnCache('x-dockit-precache-old', HASH)).toBe(false);
      expect(isStaleOwnCache('dockit-precache', HASH)).toBe(false);
    });
  });

  it('resolves relative precache URLs against the scope and keeps the hash', () => {
    const entries = resolvePrecache(PRECACHE, `${ORIGIN}/dockit/`);
    expect(entries).toContainEqual({
      key: `${ORIGIN}/dockit/app/index-abc123.js`,
      sha256: 'c'.repeat(64),
    });
    expect(entries).toHaveLength(PRECACHE.length);
  });

  it('rejects precache entries without a 64-hex sha256', () => {
    expect(() => resolvePrecache([{ url: './x.js', sha256: 'nothex' }], SCOPE)).toThrow(TypeError);
  });

  it('normalises keys by dropping search and fragment', () => {
    expect(normaliseKey(`${ORIGIN}/a/b.js?x=1#y`)).toBe(`${ORIGIN}/a/b.js`);
  });

  it('encodes digests as lowercase hex', () => {
    expect(hex(new Uint8Array([0, 1, 255, 16]).buffer)).toBe('0001ff10');
  });
});

describe('verification failure after a cache miss never serves an unverified body', () => {
  it('answers a navigation with the precached offline page', () => {
    const failure = onVerifyFailure({ mode: 'navigate' }, ctx());
    expect(failure).toEqual({ action: 'offline-page', key: `${ORIGIN}/offline.html` });
  });

  it('resolves the offline page under a non-root scope', () => {
    const failure = onVerifyFailure({ mode: 'navigate' }, ctx({ scopePath: '/dockit/' }));
    expect(failure).toEqual({ action: 'offline-page', key: `${ORIGIN}/dockit/offline.html` });
  });

  it('answers every non-navigation request with a synthetic 503, never the network body', () => {
    for (const mode of ['cors', 'no-cors', 'same-origin', undefined]) {
      expect(onVerifyFailure({ mode }, ctx())).toEqual({ action: 'unavailable', status: 503 });
    }
  });

  it('has no variant that passes the request through to the network', () => {
    const actions = new Set(
      ['navigate', 'cors', 'no-cors', 'same-origin', undefined].map(
        (mode) => onVerifyFailure({ mode }, ctx()).action,
      ),
    );
    expect(actions).toEqual(new Set(['offline-page', 'unavailable']));
  });
});
