// Shared by `npm run test:e2e` / `test:gate` (Playwright specs) and `npm run bench:e2e` (plain node, Windows-compatible): serving the built
// app under /dockit/, launching installed Chrome on a named profile, going offline, driving the page, and reading the events back through
// the runtime DevTools hook (window.__airplanemodeDevtools.snapshot()). No stub or test-double model is involved anywhere.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnvironmentLabel } from './bench-columns.mjs';
import { connectCdp } from './cdp-counter.mjs';
import { startRssSampler } from './proc-rss.mjs';
import { closeServer, serveStatic } from './static-server.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = join(ROOT, 'dist');
export const PREFIX = '/dockit/';

/**
 * The machine named in a benchmark row.
 *   a label given        the label, verbatim, after validateEnvironmentLabel (an emulated run: 'emulated: ...; not a laptop', never the word laptop
 *                        anywhere else, never an 8 GB figure)
 *   no label, ci false   '<cpu model> <N> GB' as before (a developer's own machine)
 *   no label, ci true    an error: a CI runner must never print a CPU string and a memory size a reader could take for a laptop
 * `ci` is passed in (scripts/bench-e2e.mjs reads GITHUB_ACTIONS once); this file reads no environment variable.
 */
export function machineLabel({ environment, ci = false } = {}) {
  if (environment !== undefined && environment !== '') return validateEnvironmentLabel(environment);
  if (ci) throw new Error('a CI runner needs an explicit --environment label');
  return `${os.cpus()[0]?.model.trim() ?? 'unknown cpu'} ${Math.round(os.totalmem() / 2 ** 30)} GB`;
}

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
 * The Chrome arguments of every harness launch: precise memory info, and the debugging port (picked by Chrome, bound to 127.0.0.1) only when the
 * request ledger is on. Nothing here weakens Chrome's sandbox or site isolation (test/bench-launch-args.test.ts).
 */
export const launchArgs = ({ watch = true } = {}) => [
  '--enable-precise-memory-info',
  ...(watch ? ['--remote-debugging-port=0'] : []),
];

/**
 * The options passed to Playwright's launchPersistentContext. `sandbox` true sets chromiumSandbox: Playwright adds Chrome's sandbox-off switch to every
 * launch unless it is true (probed 20 Nov 2026), so a run that must keep the sandbox (the Windows emulated run) asks for it; the local default stays off so
 * the committed macOS figures remain comparable with each other.
 */
export const launchOptions = ({ headless = true, watch = true, sandbox = false } = {}) => ({
  channel: 'chrome',
  headless,
  // Playwright waits 30 s for Chrome to start by default; the first start on a cold Windows VM (a sandboxed Chrome under a Job Object, first-run work, a scanner on
  // every file) is the one place that could exceed it, and a longer wait changes no figure: the benchmark clocks start after the page is ready
  timeout: 120_000,
  serviceWorkers: 'allow',
  chromiumSandbox: sandbox,
  args: launchArgs({ watch }),
});

/**
 * Launches installed Chrome (channel chrome, no download) on the profile, with precise memory info and a debugging port, and attaches the
 * CDP request ledger to every target. `watch` false skips the ledger.
 */
