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
// wasm_memory_peak_bytes, process_rss_peak_bytes, storage_usage_bytes, requests_after_offline, model, backend, answer_ok, laptop_8gb, host_load_1m_start, host_load_1m_end (the two load columns are the 1-minute os.loadavg() at the start and end of the run).
// Three memory figures, each under its own name (TD-49): process_rss_peak_bytes (the peak summed size of the Chrome process tree: THE peak
// memory), js_heap_peak_bytes (main-thread JS heap) and wasm_memory_peak_bytes (the engine and analysis workers' WebAssembly memory, empty
// when any of them was not measurable). Nothing is estimated and no run is selected: every run is written.
// docs/benchmarks/e2e-questions.csv: date, machine, commit, run, restart, qid, answer_ok, correct_source_page, top_retrieved_page_ok,
// first_token_ms, total_ms, laptop_8gb. correct_source_page is true only when a CITED source names the expected page (a refused answer cites
// nothing, so it is false); top_retrieved_page_ok says whether the top-ranked retrieved passage is on the expected page (retrieval quality,
// TD-59). The last column of both files reads 'not measured on 8 GB' on every row (scripts/lib/bench-columns.mjs refuses to write a row
// without it); the columns and the writer live in that library so a test can pin them.
//
// Not measured on 8 GB: the figures are those of the machine named in each row. This script has never run on Windows; the first run there
// is the owner's (PLAN.md runbook step 5). If it fails, send back the console log, both CSVs even if partial, the Chrome version and the
// Task Manager reading (Details, chrome.exe, memory columns).
import { loadavg } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  csv,
  E2E_COLUMNS,
  hostLoad,
  LAPTOP_8GB,
  pageChecks,
  Q_COLUMNS,
} from './lib/bench-columns.mjs';
import * as h from './lib/e2e-harness.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const RUNS = Number(opt('--runs', '5'));
const PORT = Number(opt('--port', '4417'));
const HEADED = args.includes('--headed');
const CSV = resolve(process.env.DOCKIT_BENCH_CSV ?? join(h.ROOT, 'docs', 'benchmarks', 'e2e.csv'));
const QCSV = resolve(
  process.env.DOCKIT_BENCH_Q_CSV ?? join(h.ROOT, 'docs', 'benchmarks', 'e2e-questions.csv'),
);
const PDF = join(h.ROOT, 'test', 'fixtures', 'pdf', 'policy-3p.pdf');
const QUESTIONS = JSON.parse(
  readFileSync(join(h.ROOT, 'test', 'fixtures', 'questions.json'), 'utf8'),
);

if (!(RUNS >= 5)) {
  console.error('bench-e2e: --runs must be at least 5 (plus the restart run)');
  process.exit(2);
}

/** answer_ok: the answer holds the expected text (or, for the unanswerable question, the refusal phrase). */
const answerOk = (q, a) =>
  q.expectRefusal
    ? a.text.toLowerCase().includes(QUESTIONS.refusalPhrase.toLowerCase().replace(/\.$/, ''))
    : a.ok && a.text.toLowerCase().includes(String(q.expectContains).toLowerCase());
const rows = [];
const qrows = [];
const date = new Date().toISOString();
const machine = h.machineLabel();
const commit = h.gitCommit();
const profile = h.newProfileDir();
const srv = await h.startServer({ port: PORT });
console.log(`bench-e2e: ${machine}, commit ${commit}, serving ${srv.base}, profile ${profile}`);

