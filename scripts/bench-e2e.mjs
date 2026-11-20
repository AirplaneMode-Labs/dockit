#!/usr/bin/env node
// End-to-end benchmark of the real pipeline in installed Chrome: PDF to pagetriage to text extraction to the glyphsift gate to localdata
// chunks and vectors to Qwen3-0.6B's answer, with the network blocked after the assets are cached.
//
//   npm run build                       (after node scripts/assemble-deps.mjs --siblings ..)
//   npm run bench:e2e                   at least 5 runs in one Chrome session, then 1 run after a full Chrome restart on the same profile
//   $env:DOCKIT_BENCH_CSV="$PWD\e2e-8gb.csv"; $env:DOCKIT_BENCH_Q_CSV="$PWD\e2e-questions-8gb.csv"; npm run bench:e2e   (PowerShell)
//
// It prints 'cache phase done' once the model is downloaded and verified, THEN goes offline: turn Wi-Fi off at that line if you want the
// real thing; the script also blocks the network itself (context.setOffline, a route that aborts everything), and the authoritative count
// of requests after that point is the CDP Network.requestWillBeSent counter over every target (page, workers, service worker).
//
// Columns of docs/benchmarks/e2e.csv (or $DOCKIT_BENCH_CSV): date, machine, chrome, commit, run, restart, pdf, pages, chunks, held,
// triage_ms, extract_ms, gate_ms, embed_ms, index_ms, retrieve_ms, first_token_ms, total_ms, out_tokens, tokens_per_s, js_heap_peak_bytes,
// wasm_memory_peak_bytes, process_rss_peak_bytes, storage_usage_bytes, requests_after_offline, model, backend, answer_ok, laptop_8gb, host_load_1m_start, host_load_1m_end (the two load columns are the 1-minute os.loadavg() at the start and end of the run; empty on Windows, where the figure does not exist).
// Three memory figures, each under its own name (TD-49): process_rss_peak_bytes (the peak summed size of the Chrome process tree: THE peak
// memory), js_heap_peak_bytes (main-thread JS heap) and wasm_memory_peak_bytes (the engine and analysis workers' WebAssembly memory, empty
// when any of them was not measurable). Nothing is estimated and no run is selected: every run is written.
// docs/benchmarks/e2e-questions.csv: date, machine, commit, run, restart, qid, answer_ok, correct_source_page, top_retrieved_page_ok,
// first_token_ms, total_ms, laptop_8gb. correct_source_page is true only when a CITED source names the expected page (a refused answer cites
// nothing, so it is false); top_retrieved_page_ok says whether the top-ranked retrieved passage is on the expected page (retrieval quality,
// TD-59). The last column of both files reads 'not measured on 8 GB' on every row (scripts/lib/bench-columns.mjs refuses to write a row
// without it); the columns and the writer live in that library so a test can pin them.
//
// An EMULATED run (B6, TD-113): --environment "emulated: <what was run>; not a laptop" names the machine in every row (scripts/lib/bench-columns.mjs
// validates the label: never the word laptop outside its suffix, never an 8 GB figure), adds the emulated columns, keeps Chrome's sandbox on, and writes
// docs/benchmarks/e2e-emulated-win-vm.csv and e2e-emulated-win-vm-questions.csv (or $DOCKIT_BENCH_CSV / $DOCKIT_BENCH_Q_CSV, never the laptop CSVs). On a CI
// runner (the Actions flag, read once below) the label is mandatory. This is what scripts/win/run-capped.ps1 runs inside a Windows Job Object. laptop_8gb
// still reads 'not measured on 8 GB' on every row: an emulated figure is never a laptop figure.
//
// A crash or an out-of-memory fails the run within seconds with a reason (renderer_crash, browser_disconnected, worker_crash, out_of_memory): the rows
// written so far are kept, the failing run gets a row whose failure_reason (emulated CSVs) names it, and the exit code is 1.
//
// --dist <dir> serves another build than dist/ (the Windows workflow downloads one); --port, --runs and --headed are as before.
//
// Not measured on 8 GB: the figures are those of the machine named in each row. If this fails on the owner's laptop, send back the console log, both CSVs
// even if partial, the Chrome version and the Task Manager reading (Details, chrome.exe, memory columns).
import { loadavg } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  csv,
  E2E_COLUMNS,
  E2E_EMULATED_COLUMNS,
  EMULATED_E2E_FILE,
  EMULATED_Q_FILE,
  hostLoadCell,
  LAPTOP_8GB,
  pageChecks,
  Q_COLUMNS,
  Q_EMULATED_COLUMNS,
  runZeroRows,
} from './lib/bench-columns.mjs';
import * as h from './lib/e2e-harness.mjs';
import { BenchFailure, createGuard } from './lib/fail-fast.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const RUNS = Number(opt('--runs', '5'));
const PORT = Number(opt('--port', '4417'));
const HEADED = args.includes('--headed');
const DIST = resolve(opt('--dist', h.DIST));
const EMULATED = args.includes('--environment');
const ENVIRONMENT = opt('--environment', undefined);
// the only reads of the runner environment in this script (the two CI flags, BUG-T1-S7-09): passed to machineLabel, never read by the harness
const CI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
const LAPTOP_CSV = join(h.ROOT, 'docs', 'benchmarks', 'e2e.csv');
const LAPTOP_QCSV = join(h.ROOT, 'docs', 'benchmarks', 'e2e-questions.csv');
const CSV = resolve(
  process.env.DOCKIT_BENCH_CSV ??
    (EMULATED ? join(h.ROOT, 'docs', 'benchmarks', EMULATED_E2E_FILE) : LAPTOP_CSV),
);
const QCSV = resolve(
  process.env.DOCKIT_BENCH_Q_CSV ??
    (EMULATED ? join(h.ROOT, 'docs', 'benchmarks', EMULATED_Q_FILE) : LAPTOP_QCSV),
);
const PDF = join(h.ROOT, 'test', 'fixtures', 'pdf', 'policy-3p.pdf');
const QUESTIONS = JSON.parse(
  readFileSync(join(h.ROOT, 'test', 'fixtures', 'questions.json'), 'utf8'),
);

