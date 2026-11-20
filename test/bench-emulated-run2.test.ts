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
  E2E_EMULATED_COLUMNS,
  E2E_EMULATED_COLUMNS_V1,
  E2E_EMULATED_COLUMNS_V2,
  LAPTOP_8GB,
  LEG_CAPS,
  csv,
  limitMessages,
  limitProof,
  runZeroRows,
} from '../scripts/lib/bench-columns.mjs';
import { controlMarkerCsv, merge, summaryCells } from '../scripts/bench-emulated-merge.mjs';
import { emulatedBlock, parseCsv } from '../scripts/bench-readme.mjs';
import { SPAWN_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';

// Run 44666921454 (dockit f6a71ca, 20 Nov 2026) is the first run of bench-windows that read the limit back, probed it and had a control leg. These tests pin the new
// evidence column (the probe's own memory-limit message, so that what happened DURING the benchmark can be told from what the probe caused), the marker row of a control leg that
// wrote no benchmark row, the wording of the README block, and the committed import of the run itself. Nothing here fills a laptop cell.
const root = join(import.meta.dirname, '..');
vi.setConfig({ testTimeout: SPAWN_TEST_TIMEOUT_MS });
guardLaptopCsvs();

const GIB = 1073741824;
const MIB = 1048576;
const RUN = '44666921454';
const EVIDENCE_DIR = join(root, 'docs', 'benchmarks', `emulated-win-vm-run-${RUN}`);
const CAPS = ['none', '8GiB', '6GiB', '5GiB', '2GiB'] as const;
const label = (gib: number | null, control = false) =>
  `emulated: GitHub-hosted Windows Server 2025 Datacenter VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree ${gib === null ? 'with no job limit' : `under a job commit limit of ${gib * GIB} bytes${control ? ' (control leg, expected to fail)' : ''}`}; not a laptop`;
const PROVEN = 'limit proven in force (probe refused, read-back equal)';

describe('the probe message column and the three headers', () => {
  it('V2 is the header the first limit-evidence dispatch wrote (V1 plus six evidence columns); the current header adds the probe message count after control_leg', () => {
    expect([...E2E_EMULATED_COLUMNS_V2]).toEqual([
      ...E2E_EMULATED_COLUMNS_V1,
      'job_limit_readback_bytes',
      'job_limit_flags_readback',
      'limit_probe_refused',
      'job_peak_after_probe_bytes',
      'job_memory_limit_messages',
      'control_leg',
    ]);
    expect([...E2E_EMULATED_COLUMNS]).toEqual([
      ...E2E_EMULATED_COLUMNS_V2,
      'probe_memory_limit_messages',
    ]);
    expect(new Set(E2E_EMULATED_COLUMNS).size).toBe(E2E_EMULATED_COLUMNS.length);
  });

  it('a committed file has the current header or the first one; V2 only ever comes out of a dispatch, and the merge step upgrades it', () => {
    expect([...EMULATED_HEADERS]).toEqual([
      E2E_EMULATED_COLUMNS.join(','),
      E2E_EMULATED_COLUMNS_V1.join(','),
    ]);
  });

  it('the run-0 row carries an empty probe count, and csv() accepts empty or a count and refuses anything else, or a probe count above the whole-run count', () => {
    const z = runZeroRows({ date: 'd', label: label(null), commit: 'c', reason: 'out_of_memory' });
    expect(z.e2e['probe_memory_limit_messages']).toBe('');
    const row = (over: Record<string, string>) => ({
      ...z.e2e,
      environment: label(5),
      machine: label(5),
      ...over,
    });
    expect(() =>
      csv(E2E_EMULATED_COLUMNS, [row({ probe_memory_limit_messages: '1' })]),
    ).not.toThrow();
    for (const bad of ['-1', '1.5', '1e3', 'x'])
      expect(() => csv(E2E_EMULATED_COLUMNS, [row({ probe_memory_limit_messages: bad })])).toThrow(
        /probe_memory_limit_messages/u,
      );
    expect(() =>
      csv(E2E_EMULATED_COLUMNS, [
        row({ probe_memory_limit_messages: '3', job_memory_limit_messages: '2' }),
      ]),
    ).toThrow(/probe_memory_limit_messages/u);
  });
});

describe('limitMessages(): the probe own message told from the ones posted while the benchmark ran', () => {
  const capped = (total: string, probe: string) => ({
    job_commit_limit_bytes: String(5 * GIB),
    job_memory_limit_messages: total,
    probe_memory_limit_messages: probe,
  });
  const cases: {
    why: string;
    row: Record<string, string>;
    expected: [number | null, number | null, number | null];
  }[] = [
    {
      why: '5 GiB leg of run 44666921454: 3 in all, 1 from the probe',
      row: capped('3', '1'),
      expected: [3, 1, 2],
    },
    {
      why: '8 GiB leg of that run: only the probe own',
      row: capped('1', '1'),
      expected: [1, 1, 0],
    },
    {
      why: 'a leg with no limit has no probe: every message is the benchmark one',
      row: {
        job_commit_limit_bytes: '',
        job_memory_limit_messages: '0',
        probe_memory_limit_messages: '',
      },
      expected: [0, null, 0],
    },
    {
      why: 'no completion port: nothing is known',
      row: capped('', ''),
      expected: [null, null, null],
    },
    {
      why: 'a capped leg whose probe count was not recorded: the benchmark count is not known',
      row: capped('3', ''),
      expected: [3, null, null],
    },
    {
      why: 'a file written before the column existed (no such key)',
      row: { job_commit_limit_bytes: String(5 * GIB), job_memory_limit_messages: '3' },
      expected: [3, null, null],
    },
  ];
  it.each(cases)('$why', ({ row, expected: [total, probe, benchmark] }) => {
    expect(limitMessages(row)).toEqual({ total, probe, benchmark });
  });
  it('a probe count above the whole-run count is a contradiction and throws', () => {
    expect(() => limitMessages(capped('1', '2'))).toThrow(/probe/u);
  });
});

// ---- the merge step ----

const summary = (over: Record<string, unknown> = {}, probe: Record<string, unknown> = {}) => ({
  summaryVersion: 2,
  cap: '5GiB',
  limitBytes: 5 * GIB,
  limitFlags: '0x2200',
  structSize: 144,
  label: label(5),
  controlLeg: false,
  limitSet: true,
  benchStarted: true,
  readBack: {
    expectedFlags: '0x2200',
    expectedJobMemoryLimit: 5 * GIB,
    afterCreate: { flags: '0x2200', jobMemoryLimit: 5 * GIB },
    afterAssign: { flags: '0x2200', jobMemoryLimit: 5 * GIB },
    equal: true,
  },
  probe: {
    ran: true,
    refused: true,
    peakAfterBytes: 5735489536,
    peakIncludesProbe: false,
    jobMemoryLimitMessagesAfterProbe: 1,
    ...probe,
  },
  limitNotEnforced: false,
  completionPort: { attached: true, jobMemoryLimitMessages: 3 },
  peakJobMemoryBytes: 6092845056,
  escapes: 0,
  ...over,
});
const rowV2 = (over: Record<string, unknown> = {}) => ({
  ...Object.fromEntries(E2E_EMULATED_COLUMNS_V2.map((c) => [c, ''])),
  date: '2026-11-20T03:22:56.630Z',
  commit: 'f6a71cab4ab1',
  run: '1',
  restart: 'false',
  answer_ok: 'true',
  laptop_8gb: LAPTOP_8GB,
  environment: label(5),
  machine: label(5),
  ...over,
});

describe('bench-emulated-merge.mjs: the probe message count', () => {
  const cells = (s: unknown) => summaryCells(s) as Record<string, unknown>;
  it('writes the count the completion port had when the probe ended, next to the whole-run count', () => {
    expect(cells(summary())).toMatchObject({
      job_memory_limit_messages: 3,
      probe_memory_limit_messages: 1,
    });
  });
  it('leaves it empty when no port was attached, when there was no probe, when the summary does not hold the count, and for a summary written before the evidence existed', () => {
    expect(
      cells(
        summary(
          { completionPort: { attached: false } },
          { jobMemoryLimitMessagesAfterProbe: null },
        ),
      ),
    ).toMatchObject({ job_memory_limit_messages: '', probe_memory_limit_messages: '' });
    expect(cells(summary({}, { jobMemoryLimitMessagesAfterProbe: undefined }))).toMatchObject({
      probe_memory_limit_messages: '',
    });
    expect(
      cells({ cap: '5GiB', limitBytes: 5 * GIB, peakJobMemoryBytes: 1, escapes: 0 }),
    ).toMatchObject({ probe_memory_limit_messages: '' });
  });
  it('refuses a count that is not an integer, and one that is above the whole-run count (the port counts upwards)', () => {
    expect(() => summaryCells(summary({}, { jobMemoryLimitMessagesAfterProbe: -1 }))).toThrow(
      /job-summary\.json/u,
    );
    expect(() => summaryCells(summary({}, { jobMemoryLimitMessagesAfterProbe: 'one' }))).toThrow(
      /job-summary\.json/u,
    );
    expect(() => summaryCells(summary({}, { jobMemoryLimitMessagesAfterProbe: 4 }))).toThrow(
      /job-summary\.json/u,
    );
  });
  it('a CSV with the version 2 header (what the dispatch wrote) is accepted and comes out with the current header; the first header is still refused', () => {
    const out = merge(csv(E2E_EMULATED_COLUMNS_V2, [rowV2()]), summary());
    expect(out.split('\n')[0]).toBe(E2E_EMULATED_COLUMNS.join(','));
    const [r] = parseCsv(out);
    expect(r).toMatchObject({
      job_memory_limit_messages: '3',
      probe_memory_limit_messages: '1',
      commit: 'f6a71cab4ab1',
    });
    expect(limitProof(r!)).toBe('proven');
    expect(limitMessages(r!)).toEqual({ total: 3, probe: 1, benchmark: 2 });
    expect(() => merge(csv(E2E_EMULATED_COLUMNS_V1, [rowV2()]), summary())).toThrow(
      /not E2E_EMULATED_COLUMNS/u,
    );
  });
});

describe('a control leg that wrote no benchmark row gets one marker row', () => {
  const control = (over: Record<string, unknown> = {}) =>
    summary({
      cap: '2GiB',
      limitBytes: 2 * GIB,
      label: label(2, true),
      controlLeg: true,
      readBack: {
        equal: true,
        afterAssign: { flags: '0x2200', jobMemoryLimit: 2 * GIB },
      },
      completionPort: { attached: true, jobMemoryLimitMessages: 2 },
      peakJobMemoryBytes: 2507501568,
      ...over,
    });
  it('is run 0 with every figure empty and no failure reason, the label verbatim, the evidence of the leg and the 8 GB phrase', () => {
    const [r] = parseCsv(
      controlMarkerCsv(control({ probe: { ...control().probe, peakIncludesProbe: true } }), {
        commit: 'f6a71cab4ab1',
        date: '',
      }),
    );
    expect(r).toMatchObject({
      run: '0',
      restart: 'false',
      answer_ok: 'false',
      failure_reason: '',
      environment: label(2, true),
      machine: label(2, true),
      commit: 'f6a71cab4ab1',
      laptop_8gb: LAPTOP_8GB,
      control_leg: 'true',
      job_commit_limit_bytes: String(2 * GIB),
      job_commit_peak_bytes: '',
      first_token_ms: '',
      total_ms: '',
      process_commit_peak_bytes: '',
      limit_probe_refused: 'true',
      job_memory_limit_messages: '2',
      probe_memory_limit_messages: '1',
    });
    expect(limitProof(r!)).toBe('proven');
  });
  it('is only for a control leg whose benchmark started, and needs a label the writer accepts', () => {
    expect(() => controlMarkerCsv(summary(), {})).toThrow(/control leg/u);
    expect(() => controlMarkerCsv(control({ benchStarted: false }), {})).toThrow(/control leg/u);
    expect(() => controlMarkerCsv(control({ label: 'a laptop' }), {})).toThrow(
      /environment label/u,
    );
  });
  describe('as a workflow step', () => {
    const run = (s: unknown, env: Record<string, string> = {}) => {
      const dir = mkdtempSync(join(os.tmpdir(), 'dockit-marker-'));
      const csvFile = join(dir, 'e2e-emulated-win-vm.csv');
      const summaryFile = join(dir, 'job-summary.json');
      writeFileSync(summaryFile, JSON.stringify(s));
      const r = spawnSync(
        process.execPath,
        [
          join(root, 'scripts', 'bench-emulated-merge.mjs'),
          '--csv',
          csvFile,
          '--summary',
          summaryFile,
        ],
        { encoding: 'utf8', timeout: 20_000, env: { ...process.env, GITHUB_SHA: '', ...env } },
      );
      return { r, text: existsSync(csvFile) ? readFileSync(csvFile, 'utf8') : undefined };
    };
    it('writes the marker row, taking the commit from GITHUB_SHA (twelve characters), and says so in one line', () => {
      const { r, text } = run(control(), {
        GITHUB_SHA: 'f6a71cab4ab1dbc06a986f05cb7affd7a844a98e',
      });
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(r.stdout.trim().split('\n')).toHaveLength(1);
      expect(r.stdout).toContain('marker row');
      const rows = parseCsv(text!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ run: '0', commit: 'f6a71cab4ab1', control_leg: 'true' });
    });
    it('without GITHUB_SHA the commit cell is empty, not invented', () => {
      expect(parseCsv(run(control()).text!)[0]!['commit']).toBe('');
    });
    it('a summary with no usable label keeps the old behaviour: nothing is written, exit 0, one line', () => {
      const { r, text } = run(control({ label: undefined }));
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(text).toBeUndefined();
      expect(r.stdout).toContain('a control leg that wrote no row');
    });
  });
});

