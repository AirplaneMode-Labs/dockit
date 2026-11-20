import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { guardLaptopCsvs } from './helpers/laptop-csv-guard.ts';
import {
  EMULATED_E2E_FILE,
  EMULATED_Q_FILE,
  E2E_COLUMNS,
  E2E_EMULATED_COLUMNS,
  LAPTOP_8GB,
  Q_COLUMNS,
  Q_EMULATED_COLUMNS,
  csv,
  hostLoadCell,
  runZeroRows,
} from '../scripts/lib/bench-columns.mjs';
import { merge } from '../scripts/bench-emulated-merge.mjs';
import { applyEmulated, emulatedBlock, parseCsv } from '../scripts/bench-readme.mjs';
import { SPAWN_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';

// B6 / TD-113: emulated results go in SEPARATE files with an 'environment' column. Nothing here fills a laptop cell: laptop_8gb stays
// 'not measured on 8 GB' on every row, and the Sprint 5 done-when stays NOT met (TD-51).
const root = join(import.meta.dirname, '..');
vi.setConfig({ testTimeout: SPAWN_TEST_TIMEOUT_MS });
guardLaptopCsvs();
const LABEL =
  'emulated: GitHub-hosted Windows Server 2025 VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree under a job commit limit of 6442450944 bytes; not a laptop';

describe('the emulated column lists', () => {
  it('E2E_EMULATED_COLUMNS is the base list plus exactly the seven emulated columns, in this order', () => {
    expect([...E2E_EMULATED_COLUMNS]).toEqual([
      ...E2E_COLUMNS,
      'environment',
      'job_commit_limit_bytes',
      'job_commit_peak_bytes',
      'process_commit_peak_bytes',
      'job_escapes',
      'sampler_median_interval_ms',
      'failure_reason',
    ]);
  });
  it('Q_EMULATED_COLUMNS is the question list plus environment and failure_reason', () => {
    expect([...Q_EMULATED_COLUMNS]).toEqual([...Q_COLUMNS, 'environment', 'failure_reason']);
  });
  it('both keep laptop_8gb, with no repeated column', () => {
    for (const c of [E2E_EMULATED_COLUMNS, Q_EMULATED_COLUMNS]) {
      expect(c).toContain('laptop_8gb');
      expect(new Set(c).size).toBe(c.length);
    }
  });
  it('the emulated files have names of their own, and neither is e2e.csv or e2e-questions.csv', () => {
    expect(EMULATED_E2E_FILE).toBe('e2e-emulated-win-vm.csv');
    expect(EMULATED_Q_FILE).toBe('e2e-emulated-win-vm-questions.csv');
    expect([EMULATED_E2E_FILE, EMULATED_Q_FILE]).not.toContain('e2e.csv');
    expect([EMULATED_E2E_FILE, EMULATED_Q_FILE]).not.toContain('e2e-questions.csv');
  });
  it('the host-load cell is empty on win32 (os.loadavg() is always 0 there) and two decimals elsewhere', () => {
    expect(hostLoadCell(2.4, 'win32')).toBe('');
    expect(hostLoadCell(0, 'win32')).toBe('');
    expect(hostLoadCell(2.4, 'darwin')).toBe('2.40');
    expect(hostLoadCell(11.567, 'linux')).toBe('11.57');
  });
});

const fullRow = (over: Record<string, unknown> = {}) => ({
  ...Object.fromEntries(E2E_EMULATED_COLUMNS.map((c) => [c, 'x'])),
  laptop_8gb: LAPTOP_8GB,
  environment: LABEL,
  host_load_1m_start: '',
  host_load_1m_end: '',
  job_commit_limit_bytes: '',
  job_commit_peak_bytes: '',
  job_escapes: '',
  failure_reason: '',
  ...over,
});

describe('csv(): the emulated shape and what the writer refuses', () => {
  it('writes the header equal to the column list, the label as one quoted cell, and the 8 GB phrase on the row', () => {
    const text = csv(E2E_EMULATED_COLUMNS, [fullRow()]);
    const [head, body] = text.split('\n');
    expect(head).toBe(E2E_EMULATED_COLUMNS.join(','));
    expect(body).toContain(`"${LABEL}"`);
    expect(parseCsv(text)[0]!['environment']).toBe(LABEL);
    expect(parseCsv(text)[0]!['laptop_8gb']).toBe(LAPTOP_8GB);
  });
  it('still refuses a row whose laptop_8gb is not the phrase', () => {
    expect(() => csv(E2E_EMULATED_COLUMNS, [fullRow({ laptop_8gb: 'measured' })])).toThrow(
      /laptop_8gb/u,
    );
    expect(() => csv(Q_EMULATED_COLUMNS, [{ laptop_8gb: '', environment: LABEL }])).toThrow(
      /laptop_8gb/u,
    );
  });
  it('refuses a row whose environment label is missing, reads as a laptop, or reads as an 8 GB machine', () => {
    for (const environment of [
      '',
      undefined,
      'Apple M5 Pro 48 GB',
      'emulated: a laptop VM; not a laptop',
      'emulated: VM, 8 GB RAM; not a laptop',
    ])
      expect(() => csv(E2E_EMULATED_COLUMNS, [fullRow({ environment })])).toThrow(
        /environment label/u,
      );
  });
  it('refuses a failure_reason outside the four reasons', () => {
    expect(() => csv(E2E_EMULATED_COLUMNS, [fullRow({ failure_reason: 'because' })])).toThrow(
      /failure_reason/u,
    );
    for (const r of ['', 'renderer_crash', 'browser_disconnected', 'worker_crash', 'out_of_memory'])
      expect(() => csv(E2E_EMULATED_COLUMNS, [fullRow({ failure_reason: r })])).not.toThrow();
  });
  it('the plain column lists are untouched: no environment is required and none is written', () => {
    const row = Object.fromEntries(E2E_COLUMNS.map((c) => [c, 'x']));
    row['laptop_8gb'] = LAPTOP_8GB;
    expect(csv(E2E_COLUMNS, [row]).split('\n')[0]).toBe(E2E_COLUMNS.join(','));
    expect(E2E_COLUMNS).not.toContain('environment');
  });
});

describe('bench-e2e.mjs: an emulated run never writes e2e.csv', () => {
  const cleanEnv = (extra: Record<string, string>) => ({
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(GITHUB_|RUNNER_|CI$)/u.test(k)),
    ),
    // the emulated files go to the scratch folder unless the test points one variable at a laptop CSV to see it refused
    DOCKIT_BENCH_CSV: join(os.tmpdir(), 'dockit-emu-test-e2e.csv'),
    DOCKIT_BENCH_Q_CSV: join(os.tmpdir(), 'dockit-emu-test-e2e-questions.csv'),
    ...extra,
  });
  const run = (args: string[], extra: Record<string, string>) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'bench-e2e.mjs'), ...args], {
      encoding: 'utf8',
      env: cleanEnv(extra),
      timeout: 20_000,
    });
  it.each([
    ['DOCKIT_BENCH_CSV', join(root, 'docs', 'benchmarks', 'e2e.csv')],
    ['DOCKIT_BENCH_Q_CSV', join(root, 'docs', 'benchmarks', 'e2e-questions.csv')],
  ])('refuses (exit 2) when %s points at the laptop CSV in emulated mode', (name, path) => {
    const r = run(['--environment', LABEL], { [name]: path });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/emulated.*never writes e2e\.csv|never writes/u);
  });
  it('the source names the emulated file defaults and the column lists, and the plain path keeps the plain ones', () => {
    const src = readFileSync(join(root, 'scripts', 'bench-e2e.mjs'), 'utf8');
    expect(src).toContain('E2E_EMULATED_COLUMNS');
    expect(src).toContain('Q_EMULATED_COLUMNS');
    expect(src).toContain('EMULATED_E2E_FILE');
    expect(src).toContain('EMULATED_Q_FILE');
    expect(src).toContain('E2E_COLUMNS');
    // both kinds of row still say 'not measured on 8 GB' through the one constant
    expect(src.match(/laptop_8gb: LAPTOP_8GB/gu)?.length).toBe(2);
  });
});

