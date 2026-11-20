#!/usr/bin/env node
// Rewrites the benchmark table between <!-- bench:start --> and <!-- bench:end --> in README.md from docs/benchmarks/e2e.csv and
// e2e-questions.csv, so no figure in the README is typed by hand.
//   node scripts/bench-readme.mjs           rewrite the block
//   node scripts/bench-readme.mjs --check   exit 1 unless the README holds exactly this block
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMULATED_E2E_FILE,
  EMULATED_HEADERS,
  EMULATED_Q_FILE,
  LAPTOP_8GB,
  LIMIT_PROOF_TEXT,
  PROBE_OVER_LIMIT_BYTES,
  limitMessages,
  limitProof,
  validateEnvironmentLabel,
} from './lib/bench-columns.mjs';
import { memoryFigures, memoryWords, parseCsv, TARGET } from './memory-figures.mjs';
import { statusLine } from './status-line.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(root, 'README.md');
const E2E = join(root, 'docs', 'benchmarks', 'e2e.csv');
const QCSV = join(root, 'docs', 'benchmarks', 'e2e-questions.csv');
// B1 (TD-77): the pair taken before the memory measures; the pair above is the after
const E2E_BASE = join(root, 'docs', 'benchmarks', 'e2e-s6-baseline.csv');
const QCSV_BASE = join(root, 'docs', 'benchmarks', 'e2e-questions-s6-baseline.csv');
export { TARGET };

export { parseCsv };
const num = (v) => (v === '' ? null : Number(v));
const med = (v) => {
  const a = v.filter((x) => x !== null).sort((x, y) => x - y);
  if (a.length === 0 || a.length !== v.length) return null;
  const m = a.length >> 1;
  return Math.round(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2);
};
const worst = (v) => (v.some((x) => x === null) ? null : Math.max(...v));
const f = (n) => (n === null ? 'not measured' : n.toLocaleString('en-US'));
const mib = (n) =>
  n === null ? 'not measured' : `${Math.round(n / 1048576).toLocaleString('en-US')} MiB`;
const pair = (rows, col, fmt) => {
  const v = rows.map((r) => num(r[col]));
  return `${fmt(med(v))} / ${fmt(worst(v))}`;
};

/** The README block for the two CSVs' text (read from docs/benchmarks/ when not given). Refuses a row whose laptop_8gb is not the phrase. */
export function table(
  e2eText = readFileSync(E2E, 'utf8'),
  questionsText = readFileSync(QCSV, 'utf8'),
  baseline = existsSync(E2E_BASE) && existsSync(QCSV_BASE)
    ? [readFileSync(E2E_BASE, 'utf8'), readFileSync(QCSV_BASE, 'utf8')]
    : undefined,
) {
  const e2e = parseCsv(e2eText);
  const qs = parseCsv(questionsText);
  for (const [name, rows] of [
    ['e2e.csv', e2e],
    ['e2e-questions.csv', qs],
  ]) {
    rows.forEach((r, i) => {
      if (r.laptop_8gb !== LAPTOP_8GB)
        throw new Error(`${name}: row ${i + 1}: laptop_8gb must read '${LAPTOP_8GB}'`);
    });
  }
  const keys = [...new Set(e2e.map((r) => `${r.machine}|${r.restart}`))];
  const out = [
    ...(baseline == null
      ? []
      : [memoryComparison(baseline[0], baseline[1], e2eText, questionsText)]),
    '| Machine | Run kind | Runs | Time to first token, ms (median / worst) | Total, ms (median / worst) | Peak memory: Chrome process tree (median / worst) | JS heap peak (median / worst) | Worker WebAssembly memory peak (median / worst) | Requests after offline | Command | Commit | 8 GB laptop |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const k of keys) {
    const rows = e2e.filter((r) => `${r.machine}|${r.restart}` === k);
    const r0 = rows[0];
    out.push(
      `| ${r0.machine} | ${r0.restart === 'true' ? 'after a Chrome restart' : 'one session'} | ${rows.length} | ${pair(rows, 'first_token_ms', f)} | ${pair(rows, 'total_ms', f)} | ${pair(rows, 'process_rss_peak_bytes', mib)} | ${pair(rows, 'js_heap_peak_bytes', mib)} | ${pair(rows, 'wasm_memory_peak_bytes', mib)} | ${Math.max(...rows.map((r) => Number(r.requests_after_offline)))} | \`npm run bench:e2e\` | \`${[...new Set(rows.map((r) => r.commit))].join(', ')}\` | ${LAPTOP_8GB} |`,
    );
  }
  const ok = (r) => r.answer_ok === 'true' && r.correct_source_page === 'true';
  const answerable = qs.filter((r) => r.correct_source_page !== '');
  const runs = [...new Set(qs.map((r) => Number(r.run)))].sort((a, b) => a - b);
  const first = answerable.filter((r) => Number(r.run) === runs[0]);
  const refused = qs.filter((r) => r.correct_source_page === '');
  // TD-59: a refused answer cites nothing, so it is never a correct source page; retrieval quality is counted on its own
  const cited = answerable.filter((r) => r.correct_source_page === 'true').length;
  const top = answerable.filter((r) => r.top_retrieved_page_ok === 'true').length;
  out.push(
    '',
    `Question set (seven fixed questions over a synthetic three-page policy, results not selected): ${first.filter(ok).length} of ${first.length} correct with the correct source page on the first run; ${answerable.filter(ok).length} of ${answerable.length} over all ${runs.length} runs; the question with no answer was refused in ${refused.filter((r) => r.answer_ok === 'true').length} of ${refused.length} runs.`,
    '',
    `Cited source page correct in ${cited} of ${answerable.length} answerable rows (a refused answer cites nothing, so it never counts). Top-ranked retrieved passage on the right page in ${top} of ${answerable.length} (retrieval quality, reported on its own).`,
  );
  return out.join('\n');
}