// ---- the README block: what the legs show about the commit limit, in words computed from the rows ----

describe('the README block says whether commits were refused while the benchmark ran', () => {
  type Opts = {
    total?: number;
    probe?: number;
    peakMiB?: number | null;
    runs?: number;
    control?: boolean;
  };
  const leg = (gib: number | null, o: Opts = {}) =>
    Array.from({ length: o.runs ?? 6 }, (_, i) => ({
      ...Object.fromEntries(E2E_EMULATED_COLUMNS.map((c) => [c, ''])),
      date: 'd',
      chrome: 'Chrome/157.0.8103.79',
      commit: 'f6a71cab4ab1',
      run: String(i + 1),
      restart: i === 5 ? 'true' : 'false',
      answer_ok: 'true',
      first_token_ms: '9000',
      total_ms: '14000',
      requests_after_offline: '0',
      laptop_8gb: LAPTOP_8GB,
      environment: label(gib, o.control),
      machine: label(gib, o.control),
      job_commit_limit_bytes: gib === null ? '' : String(gib * GIB),
      job_commit_peak_bytes: o.peakMiB === null ? '' : String((o.peakMiB ?? 5800) * MIB),
      process_commit_peak_bytes: String(4000 * MIB),
      job_escapes: '0',
      sampler_median_interval_ms: '540',
      control_leg: o.control ? 'true' : 'false',
      ...(gib === null
        ? {
            job_limit_readback_bytes: '0',
            job_limit_flags_readback: '0x2000',
            job_memory_limit_messages: '0',
          }
        : {
            job_limit_readback_bytes: String(gib * GIB),
            job_limit_flags_readback: '0x2200',
            limit_probe_refused: 'true',
            job_peak_after_probe_bytes: String(gib * GIB + 300 * MIB),
            job_memory_limit_messages: String(o.total ?? 1),
            probe_memory_limit_messages: String(o.probe ?? 1),
          }),
    }));
  const q = (gib: number | null, correct: number, of = 36) => {
    const rows = [];
    for (let i = 0; i < of; i++)
      rows.push({
        date: 'd',
        machine: label(gib),
        commit: 'f6a71cab4ab1',
        run: String(Math.floor(i / 6) + 1),
        restart: 'false',
        qid: `q${(i % 6) + 1}`,
        answer_ok: String(i < correct),
        correct_source_page: String(i < correct),
        top_retrieved_page_ok: 'true',
        first_token_ms: '9000',
        total_ms: '14000',
        laptop_8gb: LAPTOP_8GB,
        environment: label(gib),
        failure_reason: '',
      });
    return rows;
  };
  const Q_COLS = Object.keys(q(null, 1, 1)[0]!);
  const block = (legs: ReturnType<typeof leg>[], questions?: ReturnType<typeof q>) =>
    emulatedBlock(
      csv(E2E_EMULATED_COLUMNS, legs.flat()),
      questions === undefined ? undefined : csv(Q_COLS, questions),
    );
  const line = (b: string, gib: number | null) =>
    b
      .split('\n')
      .find(
        (l) =>
          l.startsWith('| emulated:') &&
          l.includes(gib === null ? 'no job limit' : `commit limit of ${gib * GIB} bytes`),
      )!;

  it('a proven leg with memory-limit messages beyond the probe own says commits were refused while the benchmark ran, with the count, and that the leg still finished', () => {
    const b = block([leg(null), leg(5, { total: 3, probe: 1 })], [...q(null, 24), ...q(5, 24)]);
    expect(line(b, 5)).toContain(`| ${PROVEN} |`);
    expect(line(b, 5)).toContain(
      "yes: 2 messages while the benchmark ran (the probe's 1 not counted)",
    );
    expect(b).toContain(
      '**The 5 GiB leg had commits refused while the benchmark ran, and the leg still finished.**',
    );
    expect(b).toContain(
      'received 2 JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages while the benchmark ran',
    );
    expect(b).toContain('besides the 1 the probe caused');
    expect(b).toContain('All 6 runs of the leg finished with no failure reason');
    expect(b).toContain(
      '24 of 36 answers with the cited page correct (the same as the no-limit leg',
    );
    // the whole-run count and the probe own count are columns of the evidence table, and the benchmark count is the difference
    expect(b).toContain(
      '| 5 GiB | 0x2200, 5,368,709,120 bytes (equal to what was set) | refused | yes: 5,420 MiB is above the limit of 5,120 MiB | 5,420 MiB | 3 | 1 | 2 |',
    );
  });

  it('a proven leg whose only message is the probe own says no commit was refused while the benchmark ran', () => {
    const b = block([leg(null), leg(8), leg(6)], [...q(null, 24), ...q(8, 24), ...q(6, 24)]);
    expect(line(b, 8)).toContain("none (the probe's 1 not counted)");
    expect(line(b, 6)).toContain("none (the probe's 1 not counted)");
    expect(b).toContain(
      '**No commit was refused while the benchmark ran on the 8 GiB and 6 GiB legs.**',
    );
    expect(b).toContain(
      'The only memory-limit message the completion port received on each was the one the probe caused',
    );
    expect(b).not.toContain('had commits refused while the benchmark ran');
  });

  it('the leg with no limit has nothing to refuse, a leg without a probe count says not counted, a file with no port says no port', () => {
    const none = block([leg(null)]);
    expect(line(none, null)).toContain('| no limit |');
    expect(none).not.toContain('commits refused while the benchmark ran, and');
    const uncounted = block([
      leg(5, { total: 3 }).map((r) => ({ ...r, probe_memory_limit_messages: '' })),
    ]);
    expect(line(uncounted, 5)).toContain('| not counted |');
    expect(uncounted).not.toContain('had commits refused');
    expect(uncounted).not.toContain('No commit was refused');
    const noPort = block([
      leg(5).map((r) => ({ ...r, job_memory_limit_messages: '', probe_memory_limit_messages: '' })),
    ]);
    expect(line(noPort, 5)).toContain('| no port |');
  });

  it('an unproven leg or one whose cap was not in force never gets the sentence: a refusal counted under a limit nobody proved says nothing about the limit', () => {
    const unproven = block([
      leg(5, { total: 3, probe: 1 }).map((r) => ({ ...r, limit_probe_refused: '' })),
    ]);
    expect(unproven).not.toContain('had commits refused');
    expect(unproven).toContain('| limit unproven |');
    const notEnforced = block([
      leg(5, { total: 3, probe: 1 }).map((r) => ({ ...r, limit_probe_refused: 'false' })),
    ]);
    expect(notEnforced).not.toContain('had commits refused');
  });

  it('the question set of each leg is computed from the questions CSV, and says not measured without it', () => {
    const withQ = block([leg(null), leg(8)], [...q(null, 24), ...q(8, 20)]);
    expect(line(withQ, null)).toContain('| 24 of 36 |');
    expect(line(withQ, 8)).toContain('| 20 of 36 |');
    expect(line(block([leg(8)]), 8)).toContain('| not measured |');
  });

  it('a control leg that has only its marker row did not complete, and passed because the limit is proven in force', () => {
    const marker = runZeroRows({
      date: '',
      label: label(2, true),
      commit: 'f6a71cab4ab1',
      reason: '',
    }).e2e;
    const rows = [
      {
        ...marker,
        job_commit_limit_bytes: String(2 * GIB),
        job_limit_readback_bytes: String(2 * GIB),
        job_limit_flags_readback: '0x2200',
        limit_probe_refused: 'true',
        job_peak_after_probe_bytes: String(2 * GIB + 300 * MIB),
        job_memory_limit_messages: '2',
        probe_memory_limit_messages: '1',
        control_leg: 'true',
      },
    ];
    const b = emulatedBlock(
      csv(E2E_EMULATED_COLUMNS, [...leg(null).flat(), ...leg(5).flat(), ...rows]),
    );
    expect(b).toContain('**Control leg, 2 GiB: not a benchmark figure.**');
    expect(b).toContain(
      "It did not complete: no run finished (its row is a marker, run 0) and no failure reason was recorded, so it was stopped by the time limit or a crash; the limit is proven in force (probe refused, read-back equal), so the control passed. It saw 1 memory-limit message while it ran, besides the probe's 1.",
    );
    expect(b).not.toContain('the limit is limit');
    // the marker is in none of the figures: the table has the two benchmark legs only
    expect(b.split('\n').filter((l) => l.startsWith('| emulated:'))).toHaveLength(2);
    expect(b).toContain('| 2 GiB (control) |');
  });

  it('never says met, passes under, works under or within the cap, never calls an emulated figure a laptop result, and keeps the 8 GB cell', () => {
    for (const b of [
      block([leg(null), leg(5, { total: 3 })], [...q(null, 24), ...q(5, 24)]),
      block([leg(8), leg(6)], [...q(8, 24), ...q(6, 24)]),
    ]) {
      expect(b.replaceAll('NOT met', '')).not.toMatch(/\bmet\b/u);
      expect(b).not.toMatch(/works? under|survives?|passes? under|within the cap|passed under/iu);
      expect(b.replaceAll('not a laptop', '')).not.toMatch(/laptop result|8 GB result/iu);
      for (const l of b.split('\n').filter((x) => x.startsWith('| emulated:')))
        expect(l.endsWith(`| ${LAPTOP_8GB} |`), l).toBe(true);
    }
  });
});

