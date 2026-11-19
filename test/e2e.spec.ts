/**
 * The offline end-to-end proof (D5-08). Local-only: `npm run test:e2e`, after assembling the sibling builds and `npm run build`.
 *
 * The real model answers: no stub and no test double is used anywhere (the model.generate event names the engine, the model and the backend and is
 * saved to the log). The build under test is served under /dockit/ by a server that returns 404 for any other path. The model is downloaded online
 * ONCE; then the network is blocked (context.setOffline and a route that aborts everything, as backstops), and the AUTHORITATIVE counter is the CDP
 * Network.requestWillBeSent over every target (the page, the engine, pdf and analysis workers, the service worker), found with browser-level
 * Target.setAutoAttach. Service-worker cache hits are reported separately.
 */
import { expect, test } from 'playwright/test';
import * as playwright from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as h from '../scripts/lib/e2e-harness.mjs';
import {
  bombPdf,
  brokenXrefPdf,
  fontBombPdf,
  imageBombPdf,
  manyPagesPdf,
  oversizePdf,
} from './fixtures-large.ts';
import { assertWellAimed, breakJson, flipHashDigit } from './helpers/tamper.ts';

/** The plain-language refusal for a page cut short by a stream limit (BUG-T1-S5-09), pinned here as text, not imported from src. */
const UNPACK_LIMIT_MESSAGE =
  'A part of this PDF is larger than dockit will unpack, so it was not read.';
const FIX = join(import.meta.dirname, 'fixtures');
const pdf = (n: string) => join(FIX, 'pdf', n);
const Q = JSON.parse(readFileSync(join(FIX, 'questions.json'), 'utf8')) as {
  refusalPhrase: string;
  questions: {
    id: string;
    question: string;
    expectContains: string | null;
    expectPage: number | null;
    expectRefusal?: boolean;
  }[];
};
const OUT = join(import.meta.dirname, '..', 'test-results', 'e2e');
const PORT = 4431;

test.describe.configure({ mode: 'serial' });

let srv: Awaited<ReturnType<typeof h.startServer>>;
let profile: string;
let s: Awaited<ReturnType<typeof h.launch>>;
const scratch: string[] = [];

