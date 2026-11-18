// Shared by `npm run test:e2e` / `test:gate` (Playwright specs) and `npm run bench:e2e` (plain node, Windows-compatible): serving the built
// app under /dockit/, launching installed Chrome on a named profile, going offline, driving the page, and reading the events back through
// the runtime DevTools hook (window.__airplanemodeDevtools.snapshot()). No stub or test-double model is involved anywhere.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './cdp-counter.mjs';
import { startRssSampler } from './proc-rss.mjs';
import { closeServer, serveStatic } from './static-server.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = join(ROOT, 'dist');
export const PREFIX = '/dockit/';

export const machineLabel = () =>
  `${os.cpus()[0]?.model.trim() ?? 'unknown cpu'} ${Math.round(os.totalmem() / 2 ** 30)} GB`;

export function gitCommit() {
  try {
    const git = (...a) =>
      execFileSync('git', ['-C', ROOT, ...a], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const dirty = git('status', '--porcelain', '--untracked-files=no').length > 0;
    return `${git('rev-parse', '--short=12', 'HEAD')}${dirty ? '-dirty' : ''}`;
  } catch {
    return 'unknown';
  }
}

/** A profile directory whose name starts with chrome-profile- (the evidence rules keep such folders out of the evidence copy). */
export const newProfileDir = (base = os.tmpdir()) => mkdtempSync(join(base, 'chrome-profile-'));

export async function startServer({ dist = DIST, port, prefix = PREFIX }) {
  const requests = [];
  const server = await serveStatic(dist, port, {
    prefix,
    onRequest: (p, s) => requests.push({ path: p, status: s, at: Date.now() }),
  });
  return {
    server,
    requests,
    base: `http://127.0.0.1:${port}${prefix}`,
    close: () => closeServer(server),
  };
}

/**
 * Launches installed Chrome (channel chrome, no download) on the profile, with precise memory info and a debugging port, and attaches the
 * CDP request ledger to every target. `watch` false skips the ledger.
 */
export async function launch(playwright, { profileDir, headless = true, watch = true }) {
  const ctx = await playwright.chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless,
    serviceWorkers: 'allow',
    args: ['--enable-precise-memory-info', ...(watch ? ['--remote-debugging-port=0'] : [])],
  });
  const cdp = watch ? await connectCdp(profileDir) : undefined;
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return {
    ctx,
    page,
    ledger: cdp?.ledger,
    async close() {
      cdp?.close();
      await ctx.close();
    },
  };
}

/**
 * setOffline and an abort-everything route are backstops; the CDP ledger is what counts. Chrome's setOffline does not change
 * navigator.onLine (it stays true), whereas a laptop with Wi-Fi off reports false, so the page is also told what a real offline
 * browser says: navigator.onLine reads false in every page loaded after this call.
 */
export async function goOffline(ctx) {
  await ctx.setOffline(true);
  await ctx.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false, configurable: true }),
  );
  await ctx.route('**', (route) => route.abort('internetdisconnected'));
}

export async function chromeVersion(page) {
  // navigator.userAgent reports the reduced 157.0.0.0; the full version list has the real build number
  return page.evaluate(async () => {
    const full = await navigator.userAgentData
      ?.getHighEntropyValues?.(['fullVersionList'])
      .catch(() => undefined);
    const chrome =
      full?.fullVersionList?.find((b) => b.brand === 'Google Chrome') ??
      full?.fullVersionList?.find((b) => b.brand === 'Chromium');
    return `Chrome/${chrome?.version ?? /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? 'unknown'}`;
  });
}

export async function waitReady(page, base, { timeout = 60000 } = {}) {
  await page.goto(base);
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller?.state === 'activated',
    null,
    { timeout },
  );
  await page.getByTestId('model-status').waitFor({ timeout });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="model-status"]')?.getAttribute('data-status') !==
      'unknown',
    null,
    { timeout },
  );
}

/** Text of an element that may be absent: a locator's innerText() would wait for it up to the default timeout (30 s), so ask whether it exists first. */
async function textIfPresent(page, testId) {
  const el = page.getByTestId(testId);
  return (await el.count()) > 0 ? await el.first().innerText() : '';
}
async function attrIfPresent(page, testId, name) {
  const el = page.getByTestId(testId);
  return (await el.count()) > 0 ? await el.first().getAttribute(name) : null;
}