const checked = (name, rows) =>
  rows.forEach((r, i) => {
    if (r.laptop_8gb !== LAPTOP_8GB)
      throw new Error(`${name}: row ${i + 1}: laptop_8gb must read '${LAPTOP_8GB}'`);
  });

/** One set's figures for the comparison: the five-run session's peak, first token and total, and the question set and per-question times. */
function setFigures(e2eText, questionsText, name) {
  const e2e = parseCsv(e2eText);
  const qs = parseCsv(questionsText);
  checked(`${name}.csv`, e2e);
  checked(`${name}-questions.csv`, qs);
  const session = e2e.filter((r) => r.restart !== 'true');
  const ok = (r) => r.answer_ok === 'true' && r.correct_source_page === 'true';
  const answerable = qs.filter((r) => r.correct_source_page !== '');
  const runs = [...new Set(qs.map((r) => Number(r.run)))].sort((a, b) => a - b);
  const first = answerable.filter((r) => Number(r.run) === runs[0]);
  const rss = session.map((r) => num(r.process_rss_peak_bytes));
  return {
    runs: session.length,
    rss: {
      median: med(rss),
      worst: worst(rss),
      cells: pair(session, 'process_rss_peak_bytes', mib),
    },
    firstToken: pair(session, 'first_token_ms', f),
    total: pair(session, 'total_ms', f),
    perQuestionTotal: pair(qs, 'total_ms', f),
    perQuestionTotalMedian: med(qs.map((r) => num(r.total_ms))),
    questions: {
      first: [first.filter(ok).length, first.length],
      all: [answerable.filter(ok).length, answerable.length],
    },
    requests: Math.max(...e2e.map((r) => Number(r.requests_after_offline))),
    commit: [...new Set(session.map((r) => r.commit))].join(', '),
  };
}

/**
 * The before and after table (B1): the baseline pair against the after pair, each as the median and worst of its five-run session, and the outcome of
 * the TD-66 target computed from them. Worded "reached" or "missed" (never the done-when word), and read from the CSVs only.
 */
