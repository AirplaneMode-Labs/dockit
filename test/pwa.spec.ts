import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_URL } from '../playwright.config.ts';
import { closeServer, serveStatic } from './static-server.ts';

const dist = join(import.meta.dirname, '..', 'dist');
const swPath = join(dist, 'sw.js');

interface PrecacheEntry {
  url: string;
  sha256: string;
}

function readBuilt(): { buildHash: string; precache: PrecacheEntry[]; csp: string } {
  const sw = readFileSync(swPath, 'utf8');
  const hash = /const BUILD_HASH = '([0-9a-f]+)';/u.exec(sw);
  const list = /const PRECACHE = (\[[\s\S]*?\n\]);/u.exec(sw);
  if (!hash || !list) throw new Error('dist/sw.js lacks BUILD_HASH or PRECACHE; run npm run build');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html);
  if (!csp) throw new Error('dist/index.html lacks the CSP meta');
  return { buildHash: hash[1]!, precache: JSON.parse(list[1]!) as PrecacheEntry[], csp: csp[1]! };
}

async function loadControlled(page: Page): Promise<void> {
  await page.goto('./');
  // Synchronous predicate on purpose: an async predicate returns a Promise, which is truthy.
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const state = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active?.state ?? 'none';
  });
  expect(state).toBe('activated');
}

async function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(() => caches.keys());
}

const TAMPER_PORT = 4190;

interface WorkerState {
  installing: string | null;
  waiting: string | null;
  active: string | null;
  controller: string | null;
  caches: string[];
}