// ---- the committed import of run 44666921454 ----

describe(`the committed import of bench-windows run ${RUN}`, () => {
  const bench = (f: string) => readFileSync(join(root, 'docs', 'benchmarks', f), 'utf8');
  const summaries = () =>
    Object.fromEntries(
      CAPS.map((c) => [
        c,
        JSON.parse(readFileSync(join(EVIDENCE_DIR, c, 'job-summary.json'), 'utf8')) as Record<
          string,
          unknown
        >,
      ]),
    );
  const rowsOf = () => parseCsv(bench(EMULATED_E2E_FILE));
  const qsOf = () => parseCsv(bench(EMULATED_Q_FILE));
  const capOf = (r: Record<string, string>) =>
    Object.entries(LEG_CAPS).find(
      ([, n]) => (n === null ? '' : String(n)) === r['job_commit_limit_bytes'],
    )![0];

  it('has the current header, the five legs in matrix order (the control last), the commit the dispatch ran on, and the 8 GB phrase on every row', () => {
    const rows = rowsOf();
    const qs = qsOf();
    expect(bench(EMULATED_E2E_FILE).split('\n')[0]).toBe(E2E_EMULATED_COLUMNS.join(','));
    expect([...new Set(rows.map(capOf))]).toEqual([...CAPS]);
    expect([...new Set(rows.map((r) => r['commit']))]).toEqual(['f6a71cab4ab1']);
    for (const r of [...rows, ...qs]) expect(r['laptop_8gb']).toBe(LAPTOP_8GB);
    for (const r of rows) expect(r['machine']).toBe(r['environment']);
  });

  it('holds six runs per benchmark leg (five in one Chrome session, one after a restart) and 42 question rows each, none left out, and only a marker row for the control', () => {
    const rows = rowsOf();
    const qs = qsOf();
    for (const c of CAPS.filter((x) => !CONTROL_CAPS.includes(x))) {
      const r = rows.filter((x) => capOf(x) === c);
      expect(r, c).toHaveLength(6);
      expect(r.map((x) => x['run'])).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(r.map((x) => x['restart'])).toEqual([
        'false',
        'false',
        'false',
        'false',
        'false',
        'true',
      ]);
      expect(new Set(r.map((x) => x['failure_reason']))).toEqual(new Set(['']));
      expect(new Set(r.map((x) => x['requests_after_offline']))).toEqual(new Set(['0']));
      expect(
        qs.filter((x) => x['environment'] === r[0]!['environment']),
        c,
      ).toHaveLength(42);
    }
    const ctl = rows.filter((x) => capOf(x) === '2GiB');
    expect(ctl).toHaveLength(1);
    expect(ctl[0]).toMatchObject({ run: '0', failure_reason: '', control_leg: 'true' });
    expect(qs.filter((x) => x['environment'] === ctl[0]!['environment'])).toHaveLength(0);
    expect(rows).toHaveLength(25);
    expect(qs).toHaveLength(168);
  });

  it('every row carries exactly the cells the merge step derives from the committed job-summary.json of its leg', () => {
    const summaries_ = summaries();
    for (const r of rowsOf()) {
      const cells = summaryCells(summaries_[capOf(r)]) as Record<string, unknown>;
      for (const [k, v] of Object.entries(cells)) expect(r[k], `${capOf(r)} ${k}`).toBe(String(v));
    }
  });

  it('the label of every row is the label the leg wrote in its own summary, verbatim', () => {
    const s = summaries();
    for (const r of rowsOf()) expect(r['environment']).toBe(s[capOf(r)]!['label']);
  });

  it('the verdicts the evidence gives: the four capped legs are proven in force, the 5 GiB leg had two refusals while the benchmark ran, the 6 and 8 GiB legs none, the control passed', () => {
    const rows = rowsOf();
    const first = (c: string) => rows.find((r) => capOf(r) === c)!;
    expect(limitProof(first('none'))).toBe('no_limit');
    for (const c of ['8GiB', '6GiB', '5GiB', '2GiB'])
      expect(limitProof(first(c)), c).toBe('proven');
    expect(limitMessages(first('5GiB'))).toEqual({ total: 3, probe: 1, benchmark: 2 });
    expect(limitMessages(first('6GiB'))).toEqual({ total: 1, probe: 1, benchmark: 0 });
    expect(limitMessages(first('8GiB'))).toEqual({ total: 1, probe: 1, benchmark: 0 });
    expect(limitMessages(first('none'))).toEqual({ total: 0, probe: null, benchmark: 0 });
    expect(limitMessages(first('2GiB'))).toEqual({ total: 2, probe: 1, benchmark: 1 });
    // the whole-tree peak is the probe's on the 6 and 8 GiB legs and the control: not measured
    for (const c of ['8GiB', '6GiB', '2GiB']) expect(first(c)['job_commit_peak_bytes'], c).toBe('');
    expect(first('5GiB')['job_commit_peak_bytes']).toBe('6092845056');
    expect(first('none')['job_commit_peak_bytes']).toBe('6081593344');
    expect((summaries()['2GiB']!['control'] as Record<string, unknown>)['verdict']).toBe(
      'control_passed',
    );
  });

  it('the generated block says it in words, from these rows and nothing else', () => {
    const b = emulatedBlock(bench(EMULATED_E2E_FILE), bench(EMULATED_Q_FILE));
    expect(b).toContain(
      '**The 5 GiB leg had commits refused while the benchmark ran, and the leg still finished.**',
    );
    expect(b).toContain(
      'received 2 JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages while the benchmark ran',
    );
    expect(b).toContain(
      '**No commit was refused while the benchmark ran on the 8 GiB and 6 GiB legs.**',
    );
    expect(b).toContain('**Control leg, 2 GiB: not a benchmark figure.**');
    expect(b).toContain('so the control passed');
    expect(b).toContain('The limit of every capped leg is proven in force');
    expect(b).not.toContain('limit unproven');
    expect(b).not.toContain('is not a result under a');
    expect(b).not.toContain('No leg in this file failed for want of memory');
    // 24 of 36 on every benchmark leg, as on the Mac
    expect(b.match(/\| 24 of 36 \|/gu)).toHaveLength(4);
  });
});