export function memoryComparison(baseE2e, baseQ, afterE2e, afterQ) {
  const b = setFigures(baseE2e, baseQ, 'e2e-s6-baseline');
  const a = setFigures(afterE2e, afterQ, 'e2e');
  const row = (label, x) =>
    `| ${label} | ${x.runs} | ${x.rss.cells} | ${x.firstToken} | ${x.total} | ${x.perQuestionTotal} | ${x.questions.first[0]} of ${x.questions.first[1]} first run, ${x.questions.all[0]} of ${x.questions.all[1]} over all runs | ${x.requests} | \`npm run bench:e2e\` | \`${x.commit}\` | ${LAPTOP_8GB} |`;
  // BUG-T1-S6-04: one rounding rule: the difference and the percentage come from the EXACT medians (scripts/memory-figures.mjs), then are rounded
  const fig = memoryFigures(baseE2e, baseQ, afterE2e, afterQ);
  const baseMib = Math.round(fig.before.rssMedianMiB);
  const afterMib = Math.round(fig.after.rssMedianMiB);
  const diff = fig.fallMiB;
  const pct = ((Math.abs(diff) / fig.before.rssMedianMiB) * 100).toFixed(1);
  const rssReached = a.rss.median / 1048576 <= TARGET.rssMedianMiB;
  const timeReached = a.perQuestionTotalMedian <= TARGET.totalMedianMs;
  const questionsOk =
    a.questions.first[0] >= TARGET.questionFirstRunMin &&
    a.questions.all[0] >= TARGET.questionAllMin;
  const n = (x) => x.toLocaleString('en-US');
  return [
    '**Memory hardening, before and after** (Sprint 6, TD-66 and TD-77; one model at a time, and the analysis and PDF workers ended as soon as their stage ends). Both sets were measured on the same machine with the same command; each row is the median and the worst of the five runs of one Chrome session, with none left out. The 8 GB column reads not measured on 8 GB in every row.',
    '',
    '| Run | Runs | Peak memory: Chrome process tree (median / worst) | Time to first token, ms (median / worst) | Total, first question, ms (median / worst) | Per-question total, every question of every run, ms (median / worst) | Question set | Requests after offline | Command | Commit | 8 GB laptop |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    row('Before: both models loaded together', b),
    row('After: one model at a time', a),
    '',
    `The target stated before measuring (TD-66) was a median peak of at most ${n(TARGET.rssMedianMiB)} MiB, the question set no worse than ${TARGET.questionAllMin} of 36 over all runs and ${TARGET.questionFirstRunMin} of 6 on the first run, and a median per-question total of at most ${n(TARGET.totalMedianMs)} ms. The median peak went from ${n(baseMib)} MiB to ${n(afterMib)} MiB, a ${diff >= 0 ? 'fall' : 'rise'} of ${n(Math.round(Math.abs(diff)))} MiB (${pct} percent). Each median is the median of the ${fig.after.runs} in-session runs; the run after a Chrome restart is a separate row and is not in it. Differences and percentages are computed from the exact medians (the exact fall is ${fig.fallMiB.toFixed(1)} MiB, shown as ${n(Math.round(fig.fallMiB))} MiB) and then rounded, so a difference can differ by 1 MiB from the subtraction of the two rounded medians. The target was ${rssReached ? 'reached' : 'missed'} for memory; the question set was ${questionsOk ? 'not worse than the floor' : 'worse than the floor'}; the time guard was ${timeReached ? 'reached' : 'missed'} (median per-question total ${n(a.perQuestionTotalMedian)} ms, against ${n(b.perQuestionTotalMedian)} ms before). Not measured on 8 GB.`,
    '',
  ].join('\n');
}

const MIB_N = 1048576;
const GIB_N = 1073741824;
const E2E_EMULATED = join(root, 'docs', 'benchmarks', EMULATED_E2E_FILE);
const E2E_EMULATED_Q = join(root, 'docs', 'benchmarks', EMULATED_Q_FILE);

/**
 * The README subsection for the emulated Windows run (B6, TD-113), generated from docs/benchmarks/e2e-emulated-win-vm.csv and from nothing else. It exists only when
 * that CSV does: with no text this returns '' and applyEmulated() leaves the README as it was. Every row's environment label is printed verbatim, and the
 * laptop_8gb cell is 'not measured on 8 GB' in every row (the CSV is refused otherwise).
 *
 * The CSV has either the current header (with the limit evidence: the read-back, the probe, the completion-port count, the control marker) or the one written before
 * the evidence existed (EMULATED_HEADERS); a column a file lacks reads as empty, which is 'limit unproven'. A capped leg is described as "limit proven in force (probe
 * refused, read-back equal)" only when both hold (limitProof, scripts/lib/bench-columns.mjs); a control leg (control_leg true) is reported as a control and is in none of
 * the figures: it is not in the table, not in a median, not in a peak. Whether commits were refused while the benchmark ran is limitMessages(): the job's memory-limit
 * messages over the run minus the one the probe caused. `questionsText` (docs/benchmarks/e2e-emulated-win-vm-questions.csv) gives each leg's question set; without it the
 * column reads not measured.
 */
