import { expect, test, type Page } from 'playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { closeServer, serveStatic } from './static-server.ts';

/**
 * GitHub Pages serves dockit at https://airplanemode-labs.github.io/dockit/, a sub-path on an
 * origin shared with the other Airplane Mode Labs demos. This spec copies dist/ into
 * `<tmp>/dockit/` and serves `<tmp>`, so every path outside /dockit/ is a 404 and any
 * root-relative URL in the build would fail loudly.
 */
const SUBPATH_PORT = 4191;
const PREFIX = `http://127.0.0.1:${SUBPATH_PORT}/dockit/`;
const dist = join(import.meta.dirname, '..', 'dist');

interface PrecacheEntry {
  url: string;
  sha256: string;
}

function readPrecache(): { buildHash: string; precache: PrecacheEntry[] } {
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  const hash = /const BUILD_HASH = '([0-9a-f]+)';/u.exec(sw);
  const list = /const PRECACHE = (\[[\s\S]*?\n\]);/u.exec(sw);
  if (!hash || !list) throw new Error('dist/sw.js lacks BUILD_HASH or PRECACHE; run npm run build');
  return { buildHash: hash[1]!, precache: JSON.parse(list[1]!) as PrecacheEntry[] };
}

let server: Server;
let tmp: string;

test.beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'dockit-subpath-'));
  cpSync(dist, join(tmp, 'dockit'), { recursive: true });
  server = await serveStatic(tmp, SUBPATH_PORT);
});

test.afterAll(async () => {
  await closeServer(server);
  rmSync(tmp, { recursive: true, force: true });
});

async function waitControlled(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
}