/** Online, once: press Download and wait until the model is verified on this device. Returns the model status text. */
export async function downloadModel(page, { timeout = 15 * 60000 } = {}) {
  await page.getByTestId('download-model').click();
  await page.waitForFunction(
    () => {
      const s = document.querySelector('[data-testid="model-status"]')?.getAttribute('data-status');
      return (
        s === 'cached' ||
        s === 'ready' ||
        s === 'refused' ||
        document.querySelector('[data-testid="model-refusal"]') !== null
      );
    },
    null,
    { timeout },
  );
  const refusal = await textIfPresent(page, 'model-refusal');
  return { status: await page.getByTestId('model-status').getAttribute('data-status'), refusal };
}

/** Chooses a file and waits for the document card to show a result. */
export async function openPdf(page, file, { timeout = 5 * 60000 } = {}) {
  await page.setInputFiles('[data-testid="file-input"]', file);
  await page.waitForSelector('[data-testid="doc-summary"], [data-testid="doc-refusal"]', {
    timeout,
  });
  const refusal = await textIfPresent(page, 'doc-refusal');
  const reason = await attrIfPresent(page, 'doc-refusal', 'data-reason');
  const summary = await textIfPresent(page, 'doc-summary');
  return { ok: refusal === '', refusal, reason, summary };
}

/** Types a question, asks, and waits for the answer or a refusal. */
export async function ask(page, question, { timeout = 10 * 60000 } = {}) {
  await page.getByTestId('question').fill(question);
  await page.getByTestId('ask').click();
  await page.waitForSelector('[data-testid="answer-block"], [data-testid="ask-refusal"]', {
    timeout,
  });
  const refusal = await textIfPresent(page, 'ask-refusal');
  const reason = await attrIfPresent(page, 'ask-refusal', 'data-reason');
  if (refusal)
    return { ok: false, refusal, reason, text: '', sources: [], firstTokenMs: null, totalMs: null };
  const text = await page.getByTestId('answer').innerText();
  const sources = await page.$$eval('[data-testid^="source-"]', (lis) =>
    lis.map((li) => {
      const t = li.querySelector('span')?.textContent ?? '';
      const m = /^(S\d+), page ([\d ]+(?: to \d+)?)/.exec(t);
      return {
        id: m?.[1] ?? '',
        pages: m?.[2] ?? '',
        cited: li.getAttribute('data-cited') === 'true',
      };
    }),
  );
  const timing = await page.getByTestId('first-token').innerText();
  const num = (re) => {
    const m = re.exec(timing);
    return m ? Number(m[1].replaceAll(',', '')) : null;
  };
  return {
    ok: true,
    refusal: '',
    reason: null,
    text,
    sources,
    firstTokenMs: num(/first token: ([\d,]+) ms/),
    totalMs: num(/Total: ([\d,]+) ms/),
  };
}

/**
 * Asks, presses Stop at the chosen moment, and waits for the card to settle (BUG-T1-S5-R2-01 and -02).
 *   when 'streaming'  Stop once the first words are on screen (the partial text is kept)
 *   when 'prefill'    Stop `afterMs` after Stop became available, before the first token (the card says Stopped.)
 * Returns what the card shows: `stopped` (the Stopped. line), `partial` (the kept answer text, '' when none), the refusal if any, and the
 * model status the card reported once it settled ('cached' is right: the files are on the device and nothing is loaded).
 */
export async function askThenStop(
  page,
  question,
  { when = 'streaming', afterMs = 800, timeout = 5 * 60000 } = {},
) {
  await page.getByTestId('question').fill(question);
  await page.getByTestId('ask').click();
  if (when === 'prefill') {
    await page.waitForSelector('[data-testid="stop"]:not([disabled])', { timeout });
    await new Promise((r) => setTimeout(r, afterMs));
  } else {
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="answer-streaming"]')?.textContent ?? '').trim()
          .length > 0,
      null,
      { timeout },
    );
  }
  await page.getByTestId('stop').click();
  await page.waitForSelector(
    '[data-testid="ask-stopped"], [data-testid="answer-block"], [data-testid="ask-refusal"]',
    { timeout },
  );
  return {
    stopped: (await page.getByTestId('ask-stopped').count()) > 0,
    stoppedText: await textIfPresent(page, 'ask-stopped'),
    partial: await textIfPresent(page, 'answer'),
    refusal: await textIfPresent(page, 'ask-refusal'),
    reason: await attrIfPresent(page, 'ask-refusal', 'data-reason'),
    modelStatus: await attrIfPresent(page, 'model-status', 'data-status'),
  };
}