/** What a stage that uses the model would leave behind: model load events since `ts`. */
const modelEventsSince = async (ts: number) =>
  (await h.readEvents(s.page)).filter(
    (e) => e.ts >= ts && /^model\.(load|embed|generate)/.test(e.name),
  );

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  srv = await h.startServer({ port: PORT });
  profile = h.newProfileDir();
});
test.afterAll(async () => {
  await s?.close().catch(() => undefined);
  await srv?.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

async function spyBlobReads(page: import('playwright').Page) {
  await page.addInitScript(() => {
    const w = globalThis as unknown as {
      __abCalls: number;
      __workers: { name: string; terminated: boolean }[];
    };
    w.__abCalls = 0;
    w.__workers = [];
    const orig = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (this: Blob) {
      w.__abCalls++;
      return orig.call(this);
    };
    const W = globalThis.Worker;
    globalThis.Worker = class extends W {
      constructor(url: string | URL, o?: WorkerOptions) {
        super(url, o);
        const rec = { name: o?.name ?? '', terminated: false };
        w.__workers.push(rec);
        const t = this.terminate.bind(this);
        this.terminate = () => ((rec.terminated = true), t());
      }
    } as typeof Worker;
  });
}

test('online once: the model downloads and verifies, then the network is blocked', async () => {
  s = await h.launch(playwright, { profileDir: profile });
  await spyBlobReads(s.page);
  await h.waitReady(s.page, srv.base);
  await expect(s.page.getByTestId('capability-card')).toContainText('backendTier');
  const d = await h.downloadModel(s.page);
  console.log('cache phase done');
  expect(d).toMatchObject({ status: 'cached' });
  await h.goOffline(s.ctx);
  s.ledger.mark('offline');
  await s.page.reload();
  await s.page.waitForFunction(() => navigator.serviceWorker?.controller?.state === 'activated');
});

test('q1 over policy-3p.pdf: a real Qwen3-0.6B answer with 45, source page 2, and 0 requests attempted', async () => {
  const t0 = Date.now() - 1;
  const opened = await h.openPdf(s.page, pdf('policy-3p.pdf'));
  expect(opened.ok, opened.refusal).toBe(true);
  expect(opened.summary).toMatch(/3 pages, 3 passages indexed/);
  const q1 = Q.questions[0]!;
  const a = await h.ask(s.page, q1.question);
  expect(a.ok, a.refusal).toBe(true);
  expect(a.text).toContain('45');
  expect(a.sources.some((x) => x.pages === '2' || x.pages.includes('2'))).toBe(true);
  const net = s.ledger.since('offline');
  console.log(
    `requests after offline: network ${net.network.length}, service-worker hits ${net.swHits}, cache hits ${net.cacheHits}`,
  );
  expect(net.network, `a request was attempted: ${net.network.join(', ')}`).toEqual([]);
  // no stub and no test double: the generate event names the engine, the model and the backend, and the log keeps it
  const events = await h.readEvents(s.page);
  const gen = events.filter((e) => e.name === 'model.generate' && e.ts >= t0);
  expect(gen.length).toBeGreaterThan(0);
  expect(gen[0].attrs.adapter).toBe('transformers-js');
  writeFileSync(join(OUT, 'model-generate-event.json'), JSON.stringify(gen[0], null, 2));
  s.ledger.requireTargets({ page: 1, service_worker: 1, worker: 3 });
  expect(
    await s.page.evaluate(() => (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker),
  ).toBeUndefined();
});

test('the other six questions are recorded, not gated', async () => {
  const rows: unknown[] = [];
  for (const q of Q.questions.slice(1)) {
    const a = await h.ask(s.page, q.question);
    rows.push({ id: q.id, ok: a.ok, text: a.text.slice(0, 200), sources: a.sources });
    console.log(`${q.id}: ${a.ok ? a.text.replace(/\s+/g, ' ').slice(0, 100) : a.refusal}`);
  }
  writeFileSync(join(OUT, 'other-questions.json'), JSON.stringify(rows, null, 2));
  expect(s.ledger.since('offline').network).toEqual([]);
});

const GRACE_Q = Q.questions[0]!.question;
const LIST_Q = 'List every number that appears in the policy and what it means.';

/** After a Stop the engine worker is gone: the next answer must come from a re-load of the cached model, never from a download or a reload of the page. */
async function expectGraceAnswerAfterStop(label: string) {
  const markTs = Date.now() - 1;
  s.ledger.mark(label);
  await h.watchModelReload(s.page);
  const a = await h.ask(s.page, GRACE_Q);
  expect(a.ok, a.refusal).toBe(true); // never model_not_cached ('The model is not downloaded...') while the files are on the device
  expect(a.reason).toBeNull();
  expect(a.text).toContain('45');
  expect(a.sources.some((x) => x.pages === '2' || x.pages.includes('2'))).toBe(true);
  // one engine at a time (B1 M1): between two uses the files are on the device and nothing is loaded, so the card reads 'cached', not 'ready'
  expect(await s.page.getByTestId('model-status').getAttribute('data-status')).toBe('cached');
  // the card said so while it loaded: 'Loading the model again', not 'ready' and not 'not downloaded'
  const reload = await h.modelReloadResult(s.page);
  expect(reload.sawLoading).toBe(true);
  expect(reload.text).toContain('Loading the model again');
  expect(reload.ms).not.toBeNull();
  expect(reload.loads).toBe(2); // the embedder for the question, then the answer model
  console.log(
    `model loads for the question after Stop (${label}): ${reload.loads} loads, ${reload.ms} ms in all (Apple M5 Pro 48 GB, not measured on 8 GB)`,
  );
  writeFileSync(
    join(OUT, `reload-${label}.json`),
    JSON.stringify({ label, ms: reload.ms, loads: reload.loads, note: 'not measured on 8 GB' }),
  );
  const net = s.ledger.since('offline');
  expect(net.network, `a request was attempted: ${net.network.join(', ')}`).toEqual([]);
  expect(s.ledger.since(label).network).toEqual([]);
  // the model was loaded again (generator and embedder), from the cache: model.load events, and no download of any file
  const loads = (await h.readEvents(s.page)).filter(
    (e) => e.ts >= markTs && e.name === 'model.load',
  );
  expect(loads.length).toBeGreaterThanOrEqual(2);
  expect(await s.page.locator('table.events').innerText()).not.toMatch(/asset\.download/);
  expect(await s.page.locator('table.events').innerText()).toContain('manifest.verify.ok'); // the stored manifest was re-verified (S-OFF-1)
}

test('Stop while the answer streams, then the next question: re-loaded from the device, 45 on page 2, 0 requests, no download (BUG-T1-S5-R2-01)', async () => {
  test.setTimeout(10 * 60_000);
  const r = await h.askThenStop(s.page, LIST_Q, { when: 'streaming' });
  expect(r.refusal, r.refusal).toBe('');
  expect(r.stopped).toBe(false); // the first words were on screen: the partial answer is kept, as before
  expect(r.partial.trim().length).toBeGreaterThan(0);
  // S1-119: a Stop after the first token is logged as outcome 'aborted', with the first-token time, and is no failure
  const answered = (await h.readEvents(s.page)).filter((e) => e.name === 'pipeline.answer').at(-1);
  expect(answered.attrs).toMatchObject({ outcome: 'aborted', reason: '' });
  expect(typeof answered.attrs.firstTokenMs).toBe('number');
  await expectGraceAnswerAfterStop('after-stop-streaming');
  expect(r.modelStatus).toBe('cached'); // on the device, not loaded: the card no longer says 'ready' between the Stop and the next question
});

test('Stop within 1 s of Ask (before the first token) shows Stopped., then the next question answers with 45 and page 2 (BUG-T1-S5-R2-01, -02)', async () => {
  test.setTimeout(10 * 60_000);
  const r = await h.askThenStop(s.page, GRACE_Q, { when: 'prefill', afterMs: 800 });
  expect(r.stopped, JSON.stringify(r)).toBe(true);
  expect(r.stoppedText).toBe('Stopped.');
  expect(r.refusal).toBe(''); // never 'The answer failed.' and never data-reason corrupt
  expect(r.reason).toBeNull();
  expect(r.partial).toBe('');
  const ev = await h.readEvents(s.page);
  const gen = ev.filter((e) => e.name === 'pipeline.stage' && e.attrs.stage === 'generate').at(-1);
  expect(gen.attrs).toMatchObject({ outcome: 'skipped', reason: '' });
  // BUG-T1-S6-03: the answer event of a Stop before the first token is 'aborted' (event 0.1.5), never 'skipped'
  const ans = ev.filter((e) => e.name === 'pipeline.answer').at(-1);
  expect(ans.attrs).toMatchObject({ outcome: 'aborted', reason: '' });
  expect(ans.attrs.firstTokenMs ?? null).toBeNull();
  await expectGraceAnswerAfterStop('after-stop-prefill');
  expect(r.modelStatus).toBe('cached');
});

test('the analysis and pdf workers are gone after extraction: each stage ends its worker (B1 M3)', async () => {
  type Reg = { name: string; terminated: boolean };
  const regOf = (name: string): Promise<Reg[]> =>
    s.page.evaluate(
      (n: string) =>
        (globalThis as unknown as { __workers: Reg[] }).__workers.filter((w: Reg) => w.name === n),
      name,
    );
  const before = {
    analysis: (await regOf('dockit-analysis')).length,
    pdf: (await regOf('dockit-pdf')).length,
  };
  const opened = await h.openPdf(s.page, pdf('policy-3p.pdf'));
  expect(opened.ok, opened.refusal).toBe(true);
  const analysis = await regOf('dockit-analysis');
  const pdfs = await regOf('dockit-pdf');
  expect(analysis.length - before.analysis).toBe(2); // one for the triage, one for the gate: a worker lives for one call
  expect(pdfs.length - before.pdf).toBe(1);
  expect(analysis.every((w) => w.terminated)).toBe(true);
  expect(pdfs.every((w) => w.terminated)).toBe(true);
  // and the browser agrees: no analysis or pdf worker target is left over (only the engine workers of the last use, if any)
  expect(s.ledger.since('offline').network).toEqual([]);
});

test('a fresh pdf worker per document, terminated afterwards', async () => {
  const before = await s.page.evaluate(
    () =>
      (
        globalThis as unknown as { __workers: { name: string; terminated: boolean }[] }
      ).__workers.filter((w) => w.name === 'dockit-pdf').length,
  );
  await h.openPdf(s.page, pdf('policy-3p.pdf'));
  const workers = await s.page.evaluate(() =>
    (
      globalThis as unknown as { __workers: { name: string; terminated: boolean }[] }
    ).__workers.filter((w: { name: string }) => w.name === 'dockit-pdf'),
  );
  expect(workers.length).toBe(before + 1);
  expect(workers.every((w: { terminated: boolean }) => w.terminated)).toBe(true);
});

const refusalCases: [string, () => Promise<string>, string, RegExp][] = [
  ['scanned PDF', async () => pdf('scanned.pdf'), 'no_text_layer', /OCR is not yet supported/],
  // S1-107 (TD-85): the stream accounting runs first and cannot vouch for a damaged structure, so the reason stays corrupt and the sentence is the unchecked one
  [
    'corrupt PDF',
    async () => pdf('corrupt.pdf'),
    'corrupt',
    /structure could not be checked safely, so it was refused before it was opened/,
  ],
  ['encrypted PDF', async () => pdf('encrypted.pdf'), 'encrypted', /password-protected/],
  [
    '301-page PDF',
    async () => tmpFile('301.pdf', manyPagesPdf(301)),
    'too_many_pages',
    /more than 300 pages/,
  ],
];
function tmpFile(name: string, bytes: Buffer): string {
  const d = mkdtempSync(join(tmpdir(), 'dockit-e2e-'));
  scratch.push(d);
  const f = join(d, name);
  writeFileSync(f, bytes);
  return f;
}

for (const [name, file, reason, message] of refusalCases) {
  test(`refusal: ${name} shows its plain message, 0 requests and 0 model bytes used`, async () => {
    const t0 = Date.now() - 1;
    const r = await h.openPdf(s.page, await file());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
    expect(r.refusal).toMatch(message);
    expect(await modelEventsSince(t0), 'the model was touched by a refused document').toEqual([]);
    expect(s.ledger.since('offline').network).toEqual([]);
    await expect(s.page.getByTestId('file-input')).toBeEnabled();
  });
}

test('refusal: a file over 20 MiB is refused before it is read (arrayBuffer never called on it)', async () => {
  const before = await s.page.evaluate(
    () => (globalThis as unknown as { __abCalls: number }).__abCalls,
  );
  const r = await h.openPdf(s.page, tmpFile('big.pdf', oversizePdf()));
  expect(r.reason).toBe('too_large');
  expect(r.refusal).toMatch(/20 MiB/);
  expect(
    await s.page.evaluate(() => (globalThis as unknown as { __abCalls: number }).__abCalls),
  ).toBe(before);
  expect(s.ledger.since('offline').network).toEqual([]);
});

test('refusal: the 1.2 GiB content bomb is now refused as stream_limit, before pdf.js, in plain words, never as a scanned file, and the page stays usable (S1-107)', async () => {
  test.setTimeout(10 * 60_000);
  const t0 = Date.now() - 1;
  const r = await h.openPdf(s.page, tmpFile('bomb.pdf', await bombPdf()), { timeout: 5 * 60_000 });
  expect(r.ok, 'the bomb must not be accepted as a document').toBe(false);
  // S1-107: pagetriage's stream accounting counts the decoded bytes of the content stream and refuses it before pagetriage's own analysis or pdf.js
  // runs. Sprint 5 refused it as too_large from the structure report (UNPACK_LIMIT_MESSAGE); that route stays as a second line, this is the first.
  expect(r.reason).toBe('stream_limit');
  expect(r.refusal).toMatch(
    /^This PDF holds page content that unpacks to more than \d+ MiB, so it was refused before it was opened\.$/,
  );
  expect(r.refusal).not.toMatch(/scanned|OCR/);
  expect(r.refusal).not.toBe(UNPACK_LIMIT_MESSAGE);
  expect(await modelEventsSince(t0), 'the model was touched by a refused document').toEqual([]);
  expect(s.ledger.since('offline').network).toEqual([]);
  const again = await h.openPdf(s.page, pdf('policy-3p.pdf'));
  expect(again.ok, again.refusal).toBe(true);
});

// S1-107 (TD-70, TD-85): every bomb is refused before pdf.js starts: no pdf worker is created and no extract event is emitted. The peak of the
// Chrome process tree and the analysis worker's WebAssembly memory are measured for each and logged, against Sprint 5's 8,121 MiB for a 1 GiB font bomb.
const SPRINT5_FONT_BOMB_PEAK_MIB = 8121;
const bombCases: [string, () => Promise<Buffer>, string, RegExp][] = [
  [
    'font bomb (FontFile2, 1 GiB + 1 of zeros, Flate)',
    () => fontBombPdf(),
    'stream_limit',
    /^This PDF holds a font that unpacks to more than \d+ MiB, so it was refused before it was opened\.$/,
  ],
  [
    'image bomb (1 GiB + 1 of zeros, Flate, declared 32768 x 32768)',
    () => imageBombPdf(),
    'stream_limit',
    /^This PDF holds an image that unpacks to more than \d+ MiB, so it was refused before it was opened\.$/,
  ],
  [
    "a PDF with a broken cross-reference table (pdf.js opens it, pagetriage's parser cannot vouch for it)",
    async () => brokenXrefPdf(),
    'corrupt',
    /^This PDF's structure could not be checked safely, so it was refused before it was opened\.$/,
  ],
];
for (const [name, make, reason, message] of bombCases) {
  test(`S1-107: ${name} is refused before pdf.js starts: its plain sentence, no pdf worker, no extract event, no model, 0 requests; peaks logged`, async () => {
    test.setTimeout(10 * 60_000);
    const file = tmpFile('s1-107.pdf', await make());
    const pdfWorkers = () =>
      s.page.evaluate(
        () =>
          (globalThis as unknown as { __workers: { name: string }[] }).__workers.filter(
            (w: { name: string }) => w.name === 'dockit-pdf',
          ).length,
      );
    const before = await pdfWorkers();
    const t0 = Date.now() - 1;
    const rss = h.startRss(profile);
    await new Promise((r) => setTimeout(r, 1500)); // an idle baseline in the same session
    const idle = (await rss.stop()).peakBytes;
    const rss2 = h.startRss(profile);
    const heap = h.sampleJsHeap(s.page);
    const r = await h.openPdf(s.page, file, { timeout: 5 * 60_000 });
    await new Promise((res) => setTimeout(res, 500));
    const peak = (await rss2.stop()).peakBytes;
    const heapPeak = await heap.stop();
    expect(r.ok, 'the file must not be accepted as a document').toBe(false);
    expect(r.reason).toBe(reason);
    expect(r.refusal).toMatch(message);
    expect(await pdfWorkers(), 'pdf.js was started').toBe(before);
    const ev = (await h.readEvents(s.page)).filter((e) => e.ts >= t0);
    expect(
      ev
        .filter((e) => e.name === 'pipeline.stage')
        .map((e) => [e.attrs.stage, e.attrs.outcome, e.attrs.reason]),
    ).toEqual([
      ['read', 'ok', ''],
      ['triage', 'refused', reason],
    ]); // no extract stage at all
    expect(JSON.stringify(ev)).not.toMatch(/notes|unpacks to/i); // nothing the accounting wrote reaches an event
    expect(await modelEventsSince(t0), 'the model was touched by a refused document').toEqual([]);
    expect(s.ledger.since('offline').network).toEqual([]);
    const mem = ev.find((e) => e.name === 'pipeline.memory');
    const mib = (n: number | null | undefined) =>
      typeof n === 'number' ? Math.round(n / 1048576) : null;
    const line = {
      case: name,
      idleRssMiB: mib(idle),
      peakRssMiB: mib(peak),
      analysisWorkerWasmPeakMiB: mib(mem?.bytes),
      jsHeapPeakMiB: mib(heapPeak),
      sprint5FontBombPeakMiB: SPRINT5_FONT_BOMB_PEAK_MIB,
      note: 'Apple M5 Pro 48 GB, not measured on 8 GB',
    };
    console.log(`S1-107 peak: ${JSON.stringify(line)}`);
    writeFileSync(
      join(OUT, `s1-107-${reason}-${bombCases.findIndex((c) => c[0] === name)}.json`),
      JSON.stringify(line, null, 2),
    );
    // the page stays usable
    const again = await h.openPdf(s.page, pdf('policy-3p.pdf'));
    expect(again.ok, again.refusal).toBe(true);
  });
}

test('prompt injection: the answer holds only text nodes, no link annotation is rendered, 0 requests', async () => {
  const opened = await h.openPdf(s.page, pdf('injection.pdf'));
  expect(opened.ok, opened.refusal).toBe(true);
  const a = await h.ask(s.page, 'What is the deductible?');
  expect(a.ok, a.refusal).toBe(true);
  const block = s.page.getByTestId('ask-card');
  expect(await block.locator('a, img, iframe, svg, object, embed, script').count()).toBe(0);
  expect(await block.locator('[href], [src]').count()).toBe(0);
  const html = await s.page.content();
  expect(html).not.toContain('/URI');
  // the hostile text is shown as text (it is in the sources panel); no element anywhere carries it as an attribute
  expect(
    await s.page
      .locator('[href*="evil.example"], [src*="evil.example"], [action*="evil.example"]')
      .count(),
  ).toBe(0);
  expect(s.ledger.since('offline').network).toEqual([]);
});

test('Cache Storage holds only precache keys, and no event carries a file name, a question or an answer', async () => {
  const names = await s.page.evaluate(() => caches.keys());
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) expect(n.startsWith('dockit-precache-'), n).toBe(true);
  const keys = await s.page.evaluate(async () =>
    (
      await Promise.all(
        (await caches.keys()).map(async (n) =>
          (await (await caches.open(n)).keys()).map((r) => r.url),
        ),
      )
    ).flat(),
  );
  expect(keys.some((k: string) => /\.pdf|blob:|\/models\//.test(k))).toBe(false);
  const dump = JSON.stringify(await h.readEvents(s.page));
  for (const f of [
    'policy-3p',
    'injection.pdf',
    'What is the grace period',
    'grace period for the sample policy',
    '45 days',
    'PWNED',
    'deductible is 500',
  ])
    expect(dump, f).not.toContain(f);
});

test('a full Chrome restart on the same profile, offline: the stored manifest is re-verified and the answer holds 45 with source page 2', async () => {
  await s.close();
  s = await h.launch(playwright, { profileDir: profile });
  await h.goOffline(s.ctx);
  s.ledger.mark('offline');
  await h.waitReady(s.page, srv.base);
  const opened = await h.openPdf(s.page, pdf('policy-3p.pdf'));
  expect(opened.ok, opened.refusal).toBe(true);
  const a = await h.ask(s.page, Q.questions[0]!.question);
  expect(a.text).toContain('45');
  expect(a.sources.some((x) => x.pages.includes('2'))).toBe(true);
  // manifest.verify.ok is a log event, which the DevTools hook does not carry: read the page's own events table
  expect(await s.page.locator('table.events').innerText()).toContain('manifest.verify.ok');
  expect(s.ledger.since('offline').network).toEqual([]);
});

// ---- B1 (TD-66, TD-67, TD-84): one engine at a time, and the memory line ----------------------------------------------------------------

test('B1 M1: at every 100 ms sample over an ingest and two questions there is at most one worker target, and the embedder unloads before the answer model loads', async () => {
  test.setTimeout(10 * 60_000);
  const t0 = Date.now() - 1;
  const sampler = h.sampleWorkerTargets(s.cdp);
  const opened = await h.openPdf(s.page, pdf('policy-3p.pdf'));
  expect(opened.ok, opened.refusal).toBe(true);
  for (const q of Q.questions.slice(0, 2)) {
    const a = await h.ask(s.page, q.question);
    expect(a.ok, a.refusal).toBe(true);
  }
  const samples = await sampler.stop();
  expect(samples.length, 'the sampler ran').toBeGreaterThan(20);
  const most = Math.max(...samples.map((x) => x.workers));
  console.log(
    `worker targets sampled every 100 ms: ${samples.length} samples, at most ${most} at once`,
  );
  expect(
    most,
    'two engines (or an engine beside the analysis or pdf worker) were alive together',
  ).toBeLessThanOrEqual(1);
  // the events say the same: a model.unload for every model.load, and an engine is unloaded before the next one loads (model.unload, event 0.1.5)
  const ev = (await h.readEvents(s.page)).filter(
    (e) => e.ts >= t0 && (e.name === 'model.load' || e.name === 'model.unload'),
  );
  const live = new Set<string>();
  let maxLive = 0;
  for (const e of ev) {
    const id = String(e.attrs.loadId);
    if (e.name === 'model.load') live.add(id);
    else live.delete(id);
    maxLive = Math.max(maxLive, live.size);
  }
  expect(maxLive).toBe(1);
  expect(live.size, 'an engine is still loaded after the answer').toBe(0);
  const kinds = ev.map(
    (e) =>
      `${e.name === 'model.load' ? 'load' : 'unload'}:${String(e.attrs.model).startsWith('multilingual-e5') ? 'embedder' : 'generator'}`,
  );
  expect(kinds).toEqual([
    'load:embedder',
    'unload:embedder', // the ingest
    'load:embedder',
    'unload:embedder',
    'load:generator',
    'unload:generator', // question 1
    'load:embedder',
    'unload:embedder',
    'load:generator',
    'unload:generator', // question 2
  ]);
  expect(s.ledger.since('offline').network).toEqual([]);
});

/** A fresh Chrome session on the same profile (the models are cached), offline, with navigator.deviceMemory overridden. */
async function relaunchWithDeviceMemory(value: number | undefined) {
  await s.close();
  s = await h.launch(playwright, { profileDir: profile });
  await h.goOffline(s.ctx);
  await s.ctx.addInitScript(
    (v: number | undefined) =>
      Object.defineProperty(Navigator.prototype, 'deviceMemory', {
        get: () => v,
        configurable: true,
      }),
    value,
  );
  s.ledger.mark('offline');
  await h.waitReady(s.page, srv.base);
}

test('B1 M6: with deviceMemory overridden to 2 the card states the line and opening a PDF is refused in the exact words, with no model load phase and no request', async () => {
  await relaunchWithDeviceMemory(2);
  const card = s.page.getByTestId('capability-card');
  await expect(card).toContainText('This device reports 2 GB');
  await expect(card).toContainText('at least 4 GB');
  await expect(s.page.getByTestId('capability-verdict')).toHaveAttribute('data-verdict', 'below');
  const t0 = Date.now() - 1;
  const opened = await h.openPdf(s.page, pdf('policy-3p.pdf'));
  expect(opened.ok).toBe(false);
  expect(opened.reason).toBe('unsupported_profile');
  expect(opened.refusal).toBe(
    'This device reports 2 GB of memory to the browser; the answer model needs at least 4 GB. Nothing was loaded.',
  );
  const events = await h.readEvents(s.page);
  expect(
    events.filter(
      (e) => e.ts >= t0 && e.name === 'model.load.phase' && e.attrs.phase === 'acquire',
    ),
    'a model file was acquired below the line',
  ).toEqual([]);
  expect(await modelEventsSince(t0), 'the model was touched below the line').toEqual([]);
  expect(s.ledger.since('offline').network).toEqual([]);
  // the line is a usability guard read from the signed manifest, not a security control: the wording says so nowhere it should not, and never "free RAM"
  expect(await s.page.content()).not.toMatch(/free RAM/i);
});

test('B1 M6 (TD-84): a browser that does not report its memory is not below the line: the card says so in plain words and the model loads and answers', async () => {
  await relaunchWithDeviceMemory(undefined);
  await expect(s.page.getByTestId('capability-verdict')).toHaveAttribute('data-verdict', 'unknown');
  await expect(s.page.getByTestId('capability-verdict')).toHaveText(
    'This browser does not report its memory; the answer model may not fit.',
  );
  const opened = await h.openPdf(s.page, pdf('policy-3p.pdf'));
  expect(opened.ok, opened.refusal).toBe(true);
  const a = await h.ask(s.page, Q.questions[0]!.question);
  expect(a.ok, a.refusal).toBe(true);
  expect(a.text).toContain('45');
  expect(s.ledger.since('offline').network).toEqual([]);
});

test('B1 M6: at 8 GB reported the card shows the line as met, and the same document opens', async () => {
  await relaunchWithDeviceMemory(8);
  await expect(s.page.getByTestId('capability-verdict')).toHaveAttribute('data-verdict', 'meets');
  await expect(s.page.getByTestId('capability-verdict')).toContainText(
    'Memory line: the answer model needs a device that reports at least 4 GB to the browser. This device reports 8 GB',
  );
  const opened = await h.openPdf(s.page, pdf('policy-3p.pdf'));
  expect(opened.ok, opened.refusal).toBe(true);
});

/** The stored manifest bytes (IndexedDB 'dockit', store 'manifest', the one record), as a plain array. */
const readStoredManifest = (page: import('playwright').Page): Promise<number[]> =>
  page.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const open = indexedDB.open('dockit', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const cur = open.result
            .transaction('manifest', 'readonly')
            .objectStore('manifest')
            .openCursor();
          cur.onerror = () => reject(cur.error);
          cur.onsuccess = () =>
            cur.result
              ? resolve(Array.from(new Uint8Array(cur.result.value as Uint8Array)))
              : reject(new Error('no stored manifest'));
        };
      }),
  );
const writeStoredManifest = (page: import('playwright').Page, bytes: number[]): Promise<void> =>
  page.evaluate(
    (bs) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('dockit', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('manifest', 'readwrite');
          const store = tx.objectStore('manifest');
          const cur = store.openCursor();
          cur.onsuccess = () => cur.result?.update(new Uint8Array(bs));
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    bytes,
  );
async function reloadReady(page: import('playwright').Page) {
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker?.controller?.state === 'activated');
  await page.getByTestId('model-status').waitFor();
}

// ---- data at rest (BUG-S1-S5-01, S-REST-1) ----------------------------------------------------------------------------------------------

const LD = 'airplanemode-localdata/v1';
const docIdOf = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 32);