const usage = (message) => {
  console.error(`bench-e2e: ${message}`);
  process.exit(2);
};
if (!(RUNS >= 5)) usage('--runs must be at least 5 (plus the restart run)');
if (EMULATED && (ENVIRONMENT === undefined || ENVIRONMENT.startsWith('--')))
  usage('--environment needs a label');
let machine;
try {
  machine = h.machineLabel({ environment: ENVIRONMENT, ci: CI });
} catch (e) {
  usage(e.message);
}
// the same file however it is spelled: a Windows drive letter and a path are not case sensitive
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
if (EMULATED && (samePath(CSV, LAPTOP_CSV) || samePath(QCSV, LAPTOP_QCSV)))
  usage(
    'an emulated run never writes e2e.csv or e2e-questions.csv (use the emulated file names or another path)',
  );

/** answer_ok: the answer holds the expected text (or, for the unanswerable question, the refusal phrase). */
const answerOk = (q, a) =>
  q.expectRefusal
    ? a.text.toLowerCase().includes(QUESTIONS.refusalPhrase.toLowerCase().replace(/\.$/, ''))
    : a.ok && a.text.toLowerCase().includes(String(q.expectContains).toLowerCase());
const rows = [];
const qrows = [];
const date = new Date().toISOString();
const commit = h.gitCommit();
const profile = h.newProfileDir();
const srv = await h.startServer({ dist: DIST, port: PORT });
console.log(`bench-e2e: ${machine}, commit ${commit}, serving ${srv.base}, profile ${profile}`);

/** The fields only an emulated row has. The job_* figures are filled in from job-summary.json by scripts/bench-emulated-merge.mjs. */
const emulatedFields = (extra = {}) =>
  EMULATED
    ? {
        environment: machine,
        job_commit_limit_bytes: '',
        job_commit_peak_bytes: '',
        process_commit_peak_bytes: '',
        job_escapes: '',
        sampler_median_interval_ms: '',
        failure_reason: '',
        // the limit evidence: written empty here, filled from job-summary.json by scripts/bench-emulated-merge.mjs
        job_limit_readback_bytes: '',
        job_limit_flags_readback: '',
        limit_probe_refused: '',
        job_peak_after_probe_bytes: '',
        job_memory_limit_messages: '',
        control_leg: '',
        probe_memory_limit_messages: '',
        ...extra,
      }
    : {};

/** One row of the questions CSV: the one place that writes laptop_8gb for a question, for an answer and for a failed question alike. */
const questionRow = (run, restart, qid, figures, failureReason = '') => ({
  date,
  machine,
  commit,
  run,
  restart,
  qid,
  answer_ok: figures.answer_ok,
  correct_source_page: figures.correct_source_page,
  top_retrieved_page_ok: figures.top_retrieved_page_ok,
  first_token_ms: figures.first_token_ms,
  total_ms: figures.total_ms,
  laptop_8gb: LAPTOP_8GB,
  ...(EMULATED ? { environment: machine, failure_reason: failureReason } : {}),
});

/** A figure that may be unavailable (the page is gone after a crash): '' rather than a throw. */
const safe = async (fn, dflt = '') => {
  try {
    return (await fn()) ?? dflt;
  } catch {
    return dflt;
  }
};