/**
 * Records, inside the page, when the model card goes to 'loading' and back to 'ready' and what its text said while loading. Call it before
 * the question that follows a Stop; read the result with modelReloadResult(). The time is the model card's own (performance.now()).
 */
export async function watchModelReload(page) {
  await page.evaluate(() => {
    const w = globalThis;
    w.__reload = { loadingAt: null, readyAt: null, text: '' };
    const el = document.querySelector('[data-testid="model-status"]');
    const note = () => {
      const status = el?.getAttribute('data-status');
      if (status === 'loading' && w.__reload.loadingAt === null) {
        w.__reload.loadingAt = performance.now();
        w.__reload.text = el.textContent ?? '';
      }
      if (status === 'ready' && w.__reload.loadingAt !== null && w.__reload.readyAt === null)
        w.__reload.readyAt = performance.now();
    };
    new MutationObserver(note).observe(el, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    note();
  });
}

/** { sawLoading, text, ms }: ms is the time the card spent loading (null when it never did, or never became ready). */
export async function modelReloadResult(page) {
  const r = await page.evaluate(() => globalThis.__reload);
  return {
    sawLoading: r?.loadingAt !== null && r?.loadingAt !== undefined,
    text: r?.text ?? '',
    ms: r?.loadingAt != null && r?.readyAt != null ? Math.round(r.readyAt - r.loadingAt) : null,
  };
}

/** The runtime DevTools snapshot: counts, timings, memory and model events. */
export async function readEvents(page) {
  const text = await page.evaluate(
    () => globalThis.__airplanemodeDevtools?.snapshot() ?? '{"events":[]}',
  );
  return JSON.parse(text).events;
}

/** Stage timings of the most recent document: the last pipeline.stage event of each stage at or after `sinceTs`. */
export function stageTimings(events, sinceTs = 0) {
  const out = {};
  for (const e of events) {
    if (e.name === 'pipeline.stage' && e.ts >= sinceTs)
      out[e.attrs.stage] = { ms: e.durationMs ?? null, ...e.attrs };
  }
  return out;
}

/**
 * wasm_memory_peak_bytes: the sum of the engine workers' peaks (model.memory, one loadId per engine worker) and the analysis worker's peak
 * (pipeline.memory). Empty (null) when any of them is unavailable or missing: never estimated.
 */
export function wasmMemoryPeak(events) {
  const engine = new Map();
  let unavailable = false;
  for (const e of events) {
    if (e.name === 'model.memory') {
      if (e.attrs.measure !== 'wasm-memory' || typeof e.bytes !== 'number') unavailable = true;
      else engine.set(e.attrs.loadId, Math.max(engine.get(e.attrs.loadId) ?? 0, e.bytes));
    }
  }
  let analysis = null;
  for (const e of events) {
    if (e.name === 'pipeline.memory') {
      if (e.attrs.measure !== 'wasm-memory' || typeof e.bytes !== 'number') unavailable = true;
      else analysis = Math.max(analysis ?? 0, e.bytes);
    }
  }
  if (unavailable || engine.size === 0 || analysis === null) return null;
  return [...engine.values()].reduce((a, b) => a + b, 0) + analysis;
}

/** Samples the main-thread JS heap (Chrome started with --enable-precise-memory-info) until stopped; resolves with the peak. */
export function sampleJsHeap(page, intervalMs = 250) {
  let peak = null;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const v = await page
        .evaluate(() => performance.memory?.usedJSHeapSize ?? null)
        .catch(() => null);
      if (typeof v === 'number' && (peak === null || v > peak)) peak = v;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return { stop: async () => ((stopped = true), await loop, peak) };
}

export const startRss = (profileDir) => startRssSampler({ userDataDir: profileDir });

export async function storageUsage(page) {
  return page.evaluate(async () => (await navigator.storage.estimate()).usage ?? null);
}
export { mkdirSync };