/** Every path under the origin's OPFS root, directories with a trailing '/'. */
const opfsPaths = (page: import('playwright').Page): Promise<string[]> =>
  page.evaluate(async () => {
    type Dir = {
      entries(): AsyncIterable<[string, { kind: string }]>;
    };
    const out: string[] = [];
    const walk = async (dir: Dir, prefix: string): Promise<void> => {
      for await (const [name, handle] of dir.entries()) {
        out.push(`${prefix}${name}${handle.kind === 'directory' ? '/' : ''}`);
        if (handle.kind === 'directory') await walk(handle as unknown as Dir, `${prefix}${name}/`);
      }
    };
    await walk((await navigator.storage.getDirectory()) as unknown as Dir, '');
    return out;
  });

/** The keys of the 'dockit.kept' key-value namespace, from its index file (an absent namespace has none). */
const keptKeys = (page: import('playwright').Page): Promise<string[]> =>
  page.evaluate(async (ld) => {
    try {
      let dir = await navigator.storage.getDirectory();
      for (const part of [...ld.split('/'), 'dockit.kept'])
        dir = await dir.getDirectoryHandle(part);
      const text = await (await (await dir.getFileHandle('keys.json')).getFile()).text();
      return Object.keys((JSON.parse(text) as { k: Record<string, unknown> }).k);
    } catch (e) {
      if ((e as Error).name === 'NotFoundError') return [];
      throw e;
    }
  }, LD);

