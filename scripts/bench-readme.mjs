#!/usr/bin/env node
// Rewrites the benchmark table between <!-- bench:start --> and <!-- bench:end --> in README.md from docs/benchmarks/e2e.csv and
// e2e-questions.csv, so no figure in the README is typed by hand.
//   node scripts/bench-readme.mjs           rewrite the block
//   node scripts/bench-readme.mjs --check   exit 1 unless the README holds exactly this block
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAPTOP_8GB } from './lib/bench-columns.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(root, 'README.md');
const E2E = join(root, 'docs', 'benchmarks', 'e2e.csv');
const QCSV = join(root, 'docs', 'benchmarks', 'e2e-questions.csv');

export function parseCsv(text) {
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  return lines
    .slice(1)
    .map((l) =>
      Object.fromEntries(
        head.map((h, i) => [
          h,
          (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) =>
            c.replace(/,$/, '').replace(/^"|"$/g, '').replaceAll('""', '"'),
          )[i] ?? '',
        ]),
      ),
    );
}
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

const START = '<!-- bench:start -->';
const END = '<!-- bench:end -->';
export function apply(readme, block) {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error('README.md has no bench:start / bench:end markers');
  return `${readme.slice(0, a + START.length)}\n${block}\n${readme.slice(b)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(E2E) || !existsSync(QCSV)) {
    console.error(
      'bench-readme: docs/benchmarks/e2e.csv and e2e-questions.csv are missing: run npm run bench:e2e',
    );
    process.exit(1);
  }
  const cur = readFileSync(README, 'utf8');
  const next = apply(cur, table());
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