async function runOne(session, run, restart) {
  const { page, ledger } = session;
  const loadStart = hostLoad(loadavg()[0]); // 1-minute load average, BUG-T1-S6-05
  const rss = h.startRss(profile);
  const heap = h.sampleJsHeap(page);
  const t0 = Date.now() - 1; // events carry epoch milliseconds
  const opened = await h.openPdf(page, PDF);
  if (!opened.ok) throw new Error(`run ${run}: the document was refused: ${opened.refusal}`);
  let q1;
  for (const q of QUESTIONS.questions) {
    const wall0 = Date.now();
    const a = await h.ask(page, q.question);
    const wallMs = Date.now() - wall0;
    const ok = answerOk(q, a);
    // TD-59: correct_source_page counts a CITED source only (a refusal cites nothing); retrieval is its own column
    const { correct_source_page: pageOk, top_retrieved_page_ok: topOk } = pageChecks(q, a);
    qrows.push({
      date,
      machine,
      commit,
      run,
      restart,
      qid: q.id,
      answer_ok: ok,
      correct_source_page: pageOk,
      top_retrieved_page_ok: topOk,
      first_token_ms: a.firstTokenMs,
      total_ms: a.totalMs,
      laptop_8gb: LAPTOP_8GB,
    });
    if (q.id === 'q1') q1 = { a, ok };
    console.log(
      `  [${new Date().toISOString().slice(11, 19)}] run ${run} ${q.id}: ${ok ? 'answer ok' : 'answer NOT ok'}${pageOk === '' ? '' : pageOk ? ', cited page ok' : ', cited page NOT ok'}${topOk === '' ? '' : topOk ? ', top-ranked ok' : ', top-ranked NOT ok'}, first token ${a.firstTokenMs} ms, total ${a.totalMs} ms`,
    );
  }
  const jsHeap = await heap.stop();
  const rssPeak = await rss.stop();
  const events = await h.readEvents(page);
  const mine = events.filter((e) => e.ts >= t0);
  const st = h.stageTimings(mine);
  const gen = [...mine].reverse().find((e) => e.name === 'pipeline.answer');
  const tput =
    (await page.getByTestId('throughput').count()) > 0
      ? await page.getByTestId('throughput').innerText()
      : '';
  const outTokens = Number(/(\d+) tokens/.exec(tput)?.[1] ?? NaN);
  const tps = Number(/at ([\d.]+) tokens per second/.exec(tput)?.[1] ?? NaN);
  rows.push({
    date,
    machine,
    chrome: await h.chromeVersion(page),
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
    first_token_ms: q1.a.firstTokenMs,
    total_ms: q1.a.totalMs,
    out_tokens: Number.isFinite(outTokens) ? outTokens : '',
    tokens_per_s: Number.isFinite(tps) ? tps : '',
    js_heap_peak_bytes: jsHeap ?? '',
    wasm_memory_peak_bytes: h.wasmMemoryPeak(mine) ?? '',
    process_rss_peak_bytes: rssPeak.peakBytes ?? '',
    storage_usage_bytes: (await h.storageUsage(page)) ?? '',
    requests_after_offline: ledger.since('offline').network.length,
    model: 'Qwen3-0.6B q8 + multilingual-e5-small q8',
    backend: gen ? 'transformers-js wasm (single-threaded)' : '',
    answer_ok: q1.ok,
    laptop_8gb: LAPTOP_8GB,
    host_load_1m_start: loadStart,
    host_load_1m_end: hostLoad(loadavg()[0]),
  });
  console.log(
    `run ${run}${restart ? ' (after a Chrome restart)' : ''}: q1 first token ${q1.a.firstTokenMs} ms, total ${q1.a.totalMs} ms, requests after offline ${rows.at(-1).requests_after_offline}, process RSS peak ${rssPeak.peakBytes ?? 'n/a'} bytes (${rssPeak.samples} samples)`,
  );
}

let session = await h.launch({ chromium }, { profileDir: profile, headless: !HEADED });
try {
  await h.waitReady(session.page, srv.base);
  const status = await session.page.getByTestId('model-status').getAttribute('data-status');
  if (status === 'absent') {
    console.log('bench-e2e: downloading the model (online, once)...');
    const d = await h.downloadModel(session.page);
    if (d.status !== 'cached')
      throw new Error(`the model download did not complete: ${d.status} ${d.refusal}`);
  }
  console.log('cache phase done');
  await h.goOffline(session.ctx);
  session.ledger.mark('offline');
  await session.page.reload();
  await session.page.waitForFunction(
    () => navigator.serviceWorker?.controller?.state === 'activated',
  );
  for (let i = 1; i <= RUNS; i++) await runOne(session, i, false);
  session.ledger.requireTargets({ page: 1, service_worker: 1, worker: 3 });
  await session.close();
  // a full Chrome restart on the same profile, offline from the first request
  session = await h.launch({ chromium }, { profileDir: profile, headless: !HEADED });
  await h.goOffline(session.ctx);
  session.ledger.mark('offline');
  await h.waitReady(session.page, srv.base);
  await runOne(session, RUNS + 1, true);
  session.ledger.requireTargets({ page: 1, service_worker: 1, worker: 3 });
} finally {
  await session.close().catch(() => undefined);
  await srv.close();
  for (const [file, cols, data] of [
    [CSV, E2E_COLUMNS, rows],
    [QCSV, Q_COLUMNS, qrows],
  ]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, csv(cols, data));
    console.log(`wrote ${data.length} rows to ${file}`);
  }
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