export async function launch(
  playwright,
  { profileDir, headless = true, watch = true, sandbox = false },
) {
  const ctx = await playwright.chromium.launchPersistentContext(
    profileDir,
    launchOptions({ headless, watch, sandbox }),
  );
  const cdp = watch ? await connectCdp(profileDir) : undefined;
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return {
    ctx,
    page,
    cdp,
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

/**
 * `guard` (scripts/lib/fail-fast.mjs, optional): every long wait of the next four functions races with it, so a crash or an out-of-memory ends the wait with
 * a BenchFailure within seconds instead of at the wait's own timeout.
 */
const raced = (guard, promise) => (guard ? guard.race(promise) : promise);

export async function waitReady(page, base, { timeout = 60000, guard } = {}) {
  await raced(guard, page.goto(base));
  await raced(
    guard,
    page.waitForFunction(() => navigator.serviceWorker?.controller?.state === 'activated', null, {
      timeout,
    }),
  );
  await raced(guard, page.getByTestId('model-status').waitFor({ timeout }));
  await raced(
    guard,
    page.waitForFunction(
      () =>
        document.querySelector('[data-testid="model-status"]')?.getAttribute('data-status') !==
        'unknown',
      null,
      { timeout },
    ),
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
export async function downloadModel(page, { timeout = 15 * 60000, guard } = {}) {
  await raced(guard, page.getByTestId('download-model').click());
  await raced(
    guard,
    page.waitForFunction(
      () => {
        const s = document
          .querySelector('[data-testid="model-status"]')
          ?.getAttribute('data-status');
        return (
          s === 'cached' ||
          s === 'ready' ||
          s === 'refused' ||
          document.querySelector('[data-testid="model-refusal"]') !== null
        );
      },
      null,
      { timeout },
    ),
  );
  const refusal = await textIfPresent(page, 'model-refusal');
  return { status: await page.getByTestId('model-status').getAttribute('data-status'), refusal };
}

/** Chooses a file and waits for the document card to show a result. */
export async function openPdf(page, file, { timeout = 5 * 60000, guard } = {}) {
  await raced(guard, page.setInputFiles('[data-testid="file-input"]', file));
  await raced(
    guard,
    page.waitForSelector('[data-testid="doc-summary"], [data-testid="doc-refusal"]', { timeout }),
  );
  const refusal = await textIfPresent(page, 'doc-refusal');
  const reason = await attrIfPresent(page, 'doc-refusal', 'data-reason');
  guard?.checkRefusal(reason);
  const summary = await textIfPresent(page, 'doc-summary');
  return { ok: refusal === '', refusal, reason, summary };
}

/** Types a question, asks, and waits for the answer or a refusal. */
export async function ask(page, question, { timeout = 10 * 60000, guard } = {}) {
  await raced(guard, page.getByTestId('question').fill(question));
  await raced(guard, page.getByTestId('ask').click());
  await raced(
    guard,
    page.waitForSelector('[data-testid="answer-block"], [data-testid="ask-refusal"]', { timeout }),
  );
  const refusal = await textIfPresent(page, 'ask-refusal');
  const reason = await attrIfPresent(page, 'ask-refusal', 'data-reason');
  guard?.checkRefusal(reason);
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
    // one span per load: B1 M1 loads the embedder and then the answer model for a question, each from the cached files
    w.__reload = { loadingAt: null, readyAt: null, text: '', spans: [], open: null };
    const el = document.querySelector('[data-testid="model-status"]');
    const note = () => {
      const status = el?.getAttribute('data-status');
      if (status === 'loading' && w.__reload.open === null) {
        w.__reload.open = performance.now();
        if (w.__reload.loadingAt === null) {
          w.__reload.loadingAt = w.__reload.open;
          w.__reload.text = el.textContent ?? '';
        }
      }
      if (status !== 'loading' && w.__reload.open !== null) {
        if (status === 'ready' || status === 'cached') {
          w.__reload.spans.push(performance.now() - w.__reload.open);
          if (status === 'ready' && w.__reload.readyAt === null)
            w.__reload.readyAt = performance.now();
        }
        w.__reload.open = null;
      }
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

/**
 * { sawLoading, text, ms, loads }: text is what the card said at the first load; ms is the total time the card spent loading, summed over
 * every load of the question (null when it never loaded); loads is how many loads there were (an embedder and an answer model per question).
 */
export async function modelReloadResult(page) {
  const r = await page.evaluate(() => globalThis.__reload);
  const spans = r?.spans ?? [];
  return {
    sawLoading: r?.loadingAt !== null && r?.loadingAt !== undefined,
    text: r?.text ?? '',
    ms: spans.length > 0 ? Math.round(spans.reduce((a, b) => a + b, 0)) : null,
    loads: spans.length,
  };
}

/**
 * Samples Target.getTargets every `intervalMs` (100 ms) and records how many dedicated worker targets exist at each sample (B1 M1: never
 * more than one engine at a time; every dockit worker, engine or analysis or pdf, is started from a blob bootstrap, so they cannot be told
 * apart by URL, and the stages are sequential, so the count over a whole run is the bound). stop() resolves with the samples.
 */
export function sampleWorkerTargets(cdp, { intervalMs = 100 } = {}) {
  const samples = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const r = await cdp.getTargets().catch(() => undefined);
      const infos = r?.targetInfos ?? [];
      samples.push({
        at: Date.now(),
        workers: infos.filter((t) => t.type === 'worker').length,
        serviceWorkers: infos.filter((t) => t.type === 'service_worker').length,
      });
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  })();
  return { stop: async () => ((stopped = true), await loop, samples) };
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
 * wasm_memory_peak_bytes: the most WebAssembly memory the workers held AT ONCE, from the events (model.memory carries a loadId and bytes, model.unload
 * ends a loadId, pipeline.memory is the analysis worker's peak). Sprint 5 added the peak of every engine to the analysis worker's, because they all lived
 * together. With one model at a time (a model.unload for every model.load, runtime spec 0.6.0) a sum over every load of a run would count 15 loads as if
 * they coexisted, so the engines are summed only while they are alive together; and the analysis worker, which ends before the next engine loads, is then
 * compared with them instead of added to them. A run with no model.unload at all is the Sprint 5 case and keeps its old figure. Empty (null) when any of
 * them is unavailable or missing: never estimated.
 */
export function wasmMemoryPeak(events) {
  const live = new Map();
  let enginePeak = 0;
  let sawEngine = false;
  let sawUnload = false;
  let unavailable = false;
  let analysis = null;
  for (const e of events) {
    if (e.name === 'model.memory') {
      if (e.attrs.measure !== 'wasm-memory' || typeof e.bytes !== 'number') unavailable = true;
      else {
        sawEngine = true;
        live.set(e.attrs.loadId, Math.max(live.get(e.attrs.loadId) ?? 0, e.bytes));
        enginePeak = Math.max(
          enginePeak,
          [...live.values()].reduce((a, b) => a + b, 0),
        );
      }
    } else if (e.name === 'model.unload') {
      sawUnload = true;
      live.delete(e.attrs.loadId);
    } else if (e.name === 'pipeline.memory') {
      if (e.attrs.measure !== 'wasm-memory' || typeof e.bytes !== 'number') unavailable = true;
      else analysis = Math.max(analysis ?? 0, e.bytes);
    }
  }
  if (unavailable || !sawEngine || analysis === null) return null;
  return sawUnload ? Math.max(enginePeak, analysis) : enginePeak + analysis;
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

/**
 * For createGuard({ pollOutOfMemory }): true once the app's own event log holds an out_of_memory reason (model.load, model.embed or pipeline.answer, backend
 * adapter R18). One cheap string search in the page first; the log is parsed only when the word is there.
 */
export const outOfMemoryPoll = (page) => () =>
  page.evaluate(() => {
    const text = globalThis.__airplanemodeDevtools?.snapshot();
    if (typeof text !== 'string' || !text.includes('out_of_memory')) return false;
    try {
      return JSON.parse(text).events.some((e) =>
        Object.values(e.attrs ?? {}).includes('out_of_memory'),
      );
    } catch {
      return false;
    }
  });

export async function storageUsage(page) {
  return page.evaluate(async () => (await navigator.storage.estimate()).usage ?? null);
}
export { mkdirSync };