export function emulatedBlock(text, questionsText) {
  if (text === undefined) return '';
  const head = text.split('\n')[0];
  if (!EMULATED_HEADERS.includes(head))
    throw new Error(`${EMULATED_E2E_FILE}: the header is not E2E_EMULATED_COLUMNS`);
  const rows = parseCsv(text);
  rows.forEach((r, i) => {
    if (r.laptop_8gb !== LAPTOP_8GB)
      throw new Error(`${EMULATED_E2E_FILE}: row ${i + 1}: laptop_8gb must read '${LAPTOP_8GB}'`);
    validateEnvironmentLabel(r.environment);
  });
  if (rows.length === 0) return '';
  const qrows = questionsText === undefined ? undefined : parseCsv(questionsText);
  qrows?.forEach((r, i) => {
    if (r.laptop_8gb !== LAPTOP_8GB)
      throw new Error(`${EMULATED_Q_FILE}: row ${i + 1}: laptop_8gb must read '${LAPTOP_8GB}'`);
  });
  /** One environment's question set: the answers that hold the expected text AND cite the right page, over every answerable row of every run; null with no question rows. */
  const questionSet = (env) => {
    const answerable = (qrows ?? []).filter(
      (x) => x.environment === env && x.correct_source_page !== '',
    );
    if (answerable.length === 0) return null;
    return {
      ok: answerable.filter((x) => x.answer_ok === 'true' && x.correct_source_page === 'true')
        .length,
      of: answerable.length,
    };
  };
  const envs = [...new Set(rows.map((r) => r.environment))];
  for (const env of envs) {
    const marks = new Set(
      rows.filter((x) => x.environment === env).map((x) => x.control_leg ?? ''),
    );
    if (marks.size > 1)
      throw new Error(`${EMULATED_E2E_FILE}: the rows of one environment disagree on control_leg`);
  }
  const controlOf = (env) => rows.find((x) => x.environment === env).control_leg === 'true';
  const legs = envs.filter((e) => !controlOf(e));
  const controls = envs.filter((e) => controlOf(e));
  const gibOf = (limit) => `${Number(limit) / GIB_N} GiB`;
  const count = (v) =>
    v === '' || v === undefined ? 'no port' : Number(v).toLocaleString('en-US');
  const hasEvidence = (r) =>
    ['job_limit_readback_bytes', 'job_limit_flags_readback', 'limit_probe_refused'].some(
      (c) => (r[c] ?? '') !== '',
    );
  const limitCell = (r, proof) =>
    proof === 'no_limit' && hasEvidence(r)
      ? 'no limit set (read-back: JobMemoryLimit 0)'
      : LIMIT_PROOF_TEXT[proof];

  const plural = (n, one, many) => (n === 1 ? one : many);
  /** The Commits refused while the benchmark ran cell: the leg's memory-limit messages after the probe's own is taken out (limitMessages). */
  const refusedCell = (r0, limit) => {
    if (limit === '') return 'not applicable (no limit)';
    const m = limitMessages(r0);
    if (m.total === null) return 'no port';
    if (m.benchmark === null) return 'not counted';
    return m.benchmark > 0
      ? `yes: ${m.benchmark} ${plural(m.benchmark, 'message', 'messages')} while the benchmark ran (the probe's ${m.probe} not counted)`
      : `none (the probe's ${m.probe} not counted)`;
  };
  const listOf = (items) =>
    items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

  const out = [
    '### Emulated Windows (not a laptop)',
    '',
    `Generated from \`docs/benchmarks/${EMULATED_E2E_FILE}\`, the result of the manual \`bench-windows\` workflow: the same \`bench:e2e\` on a GitHub-hosted Windows Server VM, with the pwsh, node and Chrome process tree inside a Windows Job Object whose commit limit is the cap of the leg (none, 8, 6 and 5 GiB). The job limit covers the pwsh, node and Chrome process tree, so the whole-tree peak counts pwsh and node as well as Chrome. A commit limit is not a physical-memory limit: the VM has more RAM than a laptop, nothing is paged under pressure, and a leg either fits or an allocation fails, and it does not model an 8 GB machine's operating system and other apps, an integrated GPU, thermal limits or its disk. These rows are never laptop rows and fill no 8 GB cell. The Sprint 5 done-when stays NOT met (owner runbook step 5).${controls.length > 0 ? ' A further control leg, whose limit is far below what the benchmark needs, must not complete; it is reported below as a control and is in none of the figures.' : ''}`,
  ];
  const readings = [];
  if (legs.length > 0) {
    out.push(
      '',
      '| Environment (verbatim) | Runs | Job commit limit | Limit in force | Commits refused while the benchmark ran | Peak commit, whole tree: pwsh, node and Chrome | Peak commit, Chrome only (median / worst) | Chrome processes outside the job | Time to first token, ms (median / worst) | Total, ms (median / worst) | Question set (cited page correct, all runs) | Result | Commit, Chrome | 8 GB laptop |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const env of legs) {
      const r = rows.filter((x) => x.environment === env);
      const session = r.filter((x) => x.restart !== 'true');
      const failure = r.map((x) => x.failure_reason).find((x) => x !== '');
      const limit = r[0].job_commit_limit_bytes;
      const proof = limitProof(r[0]);
      const peak = r.map((x) => num(x.job_commit_peak_bytes)).filter((x) => x !== null);
      const escapes = r.map((x) => num(x.job_escapes)).filter((x) => x !== null);
      const wholeTree = peak.length ? Math.max(...peak) : null;
      // a limit that the leg's own whole-tree peak is above (the job-wide commit limit is documented to refuse a commit beyond it)
      const above = limit !== '' && wholeTree !== null && wholeTree > Number(limit);
      const result = failure
        ? `fail: ${failure}`
        : session.length >= 5 && r.length > session.length
          ? 'pass'
          : 'incomplete';
      const aboveNote = !above
        ? ''
        : proof === 'proven'
          ? ' (whole-tree peak above a limit that is proven in force: the peak counts commits the limit refused)'
          : ' (whole-tree peak above the limit: not a result under this cap)';
      const qs = questionSet(env);
      readings.push({
        env,
        limit,
        proof,
        wholeTree,
        above,
        failed: failure !== undefined,
        afterProbe: num(r[0].job_peak_after_probe_bytes),
        messages: limitMessages(r[0]),
        passed: result === 'pass',
        runs: r.length,
        qs,
      });
      out.push(
        `| ${env} | ${r.length} | ${limit === '' ? 'no limit' : gibOf(limit)} | ${limitCell(r[0], proof)} | ${refusedCell(r[0], limit)} | ${mib(wholeTree)} | ${pair(r, 'process_commit_peak_bytes', mib)} | ${escapes.length ? Math.max(...escapes) : 'not measured'} | ${pair(r, 'first_token_ms', f)} | ${pair(r, 'total_ms', f)} | ${qs === null ? 'not measured' : `${qs.ok} of ${qs.of}`} | ${result}${aboveNote} | \`${[...new Set(r.map((x) => x.commit))].join(', ')}\`, ${[...new Set(r.map((x) => x.chrome).filter(Boolean))].join(', ')} | ${LAPTOP_8GB} |`,
      );
    }
  }

  // The evidence behind the Limit in force column: what the system said about the limit, and what happened to the commit above it. One line per leg that has any.
  const evidenceEnvs = envs.filter((e) => hasEvidence(rows.find((x) => x.environment === e)));
  if (evidenceEnvs.length > 0) {
    out.push(
      '',
      `| Limit evidence (leg) | Read-back: LimitFlags, JobMemoryLimit | Commit of the limit + ${mib(PROBE_OVER_LIMIT_BYTES)} from inside the job | Refused commit counted in PeakJobMemoryUsed? | PeakJobMemoryUsed right after the probe | JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages, whole run | of which caused by the probe | posted while the benchmark ran |`,
      '|---|---|---|---|---|---|---|---|',
    );
    for (const env of evidenceEnvs) {
      const r0 = rows.find((x) => x.environment === env);
      const limit = r0.job_commit_limit_bytes;
      const proof = limitProof(r0);
      const probe = r0.limit_probe_refused ?? '';
      const after = num(r0.job_peak_after_probe_bytes);
      const read =
        (r0.job_limit_flags_readback ?? '') === ''
          ? 'not read back'
          : `${r0.job_limit_flags_readback}, ${Number(r0.job_limit_readback_bytes).toLocaleString('en-US')} bytes (${proof === 'readback_mismatch' ? 'differs from what was set' : 'equal to what was set'})`;
      const probeText =
        probe === 'true'
          ? 'refused'
          : probe === 'false'
            ? 'succeeded: the cap was not in force'
            : limit === ''
              ? 'none: no limit is set'
              : 'inconclusive';
      const counted =
        probe !== 'true' || after === null || limit === ''
          ? 'not known'
          : after > Number(limit)
            ? `yes: ${mib(after)} is above the limit of ${mib(Number(limit))}`
            : `no: ${mib(after)} is below the limit of ${mib(Number(limit))}`;
      const m = limitMessages(r0);
      const probeShare =
        m.probe === null ? (limit === '' ? 'no probe' : 'not counted') : count(m.probe);
      out.push(
        `| ${limit === '' ? 'no limit' : gibOf(limit)}${controlOf(env) ? ' (control)' : ''} | ${read} | ${probeText} | ${counted} | ${after === null ? 'not measured' : mib(after)} | ${count(r0.job_memory_limit_messages)} | ${probeShare} | ${m.benchmark === null ? 'not known' : count(m.benchmark)} |`,
      );
    }
  }

  // Whether commits were refused while the benchmark ran, from the completion port's count after the probe's own message is taken out. Only a leg whose limit is proven in force
  // gets a sentence: a refusal counted under a limit nobody proved says nothing about the limit.
  const noLimitLeg = readings.find((x) => x.limit === '');
  const proven = readings.filter((x) => x.limit !== '' && x.proof === 'proven');
  for (const l of proven.filter((x) => x.messages.benchmark !== null && x.messages.benchmark > 0)) {
    const n = l.messages.benchmark;
    const same =
      l.qs === null || noLimitLeg?.qs == null
        ? ''
        : l.qs.ok === noLimitLeg.qs.ok && l.qs.of === noLimitLeg.qs.of
          ? " (the same as the no-limit leg's)"
          : ` (the no-limit leg's reads ${noLimitLeg.qs.ok} of ${noLimitLeg.qs.of})`;
    out.push(
      '',
      `**The ${gibOf(l.limit)} leg had commits refused while the benchmark ran${l.passed ? ', and the leg still finished' : ''}.** The job's completion port received ${n} JOB_OBJECT_MSG_JOB_MEMORY_LIMIT ${plural(n, 'message', 'messages')} while the benchmark ran, besides the ${l.messages.probe} the probe caused: each is the system's notice that a process in the job asked for a commit past the limit and was refused (the system does not guarantee delivery of these notices, so the count is a floor, not an exact number of refusals). The limit was proven in force before the benchmark started (probe refused, read-back equal), so these are refusals by a limit that was in force, not a limit that did nothing.${l.passed ? ` All ${l.runs} runs of the leg finished with no failure reason${l.qs === null ? '' : `, and its question set reads ${l.qs.ok} of ${l.qs.of} answers with the cited page correct${same}`}.` : ''}`,
    );
  }
  const quiet = proven.filter((x) => x.messages.benchmark === 0);
  if (quiet.length > 0)
    out.push(
      '',
      `**No commit was refused while the benchmark ran on the ${listOf(quiet.map((x) => gibOf(x.limit)))} ${plural(quiet.length, 'leg', 'legs')}.** The only memory-limit message the completion port received on ${quiet.length === 1 ? 'it' : 'each'} was the one the probe caused, so the port saw no refusal during the benchmark (the system does not guarantee delivery of these notices, so this is what the port saw, not a proof).`,
    );

  // What the legs do and do not show, in words, computed from the rows (nothing here is typed from a result).
  for (const l of readings.filter((x) => x.limit !== '' && x.proof === 'not_enforced')) {
    const gib = gibOf(l.limit);
    out.push(
      '',
      `**The ${gib} leg's cap was not in force.** A commit of the limit plus ${mib(PROBE_OVER_LIMIT_BYTES)}, made from inside the job before the benchmark started, succeeded, so the job's commit limit did not hold on this runner. That leg is the same run with no effective limit, and its figures are not a result under a ${gib} cap.`,
    );
  }
  for (const l of readings.filter((x) => x.above && x.proof !== 'not_enforced')) {
    const gib = gibOf(l.limit);
    out.push(
      '',
      l.proof === 'proven'
        ? `**The ${gib} leg's whole-tree peak is above its limit, and the limit is proven in force.** Its whole-tree peak is ${mib(l.wholeTree)}, ${mib(l.wholeTree - Number(l.limit))} above its job commit limit of ${mib(Number(l.limit))}, so the job's \`PeakJobMemoryUsed\` counts a commit that the limit refused: the peak is not memory the tree held.`
        : `**The ${gib} leg is not a result under a ${gib} cap.** Its whole-tree peak is ${mib(l.wholeTree)}, ${mib(l.wholeTree - Number(l.limit))} above its job commit limit of ${mib(Number(l.limit))}, and the documentation of the job-wide commit limit says a commit that would exceed it fails. So either the limit was not in effect on that runner, or the job's \`PeakJobMemoryUsed\` also counts a commit that the limit refused; the figures of this run cannot say which.`,
    );
  }
  for (const l of readings.filter((x) => x.wholeTree === null && x.afterProbe !== null)) {
    out.push(
      '',
      `**The whole-tree peak of the ${l.limit === '' ? 'no-limit' : gibOf(l.limit)} leg is not measured.** The job's \`PeakJobMemoryUsed\` read ${mib(l.afterProbe)} right after the commit probe and the benchmark never took it higher, so the high-water mark is the probe's and not the benchmark's.`,
    );
  }
  const capped = readings.filter((x) => x.limit !== '');
  const controlFailed = controls.some((e) =>
    rows.some((x) => x.environment === e && x.failure_reason !== ''),
  );
  if (
    capped.some((x) => x.proof === 'unproven') &&
    !readings.some((x) => x.failed) &&
    !controlFailed
  )
    out.push(
      '',
      'No leg in this file failed for want of memory, so none of the capped legs shows the limit taking effect; a leg whose whole-tree peak is below its limit never came near it. Until a leg whose limit is too low for the workload has been run and has failed, as it must if the limit is in effect, read the capped legs as the same run with the limit unproven, not as results under a cap.',
    );
  if (capped.length > 0 && capped.every((x) => x.proof === 'proven'))
    out.push(
      '',
      `The limit of every capped leg is proven in force: the system reports the limit that was set, and a commit of the limit plus ${mib(PROBE_OVER_LIMIT_BYTES)} made from inside the job before the benchmark started was refused. A capped leg whose Result reads pass therefore ran to the end with its commit limit in force. The limit is the job-wide commit limit of a GitHub-hosted Windows VM, not a physical-memory limit, and the VM is not a laptop.`,
    );
  if (legs.length > 1)
    out.push(
      '',
      "Each leg ran on its own runner VM, and the runner's CPU model and Chrome build can differ from leg to leg, so a difference in time between two legs is not an effect of the cap. The machine facts of each run, leg by leg, are in `scripts/win/README.md`.",
    );

  // The control leg(s): reported as controls, from their own rows; never a benchmark figure.
  const lowestChrome = rows
    .filter((x) => !controlOf(x.environment))
    .map((x) => num(x.process_commit_peak_bytes))
    .filter((x) => x !== null && x > 0);
  for (const env of controls) {
    const r = rows.filter((x) => x.environment === env);
    const limit = r[0].job_commit_limit_bytes;
    const proof = limitProof(r[0]);
    const failure = r.map((x) => x.failure_reason).find((x) => x !== '');
    const completed = r.filter((x) => x.failure_reason === '' && Number(x.run) > 0);
    const m = limitMessages(r[0]);
    const sawText =
      m.benchmark === null || m.probe === null
        ? ''
        : ` It saw ${m.benchmark === 0 ? 'no' : m.benchmark} memory-limit ${plural(m.benchmark, 'message', 'messages')} while it ran, besides the probe's ${m.probe}.`;
    const below =
      limit !== '' && lowestChrome.length > 0 && Number(limit) < Math.min(...lowestChrome)
        ? `its limit is below the lowest Chrome-only commit peak of any run of the other legs (${mib(Math.min(...lowestChrome))}), so a limit that is in force must stop the benchmark`
        : 'its limit is meant to be below what the benchmark needs, so a limit that is in force must stop the benchmark';
    const outcome = failure
      ? proof === 'proven'
        ? `It failed with \`${failure}\` after ${completed.length} completed run(s), as it must: the limit is proven in force (probe refused, read-back equal), so the control passed.`
        : `It failed with \`${failure}\` after ${completed.length} completed run(s), but the limit is not proven in force (${LIMIT_PROOF_TEXT[proof]}), so the stop shows nothing about the cap.`
      : completed.length >= 5
        ? `**It completed under the control limit (${completed.length} runs): the cap does nothing, so no capped leg of this file means anything.**`
        : `It did not complete: ${completed.length === 0 && r.every((x) => Number(x.run) === 0) ? 'no run finished (its row is a marker, run 0)' : `${completed.length} ${plural(completed.length, 'run', 'runs')} finished`} and no failure reason was recorded, so it was stopped by the time limit or a crash; ${proof === 'proven' ? 'the limit is proven in force (probe refused, read-back equal), so the control passed.' : `the limit is not proven in force (${LIMIT_PROOF_TEXT[proof]}), so the stop shows nothing about the cap.`}`;
    out.push(
      '',
      `**Control leg, ${limit === '' ? 'no limit' : gibOf(limit)}: not a benchmark figure.** The benchmark must not complete here: ${below}. ${outcome}${sawText} Label: \`${env}\`.`,
    );
  }

  out.push(
    '',
    `Column notes. Peak commit is the Windows commit size (PrivatePageCount, in bytes), which is what a Job Object limit adds up; the whole-tree figure is the job's PeakJobMemoryUsed for the whole run (it includes the model download that comes before the first run, which the Chrome-only sampler does not cover) and is the same in every row of a leg, the Chrome-only figure is the sum over the Chrome process tree of this run. It is left empty (not measured) when the high-water mark was already as high after the commit probe as at the end of the run, because then it is the probe's. Limit in force is computed from the evidence columns: the read-back (QueryInformationJobObject, after the process was put in the job) must equal what was set and the commit above the limit must have been refused${capped.some((x) => x.proof === 'unproven') ? '; a capped leg with neither (a file written before the evidence existed, or an inconclusive probe) reads limit unproven' : ''}. Commits refused while the benchmark ran is the job completion port's count of JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages over the whole run minus the count when the probe ended (the probe's own refused commit posts one); the system does not guarantee delivery of these messages, so it is a floor, and a leg with no limit has nothing to refuse. The question set is the number of answers that hold the expected text and cite the right page over every answerable row of every run of the leg (36 rows for six runs of the six answerable questions). The Windows sampler enumerates every process on each tick, so its median interval (the sampler_median_interval_ms column) is longer than the 500 ms it sleeps, and a peak shorter than that can fall between two ticks. A leg that is incomplete or failed says so in the Result column and keeps every row it wrote.`,
  );
  return out.join('\n');
}