const docDirName = (docId: string) => `__ld_doc.dockit.d${docId}`;
const filesOf = (paths: string[], docId: string) =>
  paths.filter((p) => p.startsWith(`${LD}/${docDirName(docId)}/`));

async function atRestIsGone(page: import('playwright').Page, docId: string) {
  // physically: the document namespace holds 0 files (or is gone), and the 'dockit.kept' row is gone
  await expect
    .poll(async () => filesOf(await opfsPaths(page), docId), { timeout: 15_000 })
    .toEqual([]);
  expect(await keptKeys(page)).not.toContain(docId);
}

test('data at rest, Keep on this device: the document is on disk, and Delete followed by a reload leaves 0 files, no kept row and an empty kept list', async () => {
  const file = pdf('policy-3p.pdf');
  const docId = docIdOf(file);
  await s.page.getByTestId('keep-on-device').check();
  const opened = await h.openPdf(s.page, file);
  expect(opened.ok, opened.refusal).toBe(true);
  await expect(s.page.getByTestId('keep-warning')).toContainText('Stored unencrypted');
  // it is really stored: files under the per-document namespace, and a row in 'dockit.kept'
  const before = await opfsPaths(s.page);
  expect(
    filesOf(before, docId).length,
    'the kept document has files under its own namespace',
  ).toBeGreaterThan(0);
  expect(await keptKeys(s.page)).toContain(docId);
  // a question is answered from the kept document (queryChunks runs on the persistent store)
  const a = await h.ask(s.page, Q.questions[0]!.question);
  expect(a.ok, a.refusal).toBe(true);
  // Delete, then a reload
  await s.page.getByTestId('delete-document').click();
  await atRestIsGone(s.page, docId);
  await reloadReady(s.page);
  await atRestIsGone(s.page, docId);
  // listKept() is empty: the page lists nothing as kept, and there is no document to ask about (so no queryChunks can reach one)
  await expect(s.page.getByTestId('kept-list')).toHaveCount(0);
  await expect(s.page.getByTestId('doc-info')).toHaveCount(0);
  expect(await opfsPaths(s.page)).not.toContainEqual(expect.stringContaining(docDirName(docId)));
  expect(s.ledger.since('offline').network).toEqual([]);
});