// scripts/bench-emulated-merge.mjs: the job columns come from job-summary.json, which run-capped.ps1 writes after the run.
describe('bench-emulated-merge.mjs', () => {
  const merge = (csvFile: string, summary: string, extra: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        join(root, 'scripts', 'bench-emulated-merge.mjs'),
        '--csv',
        csvFile,
        '--summary',
        summary,
        ...extra,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
  const scratch = () => mkdtempSync(join(os.tmpdir(), 'dockit-merge-'));
  const rows = [
    fullRow({ run: '1', process_commit_peak_bytes: '3000' }),
    fullRow({ run: '2', process_commit_peak_bytes: '3100' }),
  ];

  it('fills the three job columns in every row and leaves every other cell byte for byte as it was', () => {
    const dir = scratch();
    const file = join(dir, 'e2e-emulated-win-vm.csv');
    writeFileSync(file, csv(E2E_EMULATED_COLUMNS, rows));
    writeFileSync(
      join(dir, 'job-summary.json'),
      JSON.stringify({
        cap: '6GiB',
        limitBytes: 6442450944,
        peakJobMemoryBytes: 4800000000,
        escapes: 0,
      }),
    );
    const r = merge(file, join(dir, 'job-summary.json'));
    expect(r.status, r.stderr).toBe(0);
    const out = parseCsv(readFileSync(file, 'utf8'));
    expect(out).toHaveLength(2);
    for (const [i, o] of out.entries()) {
      expect(o['job_commit_limit_bytes']).toBe('6442450944');
      expect(o['job_commit_peak_bytes']).toBe('4800000000');
      expect(o['job_escapes']).toBe('0');
      expect(o['environment']).toBe(LABEL);
      expect(o['process_commit_peak_bytes']).toBe(i === 0 ? '3000' : '3100');
      expect(o['laptop_8gb']).toBe(LAPTOP_8GB);
    }
  });

  it('the leg with no limit leaves job_commit_limit_bytes empty (limitBytes null) and still records the peak', () => {
    const dir = scratch();
    const file = join(dir, 'x.csv');
    writeFileSync(file, csv(E2E_EMULATED_COLUMNS, rows));
    writeFileSync(
      join(dir, 's.json'),
      JSON.stringify({ cap: 'none', limitBytes: null, peakJobMemoryBytes: 5100000000, escapes: 0 }),
    );
    expect(merge(file, join(dir, 's.json')).status).toBe(0);
    const o = parseCsv(readFileSync(file, 'utf8'))[0]!;
    expect(o['job_commit_limit_bytes']).toBe('');
    expect(o['job_commit_peak_bytes']).toBe('5100000000');
  });

  it('records escapes: a Chrome process outside the job is reported, not hidden', () => {
    const dir = scratch();
    const file = join(dir, 'x.csv');
    writeFileSync(file, csv(E2E_EMULATED_COLUMNS, rows));
    writeFileSync(
      join(dir, 's.json'),
      JSON.stringify({ cap: '8GiB', limitBytes: 8589934592, peakJobMemoryBytes: 1, escapes: 3 }),
    );
    expect(merge(file, join(dir, 's.json')).status).toBe(0);
    expect(parseCsv(readFileSync(file, 'utf8'))[0]!['job_escapes']).toBe('3');
  });

  it.each([
    ['a negative peak', { cap: '6GiB', limitBytes: 1, peakJobMemoryBytes: -1, escapes: 0 }],
    [
      'a fractional escape count',
      { cap: '6GiB', limitBytes: 1, peakJobMemoryBytes: 1, escapes: 0.5 },
    ],
    ['a string peak', { cap: '6GiB', limitBytes: 1, peakJobMemoryBytes: '1e9', escapes: 0 }],
    ['an unknown cap', { cap: '7GiB', limitBytes: 1, peakJobMemoryBytes: 1, escapes: 0 }],
    [
      'a limit that does not match the cap',
      { cap: '6GiB', limitBytes: 5368709120, peakJobMemoryBytes: 1, escapes: 0 },
    ],
    ['a missing field', { cap: '6GiB', limitBytes: 6442450944 }],
  ])('refuses %s and leaves the CSV as it was', (_why, summary) => {
    const dir = scratch();
    const file = join(dir, 'x.csv');
    const before = csv(E2E_EMULATED_COLUMNS, rows);
    writeFileSync(file, before);
    writeFileSync(join(dir, 's.json'), JSON.stringify(summary));
    const r = merge(file, join(dir, 's.json'));
    expect(r.status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a CSV whose header is not E2E_EMULATED_COLUMNS (the laptop CSV is never merged into)', () => {
    const dir = scratch();
    const file = join(dir, 'e2e.csv');
    const plain = Object.fromEntries(E2E_COLUMNS.map((c) => [c, 'x']));
    plain['laptop_8gb'] = LAPTOP_8GB;
    const before = csv(E2E_COLUMNS, [plain]);
    writeFileSync(file, before);
    writeFileSync(
      join(dir, 's.json'),
      JSON.stringify({ cap: 'none', limitBytes: null, peakJobMemoryBytes: 1, escapes: 0 }),
    );
    expect(merge(file, join(dir, 's.json')).status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('exits 1 when the summary is missing, so the missing file is visible', () => {
    const dir = scratch();
    const file = join(dir, 'x.csv');
    writeFileSync(file, csv(E2E_EMULATED_COLUMNS, rows));
    const r = merge(file, join(dir, 'nope.json'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/job-summary|nope\.json/u);
  });
});

describe('the README subsection "Emulated Windows (not a laptop)" exists only when the emulated CSV does', () => {
  const sample = csv(E2E_EMULATED_COLUMNS, [
    fullRow({
      run: '1',
      restart: 'false',
      first_token_ms: '9000',
      total_ms: '14000',
      process_rss_peak_bytes: String(4 * 1048576 * 1024),
      process_commit_peak_bytes: String(5 * 1048576 * 1024),
      job_commit_limit_bytes: '6442450944',
      job_commit_peak_bytes: String(5 * 1048576 * 1024 + 300 * 1048576),
      job_escapes: '0',
      sampler_median_interval_ms: '730',
      requests_after_offline: '0',
    }),
  ]);

  it('is empty with no CSV text, and the README is then unchanged, with or without markers', () => {
    expect(emulatedBlock(undefined)).toBe('');
    const readme = 'a\n<!-- bench:end -->\nb\n';
    expect(applyEmulated(readme, '')).toBe(readme);
    const withMarkers =
      'a\n<!-- bench:end -->\n<!-- bench-emulated:start -->\nold\n<!-- bench-emulated:end -->\nb\n';
    expect(applyEmulated(withMarkers, '')).toBe(readme);
  });

  it('with the CSV it names the label verbatim, says not a laptop, covers pwsh, node and Chrome in the job limit and keeps the 8 GB cell', () => {
    const b = emulatedBlock(sample);
    expect(b).toContain('Emulated Windows (not a laptop)');
    expect(b).toContain(LABEL);
    expect(b).toContain('pwsh, node and Chrome process tree');
    expect(b).toContain(LAPTOP_8GB);
    expect(b).toMatch(/done-when[^.]*NOT met/u);
    expect(b).toContain('commit');
    // never calls an emulated figure an 8 GB or laptop result
    expect(b.replaceAll('not a laptop', '').replaceAll(LABEL, '')).not.toMatch(
      /laptop result|8 GB result|on an 8 GB laptop[^.]*measured/iu,
    );
  });

  it('is idempotent, inserts after the benchmark block and escapes nothing it should not', () => {
    const readme = 'x\n<!-- bench:start -->\nT\n<!-- bench:end -->\ny\n';
    const once = applyEmulated(readme, emulatedBlock(sample));
    expect(once).toContain('<!-- bench-emulated:start -->');
    expect(once.indexOf('<!-- bench:end -->')).toBeLessThan(
      once.indexOf('<!-- bench-emulated:start -->'),
    );
    expect(applyEmulated(once, emulatedBlock(sample))).toBe(once);
    expect(applyEmulated(once, '')).toBe(readme);
  });

  it('refuses an emulated CSV with a row that does not read not measured on 8 GB', () => {
    const broken = sample.replace(`,${LAPTOP_8GB},`, ',measured,');
    expect(() => emulatedBlock(broken)).toThrow(/laptop_8gb/u);
  });

  it('the committed README holds the subsection if and only if the emulated CSV is committed', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const file = join(root, 'docs', 'benchmarks', EMULATED_E2E_FILE);
    expect(readme.includes('Emulated Windows (not a laptop)')).toBe(existsSync(file));
    if (existsSync(file))
      expect(applyEmulated(readme, emulatedBlock(readFileSync(file, 'utf8')))).toBe(readme);
  });

  it('the committed e2e.csv is never an emulated file: no environment column', () => {
    const head = readFileSync(join(root, 'docs', 'benchmarks', 'e2e.csv'), 'utf8')
      .split('\n')[0]!
      .split(',');
    expect(head).not.toContain('environment');
  });
});

describe('BUG-T1-S7-06: a failure before the first run leaves one run-0 row', () => {
  const z = runZeroRows({
    date: '2026-11-21T00:00:00.000Z',
    label: LABEL,
    commit: 'abc123def456',
    reason: 'renderer_crash',
  });
  it('the row has run 0, the reason, the label verbatim, empty figures and the 8 GB phrase, in both files', () => {
    expect(z.e2e).toMatchObject({
      run: 0,
      restart: false,
      failure_reason: 'renderer_crash',
      environment: LABEL,
      machine: LABEL,
      laptop_8gb: LAPTOP_8GB,
      answer_ok: false,
    });
    expect(z.q).toMatchObject({
      run: 0,
      qid: '',
      failure_reason: 'renderer_crash',
      environment: LABEL,
      laptop_8gb: LAPTOP_8GB,
    });
    const e = parseCsv(csv(E2E_EMULATED_COLUMNS, [z.e2e]));
    expect(e).toHaveLength(1);
    expect(e[0]!.failure_reason).toBe('renderer_crash');
    expect(e[0]!.laptop_8gb).toBe(LAPTOP_8GB);
    expect(e[0]!.total_ms).toBe('');
    expect(parseCsv(csv(Q_EMULATED_COLUMNS, [z.q]))).toHaveLength(1);
  });
  it('bench-emulated-merge accepts it and the job columns are filled', () => {
    const out = merge(csv(E2E_EMULATED_COLUMNS, [z.e2e]), {
      cap: '6GiB',
      limitBytes: 6442450944,
      peakJobMemoryBytes: 1000,
      escapes: 0,
    });
    const r = parseCsv(out);
    expect(r[0]!.job_commit_limit_bytes).toBe('6442450944');
    expect(r[0]!.failure_reason).toBe('renderer_crash');
  });
  it('bench-e2e.mjs writes it only for an emulated run that has no row yet, and never for the laptop CSVs', () => {
    const src = readFileSync(join(root, 'scripts', 'bench-e2e.mjs'), 'utf8');
    expect(src).toMatch(/if \(EMULATED && benchFailure && rows\.length === 0\)/u);
  });
});