/** One browser session and the guard that watches it. The guard is disposed before the session is closed on purpose. */
async function startSession() {
  const session = await h.launch(
    { chromium },
    { profileDir: profile, headless: !HEADED, sandbox: EMULATED },
  );
  const guard = createGuard({
    page: session.page,
    context: session.ctx,
    cdp: session.cdp,
    pollOutOfMemory: h.outOfMemoryPoll(session.page),
  });
  return {
    ...session,
    guard,
    async end() {
      guard.dispose();
      await session.close();
    },
  };
}

async function runOne(session, run, restart) {
  const { page, ledger, guard } = session;
  const loadStart = hostLoadCell(loadavg()[0]); // 1-minute load average, BUG-T1-S6-05
  const rss = h.startRss(profile);
  const heap = h.sampleJsHeap(page);
  const t0 = Date.now() - 1; // events carry epoch milliseconds
  let q1;
  let failure = null;
  let failedQid = '';
  try {
    const opened = await h.openPdf(page, PDF, { guard });
    if (!opened.ok) throw new Error(`run ${run}: the document was refused: ${opened.refusal}`);
    for (const q of QUESTIONS.questions) {
      failedQid = q.id;
      const wall0 = Date.now();
      const a = await h.ask(page, q.question, { guard });
      const wallMs = Date.now() - wall0;
      const ok = answerOk(q, a);
      // TD-59: correct_source_page counts a CITED source only (a refusal cites nothing); retrieval is its own column
      const { correct_source_page: pageOk, top_retrieved_page_ok: topOk } = pageChecks(q, a);
      qrows.push(
        questionRow(run, restart, q.id, {
          answer_ok: ok,
          correct_source_page: pageOk,
          top_retrieved_page_ok: topOk,
          first_token_ms: a.firstTokenMs,
          total_ms: a.totalMs,
        }),
      );
      if (q.id === 'q1') q1 = { a, ok };
      console.log(
        `  [${new Date().toISOString().slice(11, 19)}] run ${run} ${q.id}: ${ok ? 'answer ok' : 'answer NOT ok'}${pageOk === '' ? '' : pageOk ? ', cited page ok' : ', cited page NOT ok'}${topOk === '' ? '' : topOk ? ', top-ranked ok' : ', top-ranked NOT ok'}, first token ${a.firstTokenMs} ms, total ${a.totalMs} ms (wall ${wallMs} ms)`,
      );
    }
  } catch (e) {
    if (!(e instanceof BenchFailure)) {
      await heap.stop().catch(() => undefined);
      await rss.stop().catch(() => undefined);
      throw e;
    }
    failure = e;
    qrows.push(
      questionRow(
        run,
        restart,
        failedQid,
        {
          answer_ok: false,
          correct_source_page: '',
          top_retrieved_page_ok: '',
          first_token_ms: '',
          total_ms: '',
        },
        failure.reason,
      ),
    );
    console.error(
      `bench-e2e: run ${run}${failedQid ? ` ${failedQid}` : ''} FAILED: ${failure.message}`,
    );
  }
  const jsHeap = await safe(() => heap.stop(), null);
  const rssPeak = await rss.stop();
  const events = failure ? await safe(() => h.readEvents(page), []) : await h.readEvents(page);
  const mine = events.filter((e) => e.ts >= t0);
  const st = h.stageTimings(mine);
  const gen = [...mine].reverse().find((e) => e.name === 'pipeline.answer');
  const tput =
    !failure && (await page.getByTestId('throughput').count()) > 0
      ? await page.getByTestId('throughput').innerText()
      : '';
  const outTokens = Number(/(\d+) tokens/.exec(tput)?.[1] ?? NaN);
  const tps = Number(/at ([\d.]+) tokens per second/.exec(tput)?.[1] ?? NaN);
  rows.push({
    date,
    machine,
    chrome: await safe(() => h.chromeVersion(page)),
    commit,
    run,
    restart,
    pdf: 'policy-3p.pdf',
    pages: st.index?.pages ?? '',
    chunks: st.index?.chunks ?? '',
    held: st.index?.held ?? '',
    triage_ms: st.triage?.ms?.toFixed(1) ?? '',
    extract_ms: st.extract?.ms?.toFixed(1) ?? '',
    gate_ms: st.gate?.ms?.toFixed(1) ?? '',
    embed_ms: st.embed?.ms?.toFixed(1) ?? '',
    index_ms: st.index?.ms?.toFixed(1) ?? '',
    retrieve_ms: st.retrieve?.ms?.toFixed(1) ?? '',
    first_token_ms: q1?.a.firstTokenMs ?? '',
    total_ms: q1?.a.totalMs ?? '',
    out_tokens: Number.isFinite(outTokens) ? outTokens : '',
    tokens_per_s: Number.isFinite(tps) ? tps : '',
    js_heap_peak_bytes: jsHeap ?? '',
    wasm_memory_peak_bytes: failure ? '' : (h.wasmMemoryPeak(mine) ?? ''),
    process_rss_peak_bytes: rssPeak.peakBytes ?? '',
    storage_usage_bytes: failure ? '' : ((await h.storageUsage(page)) ?? ''),
    requests_after_offline: ledger.since('offline').network.length,
    model: 'Qwen3-0.6B q8 + multilingual-e5-small q8',
    backend: gen ? 'transformers-js wasm (single-threaded)' : '',
    answer_ok: q1?.ok ?? false,
    laptop_8gb: LAPTOP_8GB,
    host_load_1m_start: loadStart,
    host_load_1m_end: hostLoadCell(loadavg()[0]),
    ...emulatedFields({
      process_commit_peak_bytes: rssPeak.commitPeakBytes ?? '',
      // a whole number of milliseconds: the site importer takes integers only, and the median of an even count of ticks can end in .5
      sampler_median_interval_ms:
        rssPeak.medianIntervalMs === null ? '' : Math.round(rssPeak.medianIntervalMs),
      failure_reason: failure?.reason ?? '',
    }),
  });
  console.log(
    `run ${run}${restart ? ' (after a Chrome restart)' : ''}: q1 first token ${q1?.a.firstTokenMs ?? 'n/a'} ms, total ${q1?.a.totalMs ?? 'n/a'} ms, requests after offline ${rows.at(-1).requests_after_offline}, process RSS peak ${rssPeak.peakBytes ?? 'n/a'} bytes${rssPeak.commitPeakBytes === null ? '' : `, commit peak ${rssPeak.commitPeakBytes} bytes`} (${rssPeak.samples} samples${rssPeak.medianIntervalMs === null ? '' : `, median interval ${rssPeak.medianIntervalMs} ms`})`,
  );
  if (failure) throw failure;
}

