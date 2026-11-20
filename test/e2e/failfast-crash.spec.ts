import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from 'playwright/test';
import {
  E2E_EMULATED_COLUMNS,
  LAPTOP_8GB,
  Q_EMULATED_COLUMNS,
} from '../../scripts/lib/bench-columns.mjs';
import * as h from '../../scripts/lib/e2e-harness.mjs';
import { BenchFailure, createGuard } from '../../scripts/lib/fail-fast.mjs';

// B6: a REAL renderer crash (chrome://crash) in installed Chrome, on macOS or anywhere Chrome runs. Local only, like the other specs (npm run test:failfast).
// A synthetic mini app stands in for dockit: it has the test ids the harness drives (a file input, a question box, an Ask button) and never answers, so
// the wait inside ask() is the one a capped run would sit in until its 10 minute timeout.
const label = 'emulated: synthetic crash test on a developer machine, not Windows; not a laptop';
const MINI_INDEX = `<!doctype html><meta charset="utf-8"><title>mini</title>
<div data-testid="model-status" data-status="cached">cached</div>
<input type="file" data-testid="file-input" />
<div id="doc"></div>
<input data-testid="question" /><button data-testid="ask">Ask</button>
<script>
  navigator.serviceWorker.register('sw.js');
  document.querySelector('[data-testid="file-input"]').addEventListener('change', () => {
    document.getElementById('doc').innerHTML = '<div data-testid="doc-summary">3 pages</div>';
  });
  document.querySelector('[data-testid="ask"]').addEventListener('click', () => { document.title = 'asking'; });
</script>`;
const MINI_SW = `self.addEventListener('install', (e) => e.waitUntil(caches.open('mini').then((c) => c.addAll(['./', 'index.html'])).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request))));`;

function miniApp(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'dockit-mini-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), MINI_INDEX);
  writeFileSync(join(dir, 'dist', 'sw.js'), MINI_SW);
  return dir;
}

test('the guard and the harness: chrome://crash during an ask is a renderer_crash within 10 s', async () => {
  const dir = miniApp();
  const profile = h.newProfileDir();
  const srv = await h.startServer({ dist: join(dir, 'dist'), port: 4431 });
  const session = await h.launch({ chromium }, { profileDir: profile, headless: true });
  const guard = createGuard({ page: session.page, context: session.ctx, cdp: session.cdp });
  try {
    await session.page.goto(srv.base);
    const pending = h.ask(session.page, 'will this crash?', { guard }).then(
      () => undefined,
      (e: unknown) => e,
    );
    await session.page.waitForFunction(() => document.title === 'asking');
    const t0 = Date.now();
    await session.page.goto('chrome://crash').catch(() => undefined);
    const err = await pending;
    const ms = Date.now() - t0;
    expect(err).toBeInstanceOf(BenchFailure);
    expect((err as BenchFailure).reason).toBe('renderer_crash');
    expect(ms).toBeLessThan(10_000);
    console.log(`renderer_crash recorded ${ms} ms after chrome://crash`);
  } finally {
    guard.dispose();
    await session.close().catch(() => undefined);
    await srv.close();
  }
});

test('bench-e2e.mjs in emulated mode: chrome://crash during an ask writes failure_reason renderer_crash and exits non-zero in under 10 s', async () => {
  test.setTimeout(120_000);
  const dir = miniApp();
  const csv = join(dir, 'e2e-emulated.csv');
  const qcsv = join(dir, 'e2e-emulated-questions.csv');
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(GITHUB_|RUNNER_|CI$)/u.test(k)),
    ),
    DOCKIT_BENCH_CSV: csv,
    DOCKIT_BENCH_Q_CSV: qcsv,
  } as NodeJS.ProcessEnv;
  const child = spawn(
    process.execPath,
    [
      join(h.ROOT, 'scripts', 'bench-e2e.mjs'),
      '--environment',
      label,
      '--dist',
      join(dir, 'dist'),
      '--port',
      '4432',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += String(d)));
  child.stderr.on('data', (d) => (err += String(d)));
  const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
  try {
    // the profile folder is named on the first line; its DevToolsActivePort gives the debugging port of the bench's own Chrome
    let profile = '';
    for (let i = 0; i < 300 && profile === ''; i++) {
      profile = /profile (\S+chrome-profile-\S+)/u.exec(out)?.[1] ?? '';
      if (profile === '') await new Promise((r) => setTimeout(r, 100));
    }
    expect(profile, `bench-e2e output so far: ${out}${err}`).not.toBe('');
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 300 && !existsSync(portFile); i++)
      await new Promise((r) => setTimeout(r, 100));
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let victim;
    for (let i = 0; i < 600 && victim === undefined; i++) {
      for (const ctx of browser.contexts())
        for (const p of ctx.pages()) if ((await p.title().catch(() => '')) === 'asking') victim = p;
      if (victim === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    expect(victim, `the mini app never reached its ask: ${out}${err}`).toBeDefined();
    const t0 = Date.now();
    await victim!.goto('chrome://crash').catch(() => undefined);
    const code = await exited;
    const ms = Date.now() - t0;
    await browser.close().catch(() => undefined);
    console.log(`bench-e2e exited ${code} ${ms} ms after chrome://crash`);
    expect(code, `${out}${err}`).not.toBe(0);
    expect(code).not.toBeNull();
    expect(ms).toBeLessThan(10_000);
    expect(err + out).toContain('renderer_crash');

    const lines = readFileSync(csv, 'utf8').trim().split('\n');
    expect(lines[0]).toBe(E2E_EMULATED_COLUMNS.join(','));
    const qlines = readFileSync(qcsv, 'utf8').trim().split('\n');
    expect(qlines[0]).toBe(Q_EMULATED_COLUMNS.join(','));
    for (const row of [...lines.slice(1), ...qlines.slice(1)]) {
      expect(row).toContain('renderer_crash');
      expect(row).toContain(LAPTOP_8GB);
      expect(row).toContain(label);
    }
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(qlines.length).toBeGreaterThanOrEqual(2);
  } finally {
    child.kill();
  }
});

// Playwright adds --no-sandbox to every Chromium launch unless chromiumSandbox is true (probed 20 Nov 2026 on Chrome 157). The Windows run is sandbox-on
// (bench-e2e passes sandbox in emulated mode); the local default is unchanged so the committed macOS figures stay comparable with each other.
test('a sandbox-on harness launch has no sandbox-weakening flag on the real Chrome command line', async () => {
  const profile = h.newProfileDir();
  const session = await h.launch(
    { chromium },
    { profileDir: profile, headless: true, sandbox: true },
  );
  try {
    const { execFileSync } = await import('node:child_process');
    const ps =
      process.platform === 'win32'
        ? ''
        : execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' });
    if (ps !== '') {
      const mine = ps.split('\n').filter((l) => l.includes(profile));
      expect(mine.length).toBeGreaterThan(0);
      for (const l of mine)
        expect(l).not.toMatch(
          /--no-sandbox|--disable-web-security|--disable-site-isolation-trials/u,
        );
    }
  } finally {
    await session.close().catch(() => undefined);
  }
});