test('data at rest, Keep on this device: Delete from the kept list after a reload removes it the same way', async () => {
  const file = pdf('policy-3p.pdf');
  const docId = docIdOf(file);
  await s.page.getByTestId('keep-on-device').check();
  const opened = await h.openPdf(s.page, file);
  expect(opened.ok, opened.refusal).toBe(true);
  await reloadReady(s.page);
  // the kept document survives the reload and is listed
  await expect(s.page.getByTestId('kept-list')).toBeVisible();
  expect(filesOf(await opfsPaths(s.page), docId).length).toBeGreaterThan(0);
  await s.page.getByTestId('delete-kept-0').click();
  await atRestIsGone(s.page, docId);
  await reloadReady(s.page);
  await atRestIsGone(s.page, docId);
  await expect(s.page.getByTestId('kept-list')).toHaveCount(0);
});

test('data at rest, memory only (the default): after a reload OPFS and IndexedDB hold no document namespace, and the IndexedDB database dockit holds only the manifest store', async () => {
  const file = pdf('policy-3p.pdf');
  const docId = docIdOf(file);
  await s.page.getByTestId('keep-on-device').uncheck();
  const opened = await h.openPdf(s.page, file);
  expect(opened.ok, opened.refusal).toBe(true);
  const a = await h.ask(s.page, Q.questions[0]!.question);
  expect(a.ok, a.refusal).toBe(true);
  await reloadReady(s.page);
  const paths = await opfsPaths(s.page);
  expect(
    paths.filter((p) => p.includes('__ld_doc.')),
    'a document namespace on disk',
  ).toEqual([]);
  expect(
    paths.filter((p) => p.includes('dockit.d')),
    'a dockit.d<docId> namespace on disk',
  ).toEqual([]);
  expect(
    paths.filter((p) => p.includes(docId)),
    'the document id on disk',
  ).toEqual([]);
  expect(await keptKeys(s.page)).toEqual([]);
  const idb = await s.page.evaluate(async () => {
    const dbs = (await indexedDB.databases()).map((d) => d.name ?? '');
    const stores = await new Promise<string[]>((resolve, reject) => {
      const open = indexedDB.open('dockit');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const names = Array.from(open.result.objectStoreNames);
        open.result.close();
        resolve(names);
      };
    });
    return { dbs, stores };
  });
  expect(
    idb.dbs.filter((n: string) => /ld_doc|dockit\.d|localdata|chunk|document/i.test(n)),
  ).toEqual([]);
  expect(idb.stores).toEqual(['manifest']);
  expect(JSON.stringify(idb.dbs)).not.toContain(docId);
});

