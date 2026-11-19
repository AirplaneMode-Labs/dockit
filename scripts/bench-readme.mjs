#!/usr/bin/env node
// Rewrites the benchmark table between <!-- bench:start --> and <!-- bench:end --> in README.md from docs/benchmarks/e2e.csv and
// e2e-questions.csv, so no figure in the README is typed by hand.
//   node scripts/bench-readme.mjs           rewrite the block
//   node scripts/bench-readme.mjs --check   exit 1 unless the README holds exactly this block
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAPTOP_8GB } from './lib/bench-columns.mjs';
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
  const next = applyInline(apply(cur, table()), memoryFigures(...pair4), statusLine(...pair4));
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