let session = await startSession();
let benchFailure = null;
try {
  await h.waitReady(session.page, srv.base, { guard: session.guard });
  const status = await session.page.getByTestId('model-status').getAttribute('data-status');
  if (status === 'absent') {
    console.log('bench-e2e: downloading the model (online, once)...');
    const d = await h.downloadModel(session.page, { guard: session.guard });
    if (d.status !== 'cached')
      throw new Error(`the model download did not complete: ${d.status} ${d.refusal}`);
  }
  console.log('cache phase done');
  await h.goOffline(session.ctx);
  session.ledger.mark('offline');
  await session.guard.race(session.page.reload());
  await session.guard.race(
    session.page.waitForFunction(() => navigator.serviceWorker?.controller?.state === 'activated'),
  );
  for (let i = 1; i <= RUNS; i++) await runOne(session, i, false);
  session.ledger.requireTargets({ page: 1, service_worker: 1, worker: 3 });
  await session.end();
  // a full Chrome restart on the same profile, offline from the first request
  session = await startSession();
  await h.goOffline(session.ctx);
  session.ledger.mark('offline');
  await h.waitReady(session.page, srv.base, { guard: session.guard });
  await runOne(session, RUNS + 1, true);
  session.ledger.requireTargets({ page: 1, service_worker: 1, worker: 3 });
} catch (e) {
  if (!(e instanceof BenchFailure)) throw e;
  benchFailure = e;
} finally {
  await session.end().catch(() => undefined);
  await srv.close();
  // BUG-T1-S7-06: an emulated run that failed before its first run completed leaves one run-0 row with the reason, in both files
  if (EMULATED && benchFailure && rows.length === 0) {
    const z = runZeroRows({
      date,
      label: machine,
      commit,
      reason: benchFailure.reason,
      loadStart: hostLoadCell(loadavg()[0]),
      loadEnd: hostLoadCell(loadavg()[0]),
    });
    rows.push(z.e2e);
    qrows.push(z.q);
  }
  for (const [file, cols, data] of [
    [CSV, EMULATED ? E2E_EMULATED_COLUMNS : E2E_COLUMNS, rows],
    [QCSV, EMULATED ? Q_EMULATED_COLUMNS : Q_COLUMNS, qrows],
  ]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, csv(cols, data));
    console.log(`wrote ${data.length} rows to ${file}`);
  }
}
if (benchFailure) {
  console.error(`bench-e2e: FAILED (${benchFailure.reason}): ${benchFailure.message}`);
  // pending waits of the dead page are abandoned: leave now, with the CSVs written and a non-zero status
  process.exit(1);
}
const bad = rows.filter((r) => r.requests_after_offline !== 0);
if (bad.length) {
  console.error(`bench-e2e: ${bad.length} run(s) attempted a network request after going offline`);
  process.exit(1);
}
const n = qrows.filter((r) => r.answer_ok === true && r.correct_source_page === true).length;
const m = qrows.filter((r) => r.qid !== 'q7').length;
console.log(
  `question set: ${n} of ${m} answerable questions correct with the correct source page, over all ${rows.length} runs (not selected)`,
);