test('tampered stored manifest bytes (one hash digit): no_valid_signature, shown as manifest_refused, and 0 model bytes reach the engine (S-OFF-1)', async () => {
  const original = await readStoredManifest(s.page);
  // BUG-T1-S5-02: aimed with a whitespace-tolerant lookup and asserted: one hex digit of a sha256 value, still valid JSON
  const flip = flipHashDigit(Uint8Array.from(original));
  assertWellAimed(Uint8Array.from(original), flip.bytes);
  await writeStoredManifest(s.page, Array.from(flip.bytes));
  try {
    await reloadReady(s.page);
    const t0 = Date.now() - 1;
    const opened = await h.openPdf(s.page, pdf('policy-3p.pdf'));
    expect(opened.ok).toBe(false);
    expect(opened.reason).toBe('manifest_refused');
    // the refusal is the signature check, not the JSON parser
    await expect(s.page.getByTestId('doc-refusal-detail')).toHaveText('Reason: no_valid_signature');
    await expect(s.page.getByTestId('doc-refusal-message')).toContainText('no_valid_signature');
    expect(await modelEventsSince(t0)).toEqual([]);
    expect(s.ledger.since('offline').network).toEqual([]);
  } finally {
    await writeStoredManifest(s.page, original);
  }
});

test('a stored manifest that no longer parses (the explicit parse-failure case): manifest_refused with reason parse, 0 model bytes', async () => {
  const original = await readStoredManifest(s.page);
  const broken = breakJson(Uint8Array.from(original));
  expect(() => JSON.parse(new TextDecoder().decode(broken))).toThrow();
  await writeStoredManifest(s.page, Array.from(broken));
  try {
    await reloadReady(s.page);
    const t0 = Date.now() - 1;
    const opened = await h.openPdf(s.page, pdf('policy-3p.pdf'));
    expect(opened.ok).toBe(false);
    expect(opened.reason).toBe('manifest_refused');
    await expect(s.page.getByTestId('doc-refusal-detail')).toHaveText('Reason: parse');
    expect(await modelEventsSince(t0)).toEqual([]);
  } finally {
    await writeStoredManifest(s.page, original);
  }
});