/** Polls until the registration settles (installing worker gone or redundant), then waits a grace period. */
async function settledWorkerState(page: Page): Promise<WorkerState> {
  return page.evaluate(async () => {
    const deadline = Date.now() + 20_000;
    let settledAt: number | null = null;
    for (;;) {
      const reg = await navigator.serviceWorker.getRegistration();
      const s = {
        installing: reg?.installing?.state ?? null,
        waiting: reg?.waiting?.state ?? null,
        active: reg?.active?.state ?? null,
        controller: navigator.serviceWorker.controller?.state ?? null,
        caches: await caches.keys(),
      };
      const settled = !reg || s.installing === null || s.installing === 'redundant';
      if (settled && settledAt === null) settledAt = Date.now();
      // Three seconds after the first settled sample, or at the deadline, report what we see.
      if ((settledAt !== null && Date.now() - settledAt > 3_000) || Date.now() > deadline) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
  });
}

test.describe('dockit installable PWA', () => {
  test('build output: non-empty precache list with a SHA-256 per entry', () => {
    const { precache } = readBuilt();
    expect(precache.length).toBeGreaterThan(0);
    for (const e of precache) {
      expect(e.url).toMatch(/^\.\//u);
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(precache.map((e) => e.url)).toEqual(
      expect.arrayContaining(['./index.html', './offline.html', './manifest.webmanifest']),
    );
  });

  test('CSP meta: no remote origin, no unsafe-inline, no unsafe-eval, no blob: in worker-src', () => {
    const { csp } = readBuilt();
    expect(csp).not.toMatch(/https?:\/\//u);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    const directives = new Map(
      csp
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [name, ...values] = d.split(/\s+/u);
          return [name!, values] as const;
        }),
    );
    expect(directives.get('worker-src')).toEqual(["'self'"]);
    expect(directives.get('frame-src')).toEqual(["'none'"]);
    expect(directives.get('media-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    // BUG-S1-D-02: the app has no forms to submit, so form-action is 'none', not 'self'.
    expect(directives.get('form-action')).toEqual(["'none'"]);
  });

  test('service worker registers, activates and precaches every entry; manifest is valid', async ({
    page,
  }) => {
    const { buildHash, precache } = readBuilt();
    await loadControlled(page);

    const names = await cacheNames(page);
    expect(names).toEqual([`dockit-precache-${buildHash}`]);
    const cached = await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map((r) => r.url).sort();
    }, names[0]!);
    expect(cached).toEqual(precache.map((e) => new URL(e.url, BASE_URL).href).sort());

    const manifest = await page.evaluate(async () => {
      const r = await fetch('./manifest.webmanifest');
      return (await r.json()) as Record<string, unknown>;
    });
    expect(manifest['name']).toBe('dockit');
    expect(manifest['start_url']).toBe('./');
    expect(manifest['scope']).toBe('./');
    expect(manifest['display']).toBe('standalone');
    const icons = manifest['icons'] as { sizes: string; type: string; purpose: string }[];
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
    await expect(page.getByTestId('placeholder-banner')).toBeVisible();
    await expect(page.getByTestId('online-badge')).toHaveText('online');
  });

  test('offline reload serves the app shell from the hash-verified cache', async ({
    page,
    context,
  }) => {
    await loadControlled(page);
    await context.setOffline(true);
    const response = await page.reload();
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    expect(response!.fromServiceWorker()).toBe(true);
    await expect(page.getByTestId('placeholder-banner')).toBeVisible();
    await expect(page.getByTestId('online-badge')).toHaveText('offline');
    await page.getByTestId('run').click();
    await expect(page.getByTestId('answer')).toContainText('placeholder:');
    await context.setOffline(false);
  });

  test('offline navigation to an uncached route returns offline.html', async ({
    page,
    context,
  }) => {
    await loadControlled(page);
    await context.setOffline(true);
    const response = await page.goto('./reports/42');
    expect(response).not.toBeNull();
    expect(response!.fromServiceWorker()).toBe(true);
    expect(await response!.text()).toContain('You are offline');
    await expect(page.locator('h1')).toHaveText('You are offline');
    await context.setOffline(false);
  });

  test('Range requests and manifest.json bypass the cache and reach the server', async ({
    page,
  }) => {
    await loadControlled(page);
    const seen = new Map<string, { fromSw: boolean; status: number }>();
    page.on('response', (r) => {
      seen.set(new URL(r.url()).pathname, { fromSw: r.fromServiceWorker(), status: r.status() });
    });
    const { precache } = readBuilt();
    const cssEntry = precache.find((e) => e.url.endsWith('.css') && e.url.startsWith('./app/'))!;
    const results = await page.evaluate(async (css) => {
      const out: Record<string, number> = {};
      out['range'] = (await fetch('./assets/x.bin', { headers: { Range: 'bytes=0-1' } })).status;
      out['manifest'] = (await fetch('./manifest.json')).status;
      out['css'] = (await fetch(css)).status;
      return out;
    }, cssEntry.url);
    expect(results['css']).toBe(200);
    const range = seen.get('/assets/x.bin');
    const manifest = seen.get('/manifest.json');
    const css = seen.get(`/${cssEntry.url.slice(2)}`);
    expect(range, 'range request observed').toBeDefined();
    expect(manifest, 'manifest.json request observed').toBeDefined();
    expect(range!.fromSw).toBe(false);
    expect(manifest!.fromSw).toBe(false);
    expect(css?.fromSw).toBe(true);
  });

  test('every request is same-origin', async ({ page, context }) => {
    const urls = new Set<string>();
    const record = (p: Page) => p.on('request', (r) => urls.add(r.url()));
    record(page);
    context.on('page', record);
    await loadControlled(page);
    await page.getByTestId('run').click();
    await expect(page.getByTestId('answer')).toContainText('placeholder:');
    await page.reload();
    expect(urls.size).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith(BASE_URL), u).toBe(true);
  });

  test('a precached file altered on the server after install is never served unverified', async ({
    page,
  }) => {
    const { buildHash, precache } = readBuilt();
    const cssEntry = precache.find((e) => e.url.endsWith('.css') && e.url.startsWith('./app/'))!;
    const cssPath = join(dist, cssEntry.url.slice(2));
    const original = readFileSync(cssPath, 'utf8');
    try {
      await loadControlled(page);
      // Alter the file on the server, then evict its cache entry so the worker must re-fetch.
      writeFileSync(cssPath, `${original}\n/* altered after install */\n`);
      const cacheName = `dockit-precache-${buildHash}`;
      const deleted = await page.evaluate(
        async ([name, url]) => (await caches.open(name!)).delete(url!),
        [cacheName, cssEntry.url] as const,
      );
      expect(deleted).toBe(true);
      const result = await page.evaluate(async (url) => {
        const r = await fetch(url, { cache: 'no-store' });
        return { status: r.status, body: await r.text() };
      }, cssEntry.url);
      expect(result.status).toBe(503);
      expect(result.body).not.toContain('altered after install');
      // Nothing was put back into the cache either.
      const cachedAgain = await page.evaluate(
        async ([name, url]) => (await (await caches.open(name!)).match(url!)) !== undefined,
        [cacheName, cssEntry.url] as const,
      );
      expect(cachedAgain).toBe(false);
    } finally {
      writeFileSync(cssPath, original);
    }
  });

  test('tampered precache entry: install fails, no worker, no controller, nothing cached', async ({
    browser,
  }) => {
    const { precache } = readBuilt();
    const sw = readFileSync(swPath, 'utf8');
    const target = precache.find((e) => e.url.endsWith('.css') && e.url.startsWith('./app/'))!;
    const flipped = (target.sha256[0] === '0' ? '1' : '0') + target.sha256.slice(1);
    expect(sw).toContain(target.sha256);
    const tmp = mkdtempSync(join(tmpdir(), 'dockit-tampered-'));
    cpSync(dist, tmp, { recursive: true });
    writeFileSync(join(tmp, 'sw.js'), sw.replace(target.sha256, flipped));
    const server = await serveStatic(tmp, TAMPER_PORT);
    const base = `http://127.0.0.1:${TAMPER_PORT}/`;
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    try {
      const page = await context.newPage();
      const hosts = new Set<string>();
      page.on('request', (r) => hosts.add(new URL(r.url()).host));
      await page.goto(base);
      const state = await settledWorkerState(page);
      expect(state.installing, 'no worker may remain installing').toBeNull();
      expect(state.waiting).toBeNull();
      expect(state.active, 'no worker must activate from a tampered precache').toBeNull();
      expect(state.controller).toBeNull();
      expect(state.caches, 'no cache may survive a failed install').toEqual([]);
      expect([...hosts]).toEqual([`127.0.0.1:${TAMPER_PORT}`]);
    } finally {
      await context.close();
      await closeServer(server);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('activating a build with a new hash removes the old cache', async ({ page }) => {
    const original = readFileSync(swPath, 'utf8');
    const { buildHash } = readBuilt();
    const newHash = 'f'.repeat(buildHash.length);
    try {
      await loadControlled(page);
      expect(await cacheNames(page)).toEqual([`dockit-precache-${buildHash}`]);
      writeFileSync(swPath, original.replace(`'${buildHash}'`, `'${newHash}'`));
      await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        await reg!.update();
      });
      await expect
        .poll(() => cacheNames(page), { timeout: 20_000 })
        .toEqual([`dockit-precache-${newHash}`]);
    } finally {
      writeFileSync(swPath, original);
    }
  });
});

test.afterEach(async ({ context }: { context: BrowserContext }) => {
  await context.setOffline(false);
});