const E2E_EMULATED_START = '<!-- bench-emulated:start -->';
const E2E_EMULATED_END = '<!-- bench-emulated:end -->';
/** Puts the emulated block after the benchmark block, or removes it when there is none; the README is unchanged when there was nothing and is nothing. */
export function applyEmulated(readme, block) {
  const a = readme.indexOf(E2E_EMULATED_START);
  const b = readme.indexOf(E2E_EMULATED_END);
  const had = a >= 0 && b > a;
  const stripped = had
    ? `${readme.slice(0, a)}${readme.slice(b + E2E_EMULATED_END.length).replace(/^\n/u, '')}`
    : readme;
  if (block === '') return stripped;
  const at = stripped.indexOf(END);
  if (at < 0) throw new Error('README.md has no bench:start / bench:end markers');
  const after = at + END.length;
  return `${stripped.slice(0, after)}\n${E2E_EMULATED_START}\n${block}\n${E2E_EMULATED_END}${stripped.slice(after)}`;
}

const START = '<!-- bench:start -->';
const END = '<!-- bench:end -->';
export function apply(readme, block) {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error('README.md has no bench:start / bench:end markers');
  return `${readme.slice(0, a + START.length)}\n${block}\n${readme.slice(b)}`;
}

/** Inline figures and the Status paragraph, generated from the CSVs (BUG-T1-S6-04): <!--fig:NAME-->...<!--/fig--> spans and the paragraph under '## Status'. */
export function applyInline(readme, f, line) {
  const w = memoryWords(f);
  const figs = {
    cut: `from a median of ${w.beforeMedian} to ${w.afterMedian} (worst ${w.afterWorst}; median of the ${f.after.runs} in-session runs)`,
    time: `the median per-question total went from ${w.beforeQMedianMs} to ${w.afterQMedianMs} (worst ${w.afterQWorstMs})`,
  };
  const out = readme.replace(/<!--fig:(\w+)-->[\s\S]*?<!--\/fig-->/gu, (all, k) => {
    if (!(k in figs)) throw new Error(`README.md: unknown figure ${k}`);
    return `<!--fig:${k}-->${figs[k]}<!--/fig-->`;
  });
  return out.replace(/(^## Status\n\n)[\s\S]*?(\n\n)/mu, (_m, a, b) => `${a}${line}${b}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(E2E) || !existsSync(QCSV)) {
    console.error(
      'bench-readme: docs/benchmarks/e2e.csv and e2e-questions.csv are missing: run npm run bench:e2e',
    );
    process.exit(1);
  }
  const cur = readFileSync(README, 'utf8');
  const rd = (p) => readFileSync(p, 'utf8');
  const pair4 = [rd(E2E_BASE), rd(QCSV_BASE), rd(E2E), rd(QCSV)];
  const emulated = existsSync(E2E_EMULATED) ? readFileSync(E2E_EMULATED, 'utf8') : undefined;
  const emulatedQuestions = existsSync(E2E_EMULATED_Q)
    ? readFileSync(E2E_EMULATED_Q, 'utf8')
    : undefined;
  const next = applyEmulated(
    applyInline(apply(cur, table()), memoryFigures(...pair4), statusLine(...pair4, emulated)),
    emulatedBlock(emulated, emulatedQuestions),
  );
  if (process.argv.includes('--check')) {
    if (cur !== next) {
      console.error('README.md benchmark block is out of date: run node scripts/bench-readme.mjs');
      process.exit(1);
    }
    console.log('README.md benchmark block is up to date');
  } else {
    writeFileSync(README, next);
    console.log('README.md benchmark block rewritten');
  }
}