test('a tampered model manifest from the server (one hash digit): no_valid_signature, and no model file is requested', async () => {
  const p2 = h.newProfileDir();
  const s2 = await h.launch(playwright, { profileDir: p2, watch: false });
  try {
    await s2.ctx.route('**/models/manifest.json', async (route: import('playwright').Route) => {
      const res = await route.fetch();
      const original = new Uint8Array(await res.body());
      const flip = flipHashDigit(original);
      assertWellAimed(original, flip.bytes);
      await route.fulfill({ response: res, body: Buffer.from(flip.bytes) });
    });
    const before = srv.requests.length;
    await h.waitReady(s2.page, srv.base);
    const d = await h.downloadModel(s2.page, { timeout: 120_000 });
    expect(d.status).toBe('refused');
    expect(d.refusal).toMatch(/refused/);
    expect(
      d.refusal,
      'a refusal for the wrong reason (parse) does not prove the signature check',
    ).toMatch(/no_valid_signature/);
    expect(d.refusal).not.toMatch(/not valid JSON/);
    const asked = srv.requests
      .slice(before)
      .filter((r) => /\/models\/(?!manifest\.json)/.test(r.path));
    expect(asked, 'a model file was requested after the manifest was refused').toEqual([]);
  } finally {
    await s2.close();
  }
});

