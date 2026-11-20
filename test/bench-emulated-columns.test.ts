import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { guardLaptopCsvs } from './helpers/laptop-csv-guard.ts';
import {
  CONTROL_CAPS,
  EMULATED_E2E_FILE,
  EMULATED_HEADERS,
  EMULATED_Q_FILE,
  E2E_COLUMNS,
  E2E_EMULATED_COLUMNS,
  E2E_EMULATED_COLUMNS_V1,
  LAPTOP_8GB,
  LEG_CAPS,
  LIMIT_PROOF_TEXT,
  PROBE_OVER_LIMIT_BYTES,
  Q_COLUMNS,
  Q_EMULATED_COLUMNS,
  csv,
  hostLoadCell,
  limitProof,
  runZeroRows,
} from '../scripts/lib/bench-columns.mjs';
import { merge, summaryCells } from '../scripts/bench-emulated-merge.mjs';
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
  it('E2E_EMULATED_COLUMNS_V1 is the base list plus exactly the seven emulated columns of the first run, in this order', () => {
    expect([...E2E_EMULATED_COLUMNS_V1]).toEqual([
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
  it('E2E_EMULATED_COLUMNS is that list plus the six limit-evidence columns after failure_reason, and a committed file may have either header', () => {
    expect([...E2E_EMULATED_COLUMNS]).toEqual([
      ...E2E_EMULATED_COLUMNS_V1,
      'job_limit_readback_bytes',
      'job_limit_flags_readback',
      'limit_probe_refused',
      'job_peak_after_probe_bytes',
      'job_memory_limit_messages',
      'control_leg',
    ]);
    expect([...EMULATED_HEADERS]).toEqual([
      E2E_EMULATED_COLUMNS.join(','),
      E2E_EMULATED_COLUMNS_V1.join(','),
    ]);
  });
  it('the legs and the one control are the same as in scripts/win/run-capped.ps1, and the probe commits 256 MiB over the limit', () => {
    expect(Object.keys(LEG_CAPS)).toEqual(['none', '8GiB', '6GiB', '5GiB', '2GiB']);
    expect(LEG_CAPS['2GiB']).toBe(2147483648);
    expect([...CONTROL_CAPS]).toEqual(['2GiB']);
    const ps1 = readFileSync(join(root, 'scripts', 'win', 'run-capped.ps1'), 'utf8');
    expect(ps1).toContain(`$ProbeOverBytes = [uint64]${PROBE_OVER_LIMIT_BYTES}`);
    for (const n of Object.values(LEG_CAPS)) if (n !== null) expect(ps1).toContain(String(n));
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
  job_limit_readback_bytes: '',
  job_limit_flags_readback: '',
  limit_probe_refused: '',
  job_peak_after_probe_bytes: '',
  job_memory_limit_messages: '',
  control_leg: '',
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

// The first Windows run (bench-windows run 44656249868, 20 Nov 2026): the 5 GiB leg's own whole-tree peak was above its limit and no leg failed, so the README
// subsection says in words, computed from the rows and never typed, what the legs do and do not show next to the figures.
describe('the README subsection says what the legs show, computed from the rows', () => {
  const GIB = 1073741824;
  const MIB = 1048576;
  const label = (gib: number | null, vm = 'Windows Server 2025 Datacenter VM') =>
    `emulated: GitHub-hosted ${vm}, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree ${gib === null ? 'with no job limit' : `under a job commit limit of ${gib * GIB} bytes`}; not a laptop`;
  /** Six rows of one leg (five in-session runs and the run after a Chrome restart), the job figures repeated on every row as the merge step writes them. */
  const leg = (
    gib: number | null,
    peakMiB: number,
    opts: { chrome?: string; fail?: string } = {},
  ) =>
    Array.from({ length: 6 }, (_, i) =>
      fullRow({
        environment: label(gib),
        machine: label(gib),
        chrome: opts.chrome ?? 'Chrome/156.0.8078.80',
        commit: '5705baab8cdf',
        run: String(i + 1),
        restart: i === 5 ? 'true' : 'false',
        first_token_ms: '9000',
        total_ms: '14000',
        process_commit_peak_bytes: String(4000 * MIB),
        job_commit_limit_bytes: gib === null ? '' : String(gib * GIB),
        job_commit_peak_bytes: String(peakMiB * MIB),
        job_escapes: '0',
        sampler_median_interval_ms: '540',
        requests_after_offline: '0',
        failure_reason: i === 2 ? (opts.fail ?? '') : '',
      }),
    );
  const block = (...legs: ReturnType<typeof leg>[]) =>
    emulatedBlock(csv(E2E_EMULATED_COLUMNS, legs.flat()));

  it('a leg whose whole-tree peak is above its own limit is called not a result under that cap, in words and in its Result cell', () => {
    const b = block(leg(null, 5900), leg(8, 5790), leg(5, 5793));
    expect(b).toContain('The 5 GiB leg is not a result under a 5 GiB cap.');
    // 5,793 MiB against 5,120 MiB: 673 MiB above, every number from the rows
    expect(b).toContain(
      'Its whole-tree peak is 5,793 MiB, 673 MiB above its job commit limit of 5,120 MiB',
    );
    expect(b).toContain('PeakJobMemoryUsed');
    expect(b).toContain('the figures of this run cannot say which');
    const cell = (g: number) =>
      b.split('\n').find((l) => l.includes(`commit limit of ${g * GIB} bytes`))!;
    expect(cell(5)).toContain(
      'pass (whole-tree peak above the limit: not a result under this cap)',
    );
    expect(cell(8)).not.toContain('above the limit');
    expect(b.match(/is not a result under a/gu)).toHaveLength(1);
  });

  it('with no leg failed, the capped legs are said to show no limit taking effect; a failed leg, or no capped leg, removes that sentence', () => {
    const none = 'none of the capped legs shows the limit taking effect';
    const sentence = 'No leg in this file failed for want of memory';
    const quiet = block(leg(null, 5900), leg(8, 5790), leg(6, 5792));
    expect(quiet).toContain(`${sentence}, so ${none}`);
    expect(quiet).toContain('read the capped legs as the same run with the limit unproven');
    expect(quiet).not.toContain('is not a result under a');
    expect(
      block(leg(null, 5900), leg(8, 5790), leg(2, 2000, { fail: 'out_of_memory' })),
    ).not.toContain(sentence);
    expect(block(leg(null, 5900))).not.toContain(sentence);
    expect(block(leg(null, 5900))).not.toContain('unproven');
  });

  it('says each leg ran on its own VM and shows the Chrome build beside the commit, and only when there is more than one leg', () => {
    const b = block(leg(null, 5900, { chrome: 'Chrome/157.0.8103.79' }), leg(8, 5790));
    expect(b).toContain('Each leg ran on its own runner VM');
    expect(b).toContain('is not an effect of the cap');
    expect(b).toContain('scripts/win/README.md');
    expect(b).toContain('| Commit, Chrome |');
    expect(b).toContain('`5705baab8cdf`, Chrome/157.0.8103.79');
    expect(b).toContain('`5705baab8cdf`, Chrome/156.0.8078.80');
    expect(block(leg(null, 5900))).not.toContain('Each leg ran on its own runner VM');
  });

  it('never says a leg met, passed under or worked under a cap, and never calls an emulated figure a laptop result', () => {
    for (const b of [
      block(leg(5, 5793)),
      block(leg(8, 5790), leg(2, 2000, { fail: 'out_of_memory' })),
    ]) {
      expect(b.replaceAll('NOT met', '')).not.toMatch(/\bmet\b/u);
      expect(b).not.toMatch(/works? under|survives?|passes? under|within the cap/iu);
      expect(b.replaceAll('not a laptop', '')).not.toMatch(/laptop result|8 GB result/iu);
    }
  });

  it('the committed emulated CSVs are the first run: four legs in matrix order, six runs and 42 question rows each, nothing left out, no 8 GB cell filled', () => {
    const runs = parseCsv(
      readFileSync(join(root, 'docs', 'benchmarks', EMULATED_E2E_FILE), 'utf8'),
    );
    const qs = parseCsv(readFileSync(join(root, 'docs', 'benchmarks', EMULATED_Q_FILE), 'utf8'));
    expect(runs).toHaveLength(24);
    expect(qs).toHaveLength(168);
    const limits = [...new Set(runs.map((r) => r.job_commit_limit_bytes))];
    expect(limits).toEqual(['', String(8 * GIB), String(6 * GIB), String(5 * GIB)]);
    expect([...new Set(runs.map((r) => r.environment))]).toEqual([
      label(null),
      label(8),
      label(6),
      label(5),
    ]);
    for (const r of [...runs, ...qs]) expect(r.laptop_8gb).toBe(LAPTOP_8GB);
    expect([...new Set(runs.map((r) => r.commit))]).toEqual(['5705baab8cdf']);
    expect(new Set(runs.map((r) => r.failure_reason))).toEqual(new Set(['']));
    expect(new Set(runs.map((r) => r.requests_after_offline))).toEqual(new Set(['0']));
    expect(new Set(runs.map((r) => r.job_escapes))).toEqual(new Set(['0']));
    // the file was written before the limit evidence existed: its header is the first one, and every evidence cell reads as empty (limit unproven)
    expect(
      readFileSync(join(root, 'docs', 'benchmarks', EMULATED_E2E_FILE), 'utf8').split('\n')[0],
    ).toBe(E2E_EMULATED_COLUMNS_V1.join(','));
    // the job figures are the same on every row of a leg, and they are what the summary of that run gives: summaryCells() of the first run's summary shape is the same
    const caps: Record<string, string> = {
      '': 'none',
      [String(8 * GIB)]: '8GiB',
      [String(6 * GIB)]: '6GiB',
      [String(5 * GIB)]: '5GiB',
    };
    for (const l of limits) {
      const rows = runs.filter((r) => r.job_commit_limit_bytes === l);
      expect(rows).toHaveLength(6);
      const peaks = new Set(rows.map((r) => r.job_commit_peak_bytes));
      expect(peaks.size).toBe(1);
      const cells = summaryCells({
        cap: caps[l ?? '']!,
        limitBytes: l === '' || l === undefined ? null : Number(l),
        peakJobMemoryBytes: Number([...peaks][0]),
        escapes: 0,
      });
      expect(String(cells.job_commit_limit_bytes)).toBe(l);
      expect(String(cells.job_commit_peak_bytes)).toBe([...peaks][0]);
      expect(String(cells.job_escapes)).toBe('0');
      expect(limitProof(rows[0]!)).toBe(l === '' ? 'no_limit' : 'unproven');
    }
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

// ---- the limit evidence (after run 44656249868): the six evidence columns, the version 2 summary, "limit proven in force" and the control leg ----

const GIBN = 1073741824;
const MIBN = 1048576;
const ctlLabel = (gib: number | null, control = false) =>
  `emulated: GitHub-hosted Windows Server 2025 Datacenter VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree ${gib === null ? 'with no job limit' : `under a job commit limit of ${gib * GIBN} bytes${control ? ' (control leg, expected to fail)' : ''}`}; not a laptop`;

/** A version 2 job-summary.json as run-capped.ps1 writes it, for a capped leg whose limit is in force; `over` replaces top-level keys, `probe` the probe keys. */
const summaryV2 = (over: Record<string, unknown> = {}, probe: Record<string, unknown> = {}) => ({
  summaryVersion: 2,
  cap: '5GiB',
  limitBytes: 5 * GIBN,
  limitFlags: '0x2200',
  structSize: 144,
  controlLeg: false,
  limitSet: true,
  benchStarted: true,
  readBack: {
    expectedFlags: '0x2200',
    expectedJobMemoryLimit: 5 * GIBN,
    afterCreate: { flags: '0x2200', jobMemoryLimit: 5 * GIBN },
    afterAssign: { flags: '0x2200', jobMemoryLimit: 5 * GIBN },
    equal: true,
  },
  probe: {
    ran: true,
    refused: true,
    peakAfterBytes: 300 * MIBN,
    peakIncludesProbe: false,
    ...probe,
  },
  limitNotEnforced: false,
  completionPort: { attached: true, jobMemoryLimitMessages: 1 },
  peakJobMemoryBytes: 5800 * MIBN,
  escapes: 0,
  ...over,
});
const noLimitSummary = () =>
  summaryV2({
    cap: 'none',
    limitBytes: null,
    limitFlags: '0x2000',
    limitSet: false,
    readBack: {
      expectedFlags: '0x2000',
      expectedJobMemoryLimit: 0,
      afterCreate: { flags: '0x2000', jobMemoryLimit: 0 },
      afterAssign: { flags: '0x2000', jobMemoryLimit: 0 },
      equal: true,
    },
    probe: { ran: false, reason: 'no limit is set on this leg, so there is nothing to probe' },
  });

describe('bench-emulated-merge.mjs: the version 2 summary fills the evidence columns', () => {
  const rows = [fullRow({ run: '1' }), fullRow({ run: '2' })];
  const text = () => csv(E2E_EMULATED_COLUMNS, rows);
  const cellsOf = (summary: unknown) => parseCsv(merge(text(), summary))[0]!;

  it('a limit in force: the read-back, the refused probe, the peak after it and the port count are in every row, and the whole-tree peak is the benchmark one', () => {
    const o = cellsOf(summaryV2());
    expect(o).toMatchObject({
      job_commit_limit_bytes: String(5 * GIBN),
      job_commit_peak_bytes: String(5800 * MIBN),
      job_limit_readback_bytes: String(5 * GIBN),
      job_limit_flags_readback: '0x2200',
      limit_probe_refused: 'true',
      job_peak_after_probe_bytes: String(300 * MIBN),
      job_memory_limit_messages: '1',
      control_leg: 'false',
    });
    expect(limitProof(o)).toBe('proven');
    expect(parseCsv(merge(text(), summaryV2()))).toHaveLength(2);
  });

  it('a commit above the limit that succeeded reads false (not enforced); an inconclusive probe leaves the cell empty (unproven)', () => {
    const bad = cellsOf(summaryV2({ limitNotEnforced: true }, { refused: false }));
    expect(bad.limit_probe_refused).toBe('false');
    expect(limitProof(bad)).toBe('not_enforced');
    const unsure = cellsOf(summaryV2({}, { refused: null }));
    expect(unsure.limit_probe_refused).toBe('');
    expect(limitProof(unsure)).toBe('unproven');
  });

  it('a whole-tree peak that is the probe own (peakIncludesProbe) is written as an empty cell, never as a figure', () => {
    expect(cellsOf(summaryV2({}, { peakIncludesProbe: true })).job_commit_peak_bytes).toBe('');
    expect(cellsOf(summaryV2({}, { peakIncludesProbe: false })).job_commit_peak_bytes).toBe(
      String(5800 * MIBN),
    );
  });

  it('the leg with no limit records that none is set (read-back 0 and 0x2000), no probe, and is not a control', () => {
    const o = cellsOf(noLimitSummary());
    expect(o).toMatchObject({
      job_commit_limit_bytes: '',
      job_limit_readback_bytes: '0',
      job_limit_flags_readback: '0x2000',
      limit_probe_refused: '',
      job_peak_after_probe_bytes: '',
      control_leg: 'false',
    });
    expect(limitProof(o)).toBe('no_limit');
  });

  it('the control leg is marked control_leg true, with the evidence of its own limit', () => {
    const o = cellsOf(
      summaryV2({
        cap: '2GiB',
        limitBytes: 2 * GIBN,
        controlLeg: true,
        readBack: {
          equal: true,
          afterAssign: { flags: '0x2200', jobMemoryLimit: 2 * GIBN },
        },
      }),
    );
    expect(o).toMatchObject({ control_leg: 'true', job_commit_limit_bytes: String(2 * GIBN) });
    expect(limitProof(o)).toBe('proven');
  });

  it('an older summary (no summaryVersion) leaves the six cells empty, which reads as limit unproven', () => {
    const o = cellsOf({ cap: '5GiB', limitBytes: 5 * GIBN, peakJobMemoryBytes: 1, escapes: 0 });
    for (const c of E2E_EMULATED_COLUMNS.slice(E2E_EMULATED_COLUMNS_V1.length))
      expect(o[c], c).toBe('');
    expect(limitProof(o)).toBe('unproven');
  });

  it.each([
    ['a summaryVersion that is not 2', { summaryVersion: 3 }],
    ['controlLeg that does not match the cap', { controlLeg: true }],
    ['the 2GiB cap that is not marked control', { cap: '2GiB', limitBytes: 2 * GIBN }],
    ['limitSet that does not match limitBytes', { limitSet: false }],
    [
      'a benchmark that started although the read-back differs',
      { readBack: { ...summaryV2().readBack, equal: false } },
    ],
    [
      'a read-back whose limit is not the one that was set',
      {
        readBack: { ...summaryV2().readBack, afterAssign: { flags: '0x2200', jobMemoryLimit: 1 } },
      },
    ],
    [
      'a read-back with flags that are neither 0x2000 nor 0x2200',
      {
        readBack: {
          ...summaryV2().readBack,
          afterAssign: { flags: '0x2204', jobMemoryLimit: 5 * GIBN },
        },
      },
    ],
    ['a missing read-back', { readBack: undefined }],
    ['a probe on a leg with no probe record', { probe: undefined }],
    ['limitNotEnforced that contradicts the probe', { limitNotEnforced: true }],
    ['a missing completion port record', { completionPort: undefined }],
    [
      'a port count that is not an integer',
      { completionPort: { attached: true, jobMemoryLimitMessages: -1 } },
    ],
    ['a benchStarted that is not a boolean', { benchStarted: 'yes' }],
  ])('refuses %s', (_why, over) => {
    expect(() => merge(text(), summaryV2(over as Record<string, unknown>))).toThrow(
      /job-summary\.json/u,
    );
  });

  it('refuses a probe on the leg with no limit and a probe that did not run on a capped leg', () => {
    expect(() =>
      merge(text(), {
        ...noLimitSummary(),
        probe: { ran: true, refused: true, peakAfterBytes: 1, peakIncludesProbe: false },
      }),
    ).toThrow(/probe\.ran/u);
    expect(() => merge(text(), summaryV2({ probe: { ran: false } }))).toThrow(/probe\.ran/u);
  });

  it('a CSV with a header and no row stays a header and no blank line', () => {
    expect(merge(`${E2E_EMULATED_COLUMNS.join(',')}\n`, summaryV2())).toBe(
      `${E2E_EMULATED_COLUMNS.join(',')}\n`,
    );
  });
});

describe('bench-emulated-merge.mjs as a workflow step: a leg with no CSV has nothing to fill and nothing to say', () => {
  const run = (summary: unknown, withCsv: boolean) => {
    const dir = mkdtempSync(join(os.tmpdir(), 'dockit-merge-cli-'));
    const csvFile = join(dir, 'e2e-emulated-win-vm.csv');
    const summaryFile = join(dir, 'job-summary.json');
    if (withCsv) writeFileSync(csvFile, csv(E2E_EMULATED_COLUMNS, [fullRow()]));
    writeFileSync(summaryFile, JSON.stringify(summary));
    return spawnSync(
      process.execPath,
      [
        join(root, 'scripts', 'bench-emulated-merge.mjs'),
        '--csv',
        csvFile,
        '--summary',
        summaryFile,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
  };
  it('a benchmark that never started: exit 0, one line, no stderr', () => {
    const r = run(
      { ...summaryV2(), benchStarted: false, failReason: 'limit_readback_mismatch' },
      false,
    );
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });
  it('a control leg that wrote no row: exit 0, one line, no stderr', () => {
    const r = run(
      summaryV2({
        cap: '2GiB',
        limitBytes: 2 * GIBN,
        controlLeg: true,
        readBack: { equal: true, afterAssign: { flags: '0x2200', jobMemoryLimit: 2 * GIBN } },
      }),
      false,
    );
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    expect(r.stdout).toContain('a control leg that wrote no row');
  });
  it('any other leg with no CSV is still an error, and says which file is missing', () => {
    const r = run(summaryV2(), false);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot read .*e2e-emulated-win-vm\.csv\s*$/u);
    expect(r.stderr).not.toMatch(/is job-summary\.json written/u);
    // and so is the summary of the first run, which has no benchStarted
    expect(
      run({ cap: '5GiB', limitBytes: 5 * GIBN, peakJobMemoryBytes: 1, escapes: 0 }, false).status,
    ).toBe(1);
  });
  it('a leg that has its CSV is filled as before', () => {
    const r = run(summaryV2(), true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('filled the job columns');
  });
});

describe('csv(): the evidence cells are checked on the way out', () => {
  it.each([
    ['limit_probe_refused', 'maybe'],
    ['control_leg', 'yes'],
    ['job_limit_flags_readback', '0x2204'],
    ['job_limit_readback_bytes', '-1'],
    ['job_peak_after_probe_bytes', '1e9'],
    ['job_memory_limit_messages', '1.5'],
  ])('refuses %s = %s', (col, bad) => {
    expect(() => csv(E2E_EMULATED_COLUMNS, [fullRow({ [col]: bad })])).toThrow(
      new RegExp(col, 'u'),
    );
  });
  it('accepts every legal value, and the run-0 row carries six empty evidence cells', () => {
    for (const v of ['', 'true', 'false'])
      expect(() =>
        csv(E2E_EMULATED_COLUMNS, [fullRow({ limit_probe_refused: v, control_leg: v })]),
      ).not.toThrow();
    for (const v of ['', '0x2000', '0x2200'])
      expect(() =>
        csv(E2E_EMULATED_COLUMNS, [fullRow({ job_limit_flags_readback: v })]),
      ).not.toThrow();
    const z = runZeroRows({ date: 'd', label: LABEL, commit: 'c', reason: 'out_of_memory' }).e2e;
    for (const c of E2E_EMULATED_COLUMNS.slice(E2E_EMULATED_COLUMNS_V1.length))
      expect(z[c], c).toBe('');
  });
});

describe('the README subsection: limit proven in force, the cap not in force, and the control leg', () => {
  type Opts = {
    control?: boolean;
    fail?: boolean;
    evidence?: Record<string, string>;
    peak?: string;
    chromePeakMiB?: number;
    runs?: number;
  };
  /** Rows of one leg as the merge step leaves them: the job figures and the evidence on every row. */
  const leg = (gib: number | null, peakMiB: number | null, o: Opts = {}) => {
    const control = o.control === true;
    const n = o.fail ? 1 : (o.runs ?? 6);
    return Array.from({ length: n }, (_, i) =>
      fullRow({
        environment: ctlLabel(gib, control),
        machine: ctlLabel(gib, control),
        chrome: 'Chrome/156.0.8078.80',
        commit: 'abcabcabcabc',
        run: o.fail ? '0' : String(i + 1),
        restart: !o.fail && i === 5 ? 'true' : 'false',
        first_token_ms: o.fail ? '' : '9000',
        total_ms: o.fail ? '' : '14000',
        process_commit_peak_bytes: o.fail ? '' : String((o.chromePeakMiB ?? 4000) * MIBN),
        job_commit_limit_bytes: gib === null ? '' : String(gib * GIBN),
        job_commit_peak_bytes: o.peak ?? (peakMiB === null ? '' : String(peakMiB * MIBN)),
        job_escapes: '0',
        sampler_median_interval_ms: '540',
        requests_after_offline: '0',
        failure_reason: o.fail ? 'out_of_memory' : '',
        control_leg: control ? 'true' : 'false',
        ...(gib === null
          ? { job_limit_readback_bytes: '0', job_limit_flags_readback: '0x2000' }
          : {
              job_limit_readback_bytes: String(gib * GIBN),
              job_limit_flags_readback: '0x2200',
              limit_probe_refused: 'true',
              job_peak_after_probe_bytes: String(300 * MIBN),
              job_memory_limit_messages: '1',
            }),
        ...(o.evidence ?? {}),
      }),
    );
  };
  const block = (...legs: ReturnType<typeof leg>[]) =>
    emulatedBlock(csv(E2E_EMULATED_COLUMNS, legs.flat()));
  const tableLines = (b: string) => b.split('\n').filter((l) => l.startsWith('| emulated:'));
  const PROVEN = 'limit proven in force (probe refused, read-back equal)';

  it('says proven only when the read-back is equal AND the probe was refused; the leg with no limit says no limit set', () => {
    const b = block(leg(null, 5900), leg(8, 5790), leg(6, 5792));
    const cell = (g: number | null) =>
      tableLines(b).find((l) =>
        l.includes(g === null ? 'no job limit' : `commit limit of ${g * GIBN} bytes`),
      )!;
    expect(cell(8)).toContain(`| 8 GiB | ${PROVEN} |`);
    expect(cell(6)).toContain(`| 6 GiB | ${PROVEN} |`);
    expect(cell(null)).toContain('| no limit | no limit set (read-back: JobMemoryLimit 0) |');
    // every capped leg proven: the paragraph says so, and none of the unproven wording is left
    expect(b).toContain('The limit of every capped leg is proven in force');
    expect(b).not.toContain('limit unproven');
    expect(b).not.toContain('No leg in this file failed for want of memory');
    expect(b).not.toContain('is not a result under a');
    // the evidence table: the read-back, the refusal, whether the refused commit is counted in the peak (here: no, 300 MiB is far below the limit), the port count
    expect(b).toContain(
      '| 8 GiB | 0x2200, 8,589,934,592 bytes (equal to what was set) | refused | no: 300 MiB is below the limit of 8,192 MiB | 300 MiB | 1 |',
    );
  });

  it('a read-back that is equal without a refused probe, or a refused probe without an equal read-back, is not proven', () => {
    const noProbe = block(leg(8, 5790, { evidence: { limit_probe_refused: '' } }));
    expect(noProbe).toContain('| 8 GiB | limit unproven |');
    expect(noProbe).not.toContain(PROVEN);
    expect(noProbe).toContain('No leg in this file failed for want of memory');
    const noReadBack = block(
      leg(8, 5790, { evidence: { job_limit_readback_bytes: '', job_limit_flags_readback: '' } }),
    );
    expect(noReadBack).toContain('| 8 GiB | limit unproven |');
    expect(noReadBack).not.toContain(PROVEN);
    const differs = block(
      leg(8, 5790, { evidence: { job_limit_readback_bytes: String(8 * GIBN - 4096) } }),
    );
    expect(differs).toContain(`| 8 GiB | ${LIMIT_PROOF_TEXT.readback_mismatch} |`);
    expect(differs).not.toContain(PROVEN);
  });

  it('one leg proven and one not: only the proven one says so, and the unproven one keeps the unproven wording', () => {
    const b = block(
      leg(8, 5790),
      leg(5, 5793, {
        evidence: {
          limit_probe_refused: '',
          job_limit_readback_bytes: '',
          job_limit_flags_readback: '',
        },
      }),
    );
    expect(b).toContain(`| 8 GiB | ${PROVEN} |`);
    expect(b).toContain('| 5 GiB | limit unproven |');
    expect(b).not.toContain('The limit of every capped leg is proven in force');
    expect(b).toContain('The 5 GiB leg is not a result under a 5 GiB cap.');
    expect(b).toContain('read the capped legs as the same run with the limit unproven');
  });

  it('a commit above the limit that succeeded: the cap was not in force, in the cell, in a paragraph of its own, and the leg is not called proven or a result under a cap', () => {
    const b = block(leg(null, 5900), leg(8, 5790, { evidence: { limit_probe_refused: 'false' } }));
    expect(b).toContain('| 8 GiB | cap NOT in force (the probe committed over the limit) |');
    expect(b).toContain("**The 8 GiB leg's cap was not in force.**");
    expect(b).toContain(
      'A commit of the limit plus 256 MiB, made from inside the job before the benchmark started, succeeded',
    );
    expect(b).toContain('not a result under a 8 GiB cap');
    expect(b).not.toContain(PROVEN);
    expect(b).toContain(
      '| 8 GiB | 0x2200, 8,589,934,592 bytes (equal to what was set) | succeeded: the cap was not in force |',
    );
  });

  it('a refused commit that is counted in the peak shows in the evidence table, and a whole-tree peak that is the probe own is not measured', () => {
    const b = block(
      leg(6, null, {
        peak: '',
        evidence: { job_peak_after_probe_bytes: String(6 * GIBN + 300 * MIBN) },
      }),
    );
    expect(b).toContain('yes: 6,444 MiB is above the limit of 6,144 MiB');
    expect(b).toContain('**The whole-tree peak of the 6 GiB leg is not measured.**');
    expect(b).toContain('read 6,444 MiB right after the commit probe');
    expect(tableLines(b)[0]).toContain('| not measured |');
  });

  it('a proven leg whose peak is above its limit says the peak counts commits the limit refused, not that the leg is no result', () => {
    const b = block(leg(5, 5793));
    expect(b).toContain(
      "**The 5 GiB leg's whole-tree peak is above its limit, and the limit is proven in force.**",
    );
    expect(b).toContain(
      'counts a commit that the limit refused: the peak is not memory the tree held',
    );
    expect(b).toContain('whole-tree peak above a limit that is proven in force');
    expect(b).not.toContain('is not a result under a');
  });

  describe('the control leg', () => {
    const benchLegs = () => [leg(null, 5900), leg(8, 5790), leg(5, 4900)];
    it('is a paragraph of its own, from its own rows: failed as it must with the limit proven, below the lowest Chrome-only peak of the other legs', () => {
      const b = block(...benchLegs(), leg(2, null, { control: true, fail: true }));
      expect(b).toContain('**Control leg, 2 GiB: not a benchmark figure.**');
      expect(b).toContain(
        'its limit is below the lowest Chrome-only commit peak of any run of the other legs (4,000 MiB)',
      );
      expect(b).toContain(
        'It failed with `out_of_memory` after 0 completed run(s), as it must: the limit is proven in force (probe refused, read-back equal), so the control passed.',
      );
      expect(b).toContain(`Label: \`${ctlLabel(2, true)}\``);
      expect(b).toContain('A further control leg');
      // the evidence of the control is in the evidence table, marked as the control
      expect(b).toContain(
        '| 2 GiB (control) | 0x2200, 2,147,483,648 bytes (equal to what was set) | refused |',
      );
      expect(b).not.toContain('the cap does nothing');
    });

    it('is in none of the figures: the benchmark rows of the table are the same with and without it', () => {
      const without = block(...benchLegs());
      const withControl = block(...benchLegs(), leg(2, 2000, { control: true, fail: true }));
      expect(tableLines(withControl)).toEqual(tableLines(without));
      expect(tableLines(withControl)).toHaveLength(3);
      expect(tableLines(withControl).join('\n')).not.toContain('2147483648');
      expect(withControl).not.toContain(
        'Each leg ran on its own runner VM'.replace('Each', 'Every'),
      );
    });

    it('a control that completed is a red paragraph: the cap does nothing, so no capped leg of the file means anything', () => {
      const b = block(
        ...benchLegs(),
        leg(2, 5000, { control: true, evidence: { limit_probe_refused: 'false' } }),
      );
      expect(b).toContain(
        '**It completed under the control limit (6 runs): the cap does nothing, so no capped leg of this file means anything.**',
      );
      expect(tableLines(b)).toHaveLength(3);
    });

    it('a control that failed without a proven limit shows nothing about the cap', () => {
      const b = block(
        ...benchLegs(),
        leg(2, null, { control: true, fail: true, evidence: { limit_probe_refused: '' } }),
      );
      expect(b).toContain(
        'but the limit is not proven in force (limit unproven), so the stop shows nothing about the cap.',
      );
      expect(b).not.toContain('so the control passed');
    });

    it('a control with some rows but no failure and no completion says it did not complete', () => {
      const b = block(...benchLegs(), leg(2, null, { control: true, runs: 2 }));
      expect(b).toContain(
        'It did not complete (2 row(s), 2 finished run(s), no failure reason recorded',
      );
    });

    it('a control failure means the unproven legs are not said to be unfailed: the old paragraph is not printed', () => {
      const unproven = {
        evidence: {
          limit_probe_refused: '',
          job_limit_readback_bytes: '',
          job_limit_flags_readback: '',
        },
      };
      const b = block(leg(8, 5790, unproven), leg(2, null, { control: true, fail: true }));
      expect(b).not.toContain('No leg in this file failed for want of memory');
    });

    it('rows of one environment that disagree on control_leg are refused', () => {
      const rows = [
        ...leg(2, null, { control: true, fail: true }),
        ...leg(2, null, { control: true, fail: true }),
      ];
      rows[1] = { ...rows[1]!, control_leg: 'false' };
      expect(() => emulatedBlock(csv(E2E_EMULATED_COLUMNS, rows))).toThrow(/control_leg/u);
    });

    it('never says met, passes under, works under or within the cap, and never calls an emulated figure a laptop result', () => {
      for (const b of [
        block(...benchLegs(), leg(2, null, { control: true, fail: true })),
        block(...benchLegs(), leg(2, 5000, { control: true })),
        block(leg(8, 5790, { evidence: { limit_probe_refused: 'false' } })),
        block(leg(6, 5792)),
      ]) {
        expect(b.replaceAll('NOT met', '')).not.toMatch(/\bmet\b/u);
        expect(b).not.toMatch(/works? under|survives?|passes? under|within the cap/iu);
        expect(b.replaceAll('not a laptop', '')).not.toMatch(/laptop result|8 GB result/iu);
      }
    });
  });

  it('a file with the first header (written before the evidence existed) still renders, every capped leg unproven', () => {
    const v1 = (rows: ReturnType<typeof leg>) =>
      rows.map((r) =>
        Object.fromEntries(
          E2E_EMULATED_COLUMNS_V1.map((c) => [c, (r as Record<string, unknown>)[c]]),
        ),
      );
    const b = emulatedBlock(
      csv(E2E_EMULATED_COLUMNS_V1, [...v1(leg(null, 5900)), ...v1(leg(8, 5790))]),
    );
    expect(b).toContain('| 8 GiB | limit unproven |');
    expect(b).not.toContain(PROVEN);
    expect(b).not.toContain('Limit evidence');
  });

  it('the shared probe size is what the wording says', () => {
    expect(PROBE_OVER_LIMIT_BYTES).toBe(256 * MIBN);
  });
});