test.describe('dockit under the /dockit/ sub-path', () => {
  test.use({ baseURL: PREFIX, serviceWorkers: 'allow' });

  test('the server root is a 404 while /dockit/ renders', async ({ request }) => {
    expect((await request.get(`http://127.0.0.1:${SUBPATH_PORT}/`)).status()).toBe(404);
    expect((await request.get(`http://127.0.0.1:${SUBPATH_PORT}/sw.js`)).status()).toBe(404);
    expect((await request.get(PREFIX)).status()).toBe(200);
    expect((await request.get(`${PREFIX}sw.js`)).status()).toBe(200);
  });

  test('every request stays under /dockit/, no console errors, scope ends with /dockit/', async ({
    page,
    context,
  }) => {
    const urls = new Set<string>();
    const failures: string[] = [];
    const errors: string[] = [];
    const record = (p: Page) => {
      p.on('request', (r) => urls.add(r.url()));
      p.on('requestfailed', (r) => failures.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
      p.on('response', (r) => {
        if (r.status() >= 400) failures.push(`${r.url()} ${r.status()}`);
      });
      p.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      p.on('pageerror', (e) => errors.push(e.message));
    };
    record(page);
    context.on('page', record);
    await page.goto('./');
    await waitControlled(page);

    expect(urls.size).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith(PREFIX), u).toBe(true);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);

    const scope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.scope ?? 'none';
    });
    expect(scope).toBe(PREFIX);
    await expect(page.getByTestId('sw-scope')).toHaveText(PREFIX);
    await expect(page.getByTestId('sw-controller')).toHaveText('activated');
    await expect(page.getByTestId('base-url')).toHaveText(PREFIX);
  });

  test('precache keys are all under /dockit/ and include the shell, offline page and manifest', async ({
    page,
  }) => {
    const { buildHash, precache } = readPrecache();
    await page.goto('./');
    await waitControlled(page);
    const keys = await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map((r) => r.url).sort();
    }, `dockit-precache-${buildHash}`);
    expect(keys).toEqual(precache.map((e) => new URL(e.url, PREFIX).href).sort());
    for (const k of keys) expect(k.startsWith(PREFIX), k).toBe(true);
    expect(keys).toEqual(
      expect.arrayContaining([
        `${PREFIX}index.html`,
        `${PREFIX}offline.html`,
        `${PREFIX}manifest.webmanifest`,
      ]),
    );
    expect(keys.some((k) => k.startsWith(`${PREFIX}app/`))).toBe(true);
  });

  test('web app manifest keeps start_url and scope relative', async ({ page }) => {
    await page.goto('./');
    const manifest = await page.evaluate(async () => {
      const r = await fetch('./manifest.webmanifest');
      return (await r.json()) as Record<string, unknown>;
    });
    expect(manifest['start_url']).toBe('./');
    expect(manifest['scope']).toBe('./');
    expect(manifest['id']).toBe('./');
  });

  test("activate deletes only stale dockit-precache-* caches, never another demo's", async ({
    page,
  }) => {
    const { buildHash } = readPrecache();
    // offline.html has no script and registers nothing, so caches created here exist before the
    // worker installs.
    await page.goto('./offline.html');
    await page.evaluate(async () => {
      await caches.open('runtime-test');
      await caches.open('dockit-precache-old');
    });
    expect(await page.evaluate(() => caches.keys())).toEqual(
      expect.arrayContaining(['runtime-test', 'dockit-precache-old']),
    );
    await page.goto('./');
    await waitControlled(page);
    await expect
      .poll(() => page.evaluate(() => caches.keys()), { timeout: 20_000 })
      .toEqual(expect.arrayContaining(['runtime-test', `dockit-precache-${buildHash}`]));
    const names = await page.evaluate(() => caches.keys());
    expect(names).not.toContain('dockit-precache-old');
    expect(names.sort()).toEqual([`dockit-precache-${buildHash}`, 'runtime-test'].sort());
    await page.evaluate(() => caches.delete('runtime-test'));
  });

  test('offline.html loaded directly makes no request outside /dockit/ and logs no error', async ({
    page,
  }) => {
    const urls = new Set<string>();
    const failures: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => urls.add(r.url()));
    page.on('requestfailed', (r) => failures.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
    page.on('response', (r) => {
      if (r.status() >= 400) failures.push(`${r.url()} ${r.status()}`);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('./offline.html');
    await expect(page.locator('h1')).toHaveText('You are offline');
    // Give Chrome a tick to issue any favicon probe; the data: icon link must prevent it.
    await page.waitForTimeout(500);
    expect(urls.size).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith(PREFIX), u).toBe(true);
    expect([...urls].some((u) => u.endsWith('/favicon.ico'))).toBe(false);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain('unsafe-inline');
  });

  test('offline: a deep navigation gets a styled offline.html and a reload renders the shell', async ({
    page,
    context,
  }) => {
    await page.goto('./');
    await waitControlled(page);
    const failures: string[] = [];
    const errors: string[] = [];
    const responses: { url: string; status: number; fromSw: boolean }[] = [];
    page.on('requestfailed', (r) => failures.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
    page.on('response', (r) =>
      responses.push({ url: r.url(), status: r.status(), fromSw: r.fromServiceWorker() }),
    );
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await context.setOffline(true);
    try {
      const deep = await page.goto('./reports/42');
      expect(deep).not.toBeNull();
      expect(deep!.fromServiceWorker()).toBe(true);
      expect(await deep!.text()).toContain('You are offline');
      expect(await deep!.text()).toContain('dockit has no document processing yet');
      await expect(page.locator('h1')).toHaveText('You are offline');

      // The fallback page links ./offline.css, which resolves to /dockit/reports/offline.css at
      // this depth; the worker answers it from the precached /dockit/offline.css.
      const css = responses.find((r) => r.url === `${PREFIX}reports/offline.css`);
      expect(css, JSON.stringify(responses)).toBeDefined();
      expect(css!.status).toBe(200);
      expect(css!.fromSw).toBe(true);
      expect(failures).toEqual([]);
      expect(errors).toEqual([]);
      const h1 = page.locator('h1');
      // offline.css sets .offline { max-width: 36rem } and .offline h1 { color: var(--accent) };
      // an unstyled h1 would be the UA default colour, never one of the two accent values.
      const accent = await h1.evaluate((el) => getComputedStyle(el).color);
      expect(['rgb(20, 33, 61)', 'rgb(201, 214, 255)']).toContain(accent);
      const maxWidth = await page
        .locator('main.offline')
        .evaluate((el) => getComputedStyle(el).maxWidth);
      expect(maxWidth).toBe('576px');

      const shell = await page.goto('./');
      expect(shell).not.toBeNull();
      expect(shell!.status()).toBe(200);
      expect(shell!.fromServiceWorker()).toBe(true);
      await expect(page.getByTestId('placeholder-banner')).toBeVisible();
      await expect(page.getByTestId('online-badge')).toHaveText('offline');
    } finally {
      await context.setOffline(false);
    }
  });

  test('home screen states that document processing is not built and lists six stub stages', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const requests: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('request', (r) => requests.push(r.url()));
    await page.goto('./');
    const banner = page.getByTestId('placeholder-banner');
    await expect(banner).toBeVisible();
    expect(
      (await banner.textContent())!.trim().startsWith('Document processing is not built yet.'),
    ).toBe(true);
    const rows = page.locator('[data-testid="pipeline"] tbody tr');
    await expect(rows).toHaveCount(6);
    for (let i = 0; i < 6; i++) {
      const status = (await rows.nth(i).locator('td').nth(1).textContent()) ?? '';
      expect(status.startsWith('not built'), status).toBe(true);
    }
    await expect(page.locator('#not-yet h2')).toHaveText('What this demo does not do yet');
    await expect(page.locator('#requirements h2')).toHaveText('Browser requirements');
    await expect(page.getByTestId('shared-origin')).toHaveText(
      'All Airplane Mode Labs demos share one browser origin (airplanemode-labs.github.io): storage, quota, estimate() and persist() are shared between them. This demo writes only under the dockit-precache-* cache.',
    );
    for (const id of ['service-worker', 'cache-api', 'install-prompt', 'secure-context']) {
      await expect(page.getByTestId(`req-${id}`)).toHaveAttribute('data-ok', 'true');
    }
    // D5-03: planned model card; a prediction only, no inference, no extra requests.
    await expect(page.getByTestId('model-card')).toContainText(
      'Planned production model: Qwen3-1.7B (Apache-2.0)',
    );
    await expect(page.getByTestId('plan-source')).toContainText(
      'onnx-community/Qwen3-1.7B-ONNX@3231b522c6e7',
    );
    await expect(page.getByTestId('chain').locator('li')).toHaveCount(4);
    await expect(page.getByTestId('prediction-label')).toHaveText(
      'prediction; nothing is downloaded or loaded; inference arrives in Sprint 5',
    );
    await expect(page.getByTestId('pred-wasm')).toHaveText('likely available');
    expect(consoleErrors).toEqual([]);
    expect(
      requests.filter((u) => !u.startsWith(PREFIX)),
      requests.join('\n'),
    ).toEqual([]);
    expect(requests.some((u) => /\.(onnx|safetensors)|huggingface/u.test(u))).toBe(false);
  });

  test('requirements are computed by feature detection, not a static list', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: PREFIX, serviceWorkers: 'block' });
    try {
      await context.addInitScript(() => {
        // Remove the property entirely so `'serviceWorker' in navigator` is false, as on a
        // browser without the feature.
        delete (Navigator.prototype as unknown as Record<string, unknown>)['serviceWorker'];
      });
      const page = await context.newPage();
      await page.goto('./');
      await expect(page.getByTestId('req-service-worker')).toHaveAttribute('data-ok', 'false');
      await expect(page.getByTestId('req-service-worker').locator('.cross')).toBeVisible();
      await expect(page.getByTestId('req-cache-api')).toHaveAttribute('data-ok', 'true');
      await expect(page.getByTestId('req-secure-context')).toHaveAttribute('data-ok', 'true');
      await expect(page.getByTestId('sw-scope')).toHaveText('unsupported');
    } finally {
      await context.close();
    }
  });
});