test('the model missing while offline (a fresh profile that never downloaded it): model_not_cached', async () => {
  const p3 = h.newProfileDir();
  const s3 = await h.launch(playwright, { profileDir: p3, watch: false });
  try {
    await h.waitReady(s3.page, srv.base); // the app is cached, the model is not
    await h.goOffline(s3.ctx);
    const r = await h.openPdf(s3.page, pdf('policy-3p.pdf'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('model_not_cached');
    expect(r.refusal).toContain(
      'The model is not downloaded on this device. Connect once and press Download.',
    );
  } finally {
    await s3.close();
  }
});

test('a worker started from a blob inherits the page CSP: eval inside it is blocked, and every worker of the page starts with 0 CSP or Trusted Types violations', async () => {
  const p4 = h.newProfileDir();
  const s4 = await h.launch(playwright, { profileDir: p4, watch: false });
  try {
    const violations: string[] = [];
    await s4.page.addInitScript(() => {
      (globalThis as unknown as { __v: string[] }).__v = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        (globalThis as unknown as { __v: string[] }).__v.push(
          `${e.violatedDirective}|${e.blockedURI}`,
        ),
      );
    });
    await h.waitReady(s4.page, srv.base);
    // a fresh page has created none of the worker policies yet: the test makes 'dockit-workers' itself (the CSP names it) and starts a worker from a blob like the runtime's bootstrap does
    const result = await s4.page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const tt = (
            globalThis as unknown as {
              trustedTypes: {
                createPolicy(
                  n: string,
                  r: { createScriptURL(s: string): string },
                ): { createScriptURL(s: string): string };
              };
            }
          ).trustedTypes;
          const policy = tt.createPolicy('dockit-workers', { createScriptURL: (s) => s });
          const blob = new Blob(
            ['try { eval("1+1"); postMessage("eval ran"); } catch (e) { postMessage(e.name); }'],
            { type: 'text/javascript' },
          );
          const url = URL.createObjectURL(blob);
          const w = new Worker(policy.createScriptURL(url) as unknown as string, {
            type: 'module',
          });
          w.onmessage = (m) => resolve(String(m.data));
          w.onerror = () => resolve('worker error');
        }),
    );
    expect(result).toBe('EvalError');
    // a string where a Trusted Types value is required is refused in the page itself
    const refused = await s4.page.evaluate(() => {
      try {
        new Worker('/dockit/app/analysis-worker.js', { type: 'module' });
        return 'started';
      } catch (e) {
        return (e as Error).name;
      }
    });
    expect(refused).toBe('TypeError');
    violations.push(
      ...(await s4.page.evaluate(() => (globalThis as unknown as { __v: string[] }).__v)),
    );
    // the eval attempt and the string worker are the two violations this test caused on purpose
    expect(violations.filter((v) => !/script-src|require-trusted-types-for/.test(v))).toEqual([]);
  } finally {
    await s4.close();
  }
});
