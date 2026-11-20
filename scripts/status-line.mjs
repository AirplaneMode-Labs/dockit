#!/usr/bin/env node
// Writes src/status-line-text.ts: the Sprint 7 status line (the Sprint 6 memory figures re-measured on a quiet machine, TD-101), with the memory figures derived from the committed CSVs by scripts/memory-figures.mjs
// (BUG-T1-S6-04: no hand-typed figure, one rounding rule). The line is also written to the file named by --also (the workspace copy the site syncs).
//   node scripts/status-line.mjs            rewrite src/status-line-text.ts
//   node scripts/status-line.mjs --check    exit 1 unless the file is exactly this
//   node scripts/status-line.mjs --also <file>   additionally write the bare line there
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMULATED_E2E_FILE, limitMessages, limitProof } from './lib/bench-columns.mjs';
import { memoryFigures, memoryWords, parseCsv, TARGET } from './memory-figures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const B = join(root, 'docs', 'benchmarks');
const OUT = join(root, 'src', 'status-line-text.ts');
const rd = (f) => readFileSync(join(B, f), 'utf8');

const NOT_RUN =
  'a Windows benchmark under an emulated memory cap (a GitHub-hosted virtual machine, never a laptop) is written and has not run';

/**
 * The Windows clause of the status line, computed from the emulated runs CSV text (docs/benchmarks/e2e-emulated-win-vm.csv) and nothing else. With no text it says the benchmark
 * has not run. With rows it says the benchmark has run and, only when every capped leg's limit is proven in force (limitProof) and every benchmark leg finished, what that
 * showed: the capped legs, whether commits were refused while the benchmark ran (limitMessages) and whether the control leg did not complete. For any other state of the file
 * it says only that the run is in the repository and its limit evidence is read on the benchmarks page, and claims nothing about a cap. Never a laptop figure, never an 8 GB cell.
 */
export function windowsClause(emulatedText) {
  if (emulatedText === undefined) return NOT_RUN;
  const rows = parseCsv(emulatedText);
  const envs = [...new Set(rows.map((r) => r.environment))];
  const first = (env) => rows.find((r) => r.environment === env);
  const isControl = (env) => first(env).control_leg === 'true';
  const legs = envs.filter((e) => !isControl(e));
  const controls = envs.filter(isControl);
  const gib = (env) => `${Number(first(env).job_commit_limit_bytes) / 1073741824} GiB`;
  const capped = legs.filter((e) => first(e).job_commit_limit_bytes !== '');
  const finished = legs.every((e) => {
    const r = rows.filter((x) => x.environment === e);
    const session = r.filter((x) => x.restart !== 'true');
    return (
      r.every((x) => x.failure_reason === '') && session.length >= 5 && r.length > session.length
    );
  });
  const machine = /(\d+) vCPU, (\d+) GB RAM/u.exec(envs[0] ?? '');
  const where = `a GitHub-hosted virtual machine${machine ? ` with ${machine[1]} vCPU and ${machine[2]} GB RAM` : ''}, never a laptop`;
  const open = `a Windows benchmark under an emulated memory cap (${where}) has run`;
  const proven =
    capped.length > 0 &&
    capped.every((e) => limitProof(first(e)) === 'proven') &&
    controls.every((e) => limitProof(first(e)) === 'proven');
  if (!proven || !finished || legs.length === 0)
    return `${open} (its rows are in the repository; whether its memory limit was in force is read from the evidence on the benchmarks page)`;
  const refused = capped.filter((e) => (limitMessages(first(e)).benchmark ?? 0) > 0).map(gib);
  const list = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
  const control = controls.map((e) => {
    const r = rows.filter((x) => x.environment === e);
    return r.some((x) => x.failure_reason !== '') || !r.some((x) => Number(x.run) > 0)
      ? `${gib(e)} control leg, which must not finish, did not finish`
      : null;
  });
  return (
    `${open}: the commit limit of its ${list(capped.map(gib))} legs is proven in force (the system reports the limit that was set and a commit above it was refused), ` +
    `all ${legs.length} legs finished, ${refused.length > 0 ? `commits were refused while the benchmark ran on the ${list(refused)} ${refused.length === 1 ? 'leg' : 'legs'} and it still finished` : 'no commit was refused while the benchmark ran'}` +
    `${control.length > 0 && control.every((c) => c !== null) ? `, and the ${list(control)}` : ''}; ` +
    'it limits committed memory on one virtual machine, so it is not a laptop figure and fills no 8 GB cell'
  );
}

/** The status line for the four CSV texts (and, when there is one, the emulated runs CSV text). 'short of' / 'within' the target is computed, not typed. */
export function statusLine(baseE2e, baseQ, afterE2e, afterQ, emulatedE2e) {
  const f = memoryFigures(baseE2e, baseQ, afterE2e, afterQ);
  const w = memoryWords(f);
  const qs = parseCsv(afterQ).filter((r) => r.correct_source_page !== '');
  const ok = qs.filter((r) => r.answer_ok === 'true' && r.correct_source_page === 'true').length;
  const reached = f.after.rssMedianMiB <= TARGET.rssMedianMiB;
  return (
    'Sprint 7 (20 Nov 2026): Working: the same app as Sprint 6 (ask a question about a PDF and read an answer from a small local model, Qwen3-0.6B in WebAssembly, with the source pages shown, one model in memory at a time; nothing about the page changed in Sprint 7); ' +
    `its memory figure was re-measured on a quiet machine on the committed Sprint 6 build: the Chrome process tree peaked at a median of ${w.afterMedian}, down from ${w.beforeMedian} before the Sprint 6 memory work, ` +
    `${reached ? 'within' : 'still short of'} the ${TARGET.rssMedianMiB.toLocaleString('en-US')} MiB target (each median is of ${f.after.runs} in-session runs), with the fixed question set at ${ok} of ${qs.length} and a median answer time of ${w.afterQMedianMs} (Apple M5 Pro 48 GB, not measured on 8 GB); ` +
    `${windowsClause(emulatedE2e)}; ` +
    "after the one-time model download no request leaves the page (proved on a local build in installed Chrome on an Apple M5 Pro 48 GB, not measured on 8 GB; live since the owner's push of 18 Nov 2026). " +
    `Not yet: OCR, a Windows or 8 GB laptop figure (${emulatedE2e === undefined ? 'an emulated Windows figure is pending its first run and would not be a laptop figure' : 'the emulated Windows run is not one'}), the pilot model (Qwen3-1.7B), a real signing key, WebLLM (cut), multi-document chat.`
  );
}

export function fileText(line) {
  return `/** Equal to the dockit line in site/data/demos.json, byte for byte (pinned by site's tests and written to <lane>/status-line.txt). Generated by scripts/status-line.mjs from the committed benchmark CSVs. */\nexport const SPRINT_STATUS_LINE =\n  ${JSON.stringify(line)};\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const line = statusLine(
    rd('e2e-s6-baseline.csv'),
    rd('e2e-questions-s6-baseline.csv'),
    rd('e2e.csv'),
    rd('e2e-questions.csv'),
    existsSync(join(B, EMULATED_E2E_FILE)) ? rd(EMULATED_E2E_FILE) : undefined,
  );
  const text = fileText(line);
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
      console.error('src/status-line-text.ts is out of date: run node scripts/status-line.mjs');
      process.exit(1);
    }
    console.log('status line is in sync with the CSVs');
  } else {
    writeFileSync(OUT, text);
    const i = process.argv.indexOf('--also');
    if (i > 0) writeFileSync(process.argv[i + 1], line);
    console.log(line);
  }
}
