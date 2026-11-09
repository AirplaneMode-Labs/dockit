/**
 * Pure routing rules for the dockit service worker.
 *
 * This module has no side effects and touches no service-worker globals, so it is unit
 * tested in Node (test/sw-logic.test.ts) and bundled into dist/sw.js as the SW_LOGIC global
 * by `vite build -c vite.sw.config.ts` plus scripts/inject-precache.mjs.
 */

export const CACHE_PREFIX = 'dockit-precache-';
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export interface RouteRequest {
  method: string;
  url: string;
  /** Request.mode; 'navigate' marks a navigation. */
  mode?: string | undefined;
  /** True when the request carries a Range header. */
  hasRange: boolean;
}

export interface RouteContext {
  /** self.location.origin of the worker. */
  origin: string;
  /** Pathname of the registration scope, always ending with '/'. */
  scopePath: string;
  /** Normalised absolute URLs of every precached entry. */
  precached: ReadonlySet<string>;
}

export type PassThroughReason =
  'non-get' | 'cross-origin' | 'range' | 'assets-path' | 'manifest-json' | 'not-precached';

export type Route =
  | { action: 'pass-through'; reason: PassThroughReason }
  | { action: 'cache-first'; key: string }
  | { action: 'network-first'; fallback: 'shell' | 'offline'; shell: string; offline: string };

/**
 * What the fetch handler answers when a precached URL misses the cache and its re-fetch fails
 * verification (hash mismatch, non-basic response, network error). The unverified network
 * body is never an option: install fails closed and so does the runtime path.
 */
export type VerifyFailure =
  { action: 'offline-page'; key: string } | { action: 'unavailable'; status: 503 };

export interface PrecacheEntry {
  url: string;
  sha256: string;
}

export interface ResolvedEntry {
  key: string;
  sha256: string;
}

/** Drops search and fragment so cache keys are stable. */
export function normaliseKey(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

export function cacheName(buildHash: string): string {
  if (typeof buildHash !== 'string' || buildHash.length === 0) {
    throw new TypeError('cacheName: build hash must be a non-empty string');
  }
  return `${CACHE_PREFIX}${buildHash}`;
}

export function isCurrentCache(name: string, buildHash: string): boolean {
  return name === cacheName(buildHash);
}

/** Only successful, same-origin ("basic") GET responses are ever cached. */
export function isCacheable(method: string, response: { status: number; type: string }): boolean {
  return method.toUpperCase() === 'GET' && response.status === 200 && response.type === 'basic';
}

export function resolvePrecache(entries: readonly PrecacheEntry[], scope: string): ResolvedEntry[] {
  return entries.map((e) => {
    if (!SHA256_HEX.test(e.sha256)) {
      throw new TypeError(`resolvePrecache: ${e.url} has no 64-hex sha256`);
    }
    return { key: normaliseKey(new URL(e.url, scope).href), sha256: e.sha256 };
  });
}

export function hex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i]!.toString(16).padStart(2, '0');
  return out;
}

function shellUrl(ctx: RouteContext): string {
  return `${ctx.origin}${ctx.scopePath}index.html`;
}

function offlineUrl(ctx: RouteContext): string {
  return `${ctx.origin}${ctx.scopePath}offline.html`;
}

function isAssetsPath(pathname: string, scopePath: string): boolean {
  if (pathname.startsWith('/assets/')) return true;
  return pathname.startsWith(scopePath) && pathname.slice(scopePath.length).startsWith('assets/');
}

/** Fail closed: navigations get the precached offline page, everything else a 503. */
export function onVerifyFailure(
  req: { mode?: string | undefined },
  ctx: RouteContext,
): VerifyFailure {
  if (req.mode === 'navigate') return { action: 'offline-page', key: offlineUrl(ctx) };
  return { action: 'unavailable', status: 503 };
}

/**
 * Decides what the fetch handler does. The order of the checks is part of the contract:
 * non-GET, cross-origin, Range, /assets/, manifest.json are pass-through (the worker returns
 * without calling respondWith); then navigations are network-first; then precached URLs are
 * cache-first; everything else passes through.
 */
export function decideRoute(req: RouteRequest, ctx: RouteContext): Route {
  if (req.method.toUpperCase() !== 'GET') return { action: 'pass-through', reason: 'non-get' };

  const url = new URL(req.url);
  if (url.origin !== ctx.origin) return { action: 'pass-through', reason: 'cross-origin' };
  if (req.hasRange) return { action: 'pass-through', reason: 'range' };
  if (isAssetsPath(url.pathname, ctx.scopePath)) {
    return { action: 'pass-through', reason: 'assets-path' };
  }
  if (url.pathname.endsWith('/manifest.json')) {
    return { action: 'pass-through', reason: 'manifest-json' };
  }

  const key = normaliseKey(req.url);
  if (req.mode === 'navigate') {
    const shell = shellUrl(ctx);
    const isShell = key === `${ctx.origin}${ctx.scopePath}` || key === shell;
    return {
      action: 'network-first',
      fallback: isShell ? 'shell' : 'offline',
      shell,
      offline: offlineUrl(ctx),
    };
  }
  if (ctx.precached.has(key)) return { action: 'cache-first', key };
  return { action: 'pass-through', reason: 'not-precached' };
}
