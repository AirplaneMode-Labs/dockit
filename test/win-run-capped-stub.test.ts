import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { limitProof } from '../scripts/lib/bench-columns.mjs';
import { merge } from '../scripts/bench-emulated-merge.mjs';
import { parseCsv } from '../scripts/memory-figures.mjs';
import { hasPwsh } from './helpers/pwsh.ts';
import {
  runCappedStub,
  scriptPath,
  stubbedScript,
  type StubResult,
} from './helpers/run-capped-stub.ts';

// The real scripts/win/run-capped.ps1, run end to end on this machine with kernel32 replaced by a managed stand-in (test/helpers/run-capped-stub.ts): the read-back, the
// probe, the completion port, the control-leg verdict, the summary and the exit codes are the PowerShell that will run on Windows; only the kernel answers are scripted.
// A pass here means the script does what it says given those answers. What the real kernel answers is what the next bench-windows dispatch measures.
const root = join(import.meta.dirname, '..');
const GIB = 1073741824;
const MIB = 1048576;
const LABEL_TAIL = 'process tree under a job commit limit of';
const T = { timeout: 90_000 };
const run = hasPwsh();

const mergeCli = (r: StubResult) =>
  spawnSync(
    process.execPath,
    [
      join(root, 'scripts', 'bench-emulated-merge.mjs'),
      '--csv',
      join(r.outDir, 'e2e-emulated-win-vm.csv'),
      '--summary',
      join(r.outDir, 'job-summary.json'),
    ],
    { encoding: 'utf8' },
  );
/** The CSV after the real merge step, as rows. */
const merged = (r: StubResult) => parseCsv(merge(r.csv!, r.summary));

describe('the stub harness itself', () => {
  it('rewrites every kernel32 import of the script to a stand-in call, and leaves the rest of the script as it was', () => {
    const raw = readFileSync(scriptPath, 'utf8');
    const out = stubbedScript(raw);
    expect(out).not.toContain('DllImport');
    expect(out).toContain(
      'Kernel32Stub.VirtualAlloc(lpAddress, dwSize, flAllocationType, flProtect)',
    );
    expect(out).toContain('Kernel32Stub.IsProcessInJob(ProcessHandle, JobHandle, out Result)');
    // outside the here-string the two files are identical
    const strip = (s: string) => s.replace(/\$Source = @'\n[\s\S]*?\n'@/u, '');
    expect(strip(out)).toBe(strip(raw));
  });
});

describe.skipIf(!run)('run-capped.ps1 with a stubbed kernel32: a capped leg', () => {
  it.concurrent(
    'reads the limit back twice, probes it from inside the job, counts the completion port and records the peaks; a limit in force reads as proven',
    T,
    async () => {
      const r = await runCappedStub({
        cap: '5GiB',
        env: { STUB_BENCH_PEAK: '6074314752', FAKE_CHROME: '1' },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const s = r.summary!;
      expect(s).toMatchObject({
        summaryVersion: 2,
        cap: '5GiB',
        limitBytes: 5 * GIB,
        limitFlags: '0x2200',
        structSize: 144,
        controlLeg: false,
        limitSet: true,
        benchStarted: true,
        limitNotEnforced: false,
        phase: 'finished',
      });
      expect(s.label).toContain(`${LABEL_TAIL} 5368709120 bytes; not a laptop`);
      expect(s.label).not.toContain('control leg');
      // both read-backs come from the system, and equal what was set
      expect(s.readBack).toMatchObject({
        expectedFlags: '0x2200',
        expectedJobMemoryLimit: 5 * GIB,
        equal: true,
        afterCreate: { flags: '0x2200', jobMemoryLimit: 5 * GIB },
        afterAssign: { flags: '0x2200', jobMemoryLimit: 5 * GIB },
      });
      // the probe: the small commit worked, the one above the limit was refused (error 1455), everything freed, and the peak did not move for the refusal
      expect(s.probe).toMatchObject({
        ran: true,
        bytes: 5 * GIB + 256 * MIB,
        overLimitBytes: 256 * MIB,
        smallCommitOk: true,
        systemRoomOk: true,
        committed: false,
        refused: true,
        lastError: 1455,
        lastErrorName: 'ERROR_COMMITMENT_LIMIT',
        freed: true,
        peakIncludesProbe: false,
        jobMemoryLimitMessagesAfterProbe: 1,
      });
      expect(s.probe.peakAfterBytes).toBe(s.probe.peakAfterSmallCommitBytes);
      expect(s.probe.peakAfterBytes).toBeLessThan(5 * GIB);
      expect(s.completionPort).toMatchObject({
        attached: true,
        error: null,
        jobMemoryLimitMessages: 1,
        firstJobMemoryLimitPid: 4321,
      });
      // the peak on every tick, first and last in the summary, and the final value is the benchmark's, above what the probe left
      expect(s.peakJobMemoryBytes).toBe(6074314752);
      expect(s.peakJobSamples.final).toBe(6074314752);
      expect(s.peakJobSamples.lastSample).toBe(6074314752);
      expect(s.peakJobSamples.firstSample).toBeLessThanOrEqual(s.peakJobSamples.lastSample);
      expect(s.peakJobSamples.ticks).toBe(r.membership.length);
      expect(r.membership.length).toBeGreaterThanOrEqual(2);
      for (const line of r.membership) {
        expect(line.peakJob).toEqual(expect.any(Number));
        expect(line.peakProc).toEqual(expect.any(Number));
        expect(line.jobMemoryLimitMessages).toBe(1);
        expect(line.jobPids).toEqual([100, 101, 102]);
      }
      expect(s.escapes).toBe(0);
      expect(s.chromeProcessesSeenMax).toBe(1);
      expect(s.benchProgress).toMatchObject({
        rowsWritten: 6,
        completedRuns: 6,
        failureReason: null,
      });
      // what the log says: the read-back and the probe in words
      expect(r.stdout).toContain(
        'read-back after create: LimitFlags 0x2200, JobMemoryLimit 5368709120 (set: 0x2200, 5368709120)',
      );
      expect(r.stdout).toContain(
        'read-back after assign: LimitFlags 0x2200, JobMemoryLimit 5368709120',
      );
      expect(r.stdout).toMatch(
        /probe: committed 67108864 bytes ok=True; commit of limit \+ 256 MiB \(5637144576 bytes\) refused=True \(error 1455\)/u,
      );
      // and the merge step turns that summary into proof
      const rows = merged(r);
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(row).toMatchObject({
          job_commit_limit_bytes: String(5 * GIB),
          job_commit_peak_bytes: '6074314752',
          job_limit_readback_bytes: String(5 * GIB),
          job_limit_flags_readback: '0x2200',
          limit_probe_refused: 'true',
          job_memory_limit_messages: '1',
          control_leg: 'false',
          job_escapes: '0',
        });
        expect(limitProof(row)).toBe('proven');
      }
    },
  );

  it.concurrent(
    'a commit above the limit that succeeds marks the leg limitNotEnforced, frees the memory, still runs the benchmark, and the merge empties a peak that is the probe own',
    T,
    async () => {
      const r = await runCappedStub({
        cap: '8GiB',
        env: {
          STUB_ENFORCE: '0',
          STUB_BENCH_PEAK: '6071017472',
          STUB_ESCAPE: '1',
          FAKE_CHROME: '1',
        },
      });
      // the benchmark ran and the leg is green: the figures are still a measurement, and the summary says the cap was not in force
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const s = r.summary!;
      expect(s.limitNotEnforced).toBe(true);
      expect(s.benchStarted).toBe(true);
      expect(s.probe).toMatchObject({
        committed: true,
        refused: false,
        freed: true,
        lastError: 0,
        smallCommitOk: true,
      });
      expect(r.stdout).toContain(
        '::warning::run-capped: the commit of limit + 256 MiB succeeded inside the job, so the cap was NOT in force',
      );
      // the probe took the job's high-water mark to 8.25 GiB and the benchmark (5.65 GiB) never passed it: that peak is the probe's, not the run's
      expect(s.probe.peakAfterBytes).toBeGreaterThan(8 * GIB);
      expect(s.probe.peakIncludesProbe).toBe(true);
      expect(s.peakJobMemoryBytes).toBe(s.probe.peakAfterBytes);
      // a Chrome process outside the job is still counted as an escape
      expect(s.escapes).toBe(1);
      expect(s.escapedPids).toEqual([4242]);
      const rows = merged(r);
      for (const row of rows) {
        expect(row.limit_probe_refused).toBe('false');
        expect(row.job_commit_peak_bytes).toBe('');
        expect(row.job_peak_after_probe_bytes).toBe(String(s.probe.peakAfterBytes));
        expect(row.job_escapes).toBe('1');
        expect(limitProof(row)).toBe('not_enforced');
      }
    },
  );

  it.concurrent(
    'a benchmark that goes higher than the probe left the peak is the benchmark one, even when the cap was not in force',
    T,
    async () => {
      const r = await runCappedStub({
        cap: '5GiB',
        env: { STUB_ENFORCE: '0', STUB_BENCH_PEAK: String(9 * GIB) },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.summary!.limitNotEnforced).toBe(true);
      expect(r.summary!.probe.peakIncludesProbe).toBe(false);
      expect(merged(r)[0]!.job_commit_peak_bytes).toBe(String(9 * GIB));
    },
  );

  it.concurrent(
    'records whether a refused commit is counted in the peak: here it is, and the evidence shows it',
    T,
    async () => {
      const r = await runCappedStub({
        cap: '6GiB',
        env: { STUB_REFUSED_COUNTS: '1', STUB_BENCH_PEAK: '6073286656' },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const p = r.summary!.probe;
      expect(p.refused).toBe(true);
      // after the refused commit the peak is limit + 256 MiB (plus what the process held): a refusal that is counted looks exactly like this
      expect(p.peakAfterSmallCommitBytes).toBeLessThan(1 * GIB);
      expect(p.peakAfterBytes).toBeGreaterThanOrEqual(6 * GIB + 256 * MIB);
      // the benchmark never passed it, so the whole-tree peak is the probe's and the merged cell is empty
      expect(p.peakIncludesProbe).toBe(true);
      expect(merged(r)[0]!.job_commit_peak_bytes).toBe('');
      expect(merged(r)[0]!.job_peak_after_probe_bytes).toBe(String(p.peakAfterBytes));
      expect(limitProof(merged(r)[0]!)).toBe('proven');
    },
  );

  it.concurrent(
    'a probe that cannot be told from a failing probe call stays null and the limit stays unproven (the 64 MiB commit failed)',
    T,
    async () => {
      const r = await runCappedStub({
        cap: '8GiB',
        env: { STUB_SMALL_FAIL: '1', STUB_BENCH_PEAK: '6071017472' },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.summary!.probe).toMatchObject({
        smallCommitOk: false,
        committed: false,
        refused: null,
      });
      expect(r.summary!.limitNotEnforced).toBe(false);
      expect(r.stdout).toContain('the probe was inconclusive');
      const row = merged(r)[0]!;
      expect(row.limit_probe_refused).toBe('');
      expect(limitProof(row)).toBe('unproven');
    },
  );

  it.concurrent(
    'a refusal while the system itself has no room is inconclusive too (free virtual memory below the probe)',
    T,
    async () => {
      const r = await runCappedStub({
        cap: '8GiB',
        env: { STUB_FREE_VIRTUAL_KB: String(4 * 1024 * 1024), STUB_BENCH_PEAK: '6071017472' },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.summary!.probe).toMatchObject({
        systemRoomOk: false,
        committed: false,
        refused: null,
      });
      expect(limitProof(merged(r)[0]!)).toBe('unproven');
    },
  );

  it.concurrent(
    'a completion port that cannot be attached is written down and nothing else changes: the probe and the read-back still prove the limit',
    T,
    async () => {
      const r = await runCappedStub({
        cap: '8GiB',
        env: { STUB_NO_IOCP: '1', STUB_BENCH_PEAK: '6071017472' },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const s = r.summary!;
      expect(s.completionPort.attached).toBe(false);
      expect(s.completionPort.error).toMatch(/CreateIoCompletionPort/u);
      expect(s.completionPort.jobMemoryLimitMessages).toBeNull();
      expect(s.probe.jobMemoryLimitMessagesAfterProbe).toBeNull();
      const row = merged(r)[0]!;
      expect(row.job_memory_limit_messages).toBe('');
      expect(limitProof(row)).toBe('proven');
    },
  );

  it.concurrent(
    'a benchmark that fails on a normal leg keeps its own exit code, and the leg is not a control',
    T,
    async () => {
      const r = await runCappedStub({
        cap: '6GiB',
        bench: 'fail',
        env: { STUB_BENCH_PEAK: '3000000000' },
      });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.summary!.benchExitCode).toBe(1);
      expect(r.summary!.legExitCode).toBe(1);
      expect(r.summary!.control).toBeUndefined();
      expect(r.summary!.benchProgress).toMatchObject({
        rowsWritten: 1,
        completedRuns: 0,
        failureReason: 'out_of_memory',
      });
      expect(merged(r)[0]!.failure_reason).toBe('out_of_memory');
    },
  );
});

describe.skipIf(!run)('run-capped.ps1 with a stubbed kernel32: the leg with no limit', () => {
  it.concurrent(
    'sets, reads back and records that no limit is set; there is nothing to probe',
    T,
    async () => {
      const r = await runCappedStub({ cap: 'none', env: { STUB_BENCH_PEAK: '6181113856' } });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const s = r.summary!;
      expect(s).toMatchObject({
        cap: 'none',
        limitBytes: null,
        limitFlags: '0x2000',
        limitSet: false,
        controlLeg: false,
        limitNotEnforced: false,
      });
      expect(s.readBack).toMatchObject({
        expectedFlags: '0x2000',
        expectedJobMemoryLimit: 0,
        equal: true,
        afterAssign: { flags: '0x2000', jobMemoryLimit: 0 },
      });
      expect(s.readBack.note).toContain('no limit is set on this leg');
      expect(s.probe.ran).toBe(false);
      expect(s.probe.reason).toMatch(/no limit/u);
      expect(s.label).toContain('with no job limit');
      expect(s.peakJobMemoryBytes).toBe(6181113856);
      const row = merged(r)[0]!;
      expect(row).toMatchObject({
        job_commit_limit_bytes: '',
        job_limit_readback_bytes: '0',
        job_limit_flags_readback: '0x2000',
        limit_probe_refused: '',
        job_peak_after_probe_bytes: '',
        control_leg: 'false',
        job_commit_peak_bytes: '6181113856',
      });
      expect(limitProof(row)).toBe('no_limit');
    },
  );
});

describe.skipIf(!run)(
  'run-capped.ps1 with a stubbed kernel32: a read-back that differs from what was set ends the leg before the benchmark',
  () => {
    it.concurrent.each([
      ['right after create', 'flags-create'],
      ['after the process was put in the job', 'limit-assign'],
    ])(
      '%s: exit 6, the reason and both values in the summary, no benchmark, and a merge step with nothing to fill and nothing to say',
      T,
      async (when, mode) => {
        const r = await runCappedStub({ cap: '6GiB', env: { STUB_READBACK: mode } });
        expect(r.status, r.stdout + r.stderr).toBe(6);
        const s = r.summary!;
        expect(s).toMatchObject({
          benchStarted: false,
          failReason: 'limit_readback_mismatch',
          phase: 'readback-mismatch',
        });
        expect(s.readBack.equal).toBe(false);
        expect(s.failDetail).toMatch(
          /read-back (after create|after assign): flags 0x\w+, JobMemoryLimit \d+; set: flags 0x2200, JobMemoryLimit 6442450944/u,
        );
        expect(r.stdout).toContain('::error::run-capped: the limit read back');
        // the benchmark never started: no log, no CSV
        expect(existsSync(join(r.outDir, 'bench.log'))).toBe(false);
        expect(r.csv).toBeNull();
        const m = mergeCli(r);
        expect({ status: m.status, stderr: m.stderr }).toEqual({ status: 0, stderr: '' });
        expect(m.stdout).toContain(
          'no CSV for the 6GiB leg (the benchmark did not start); nothing to fill',
        );
      },
    );

    it.concurrent(
      'a process that cannot be put in the job ends the leg with exit 4 and the error in the summary',
      T,
      async () => {
        const r = await runCappedStub({ cap: '8GiB', env: { STUB_ASSIGN_FAIL: '1' } });
        expect(r.status, r.stdout + r.stderr).toBe(4);
        expect(r.summary!.assignError).toMatch(/AssignProcessToJobObject/u);
        expect(r.summary!.benchStarted).toBe(false);
      },
    );
  },
);

describe.skipIf(!run)(
  'run-capped.ps1 with a stubbed kernel32: the 2GiB control leg, green only when the benchmark does not complete',
  () => {
    it.concurrent(
      'the benchmark fails (out_of_memory) with the limit proven in force: green, recorded as a control with its reason and how far it got',
      T,
      async () => {
        const r = await runCappedStub({
          cap: '2GiB',
          bench: 'fail',
          env: { STUB_BENCH_PEAK: '2000000000' },
        });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        const s = r.summary!;
        expect(s).toMatchObject({
          cap: '2GiB',
          limitBytes: 2 * GIB,
          controlLeg: true,
          limitSet: true,
          benchExitCode: 1,
          legExitCode: 0,
          limitNotEnforced: false,
        });
        expect(s.label).toContain(
          'under a job commit limit of 2147483648 bytes (control leg, expected to fail); not a laptop',
        );
        expect(s.probe).toMatchObject({ refused: true, bytes: 2 * GIB + 256 * MIB });
        expect(s.control).toMatchObject({
          benchCompleted: false,
          outcome: 'failed_as_expected',
          verdict: 'control_passed',
          failureReason: 'out_of_memory',
          completedRuns: 0,
          rowsWritten: 1,
          legExitCode: 0,
        });
        expect(s.control.lastErrorLine).toMatch(/FAILED \(out_of_memory\)/u);
        // the one run-0 row carries the control marker and the evidence, and the merge accepts it
        const rows = merged(r);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          run: '0',
          failure_reason: 'out_of_memory',
          control_leg: 'true',
          limit_probe_refused: 'true',
          job_limit_flags_readback: '0x2200',
        });
        expect(limitProof(rows[0]!)).toBe('proven');
        expect(mergeCli(r).status).toBe(0);
      },
    );

    it.concurrent(
      'the benchmark completes under the control limit: red (exit 7), because the cap does nothing',
      T,
      async () => {
        const r = await runCappedStub({
          cap: '2GiB',
          bench: 'complete',
          env: { STUB_ENFORCE: '0', STUB_BENCH_PEAK: String(6 * GIB) },
        });
        expect(r.status, r.stdout + r.stderr).toBe(7);
        expect(r.summary!.benchExitCode).toBe(0);
        expect(r.summary!.limitNotEnforced).toBe(true);
        expect(r.summary!.control).toMatchObject({
          benchCompleted: true,
          outcome: 'completed_unexpectedly',
          verdict: 'cap_does_nothing',
          completedRuns: 6,
          legExitCode: 7,
        });
        expect(r.stdout).toContain(
          '::error::run-capped: the benchmark completed under the control limit of 2147483648 bytes: the cap does nothing',
        );
      },
    );

    it.concurrent(
      'the benchmark completes even though the limit was proven by the probe: still red (exit 7)',
      T,
      async () => {
        const r = await runCappedStub({
          cap: '2GiB',
          bench: 'complete',
          env: { STUB_BENCH_PEAK: String(6 * GIB) },
        });
        expect(r.status, r.stdout + r.stderr).toBe(7);
        expect(r.summary!.probe.refused).toBe(true);
        expect(r.summary!.control.verdict).toBe('cap_does_nothing');
      },
    );

    it.concurrent(
      'the benchmark fails but the probe committed over the limit: red (exit 8), a failure that proves nothing about the cap',
      T,
      async () => {
        const r = await runCappedStub({ cap: '2GiB', bench: 'fail', env: { STUB_ENFORCE: '0' } });
        expect(r.status, r.stdout + r.stderr).toBe(8);
        expect(r.summary!.control).toMatchObject({
          benchCompleted: false,
          outcome: 'inconclusive',
          verdict: 'control_inconclusive',
          failureReason: 'out_of_memory',
          legExitCode: 8,
        });
        expect(r.stdout).toContain(
          '::error::run-capped: the control leg stopped, but the probe did not prove the limit in force',
        );
      },
    );

    it.concurrent(
      'the benchmark fails but the probe was inconclusive: red (exit 8) as well',
      T,
      async () => {
        const r = await runCappedStub({
          cap: '2GiB',
          bench: 'fail',
          env: { STUB_SMALL_FAIL: '1' },
        });
        expect(r.status, r.stdout + r.stderr).toBe(8);
        expect(r.summary!.probe.refused).toBeNull();
        expect(r.summary!.control.verdict).toBe('control_inconclusive');
      },
    );

    it.concurrent(
      'the benchmark dies before it writes a single row: green, a control with no rows, and a merge step that has nothing to fill and nothing to say',
      T,
      async () => {
        const r = await runCappedStub({
          cap: '2GiB',
          bench: 'crash',
          env: { STUB_BENCH_PEAK: '1000000000' },
        });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.csv).toBeNull();
        expect(r.summary!.control).toMatchObject({
          outcome: 'failed_as_expected',
          verdict: 'control_passed',
          failureReason: null,
          completedRuns: 0,
          rowsWritten: 0,
        });
        // the control wrote no row, so the merge step leaves ONE marker row (run 0, no figure, no failure reason) built from the summary's own label and evidence
        const m = mergeCli(r);
        expect({ status: m.status, stderr: m.stderr }).toEqual({ status: 0, stderr: '' });
        expect(m.stdout).toContain('wrote a marker row for the 2GiB control leg');
        const marker = parseCsv(readFileSync(join(r.outDir, 'e2e-emulated-win-vm.csv'), 'utf8'));
        expect(marker).toHaveLength(1);
        expect(marker[0]).toMatchObject({
          run: '0',
          failure_reason: '',
          control_leg: 'true',
          environment: r.summary!['label'],
          limit_probe_refused: 'true',
          laptop_8gb: 'not measured on 8 GB',
        });
        expect(limitProof(marker[0]!)).toBe('proven');
      },
    );
  },
);

describe('the evidence readers agree on what proves a limit', () => {
  const base = {
    job_commit_limit_bytes: String(5 * GIB),
    job_limit_readback_bytes: String(5 * GIB),
    job_limit_flags_readback: '0x2200',
    limit_probe_refused: 'true',
  };
  it('proven needs the read-back equal AND the probe refused; every other combination reads otherwise', () => {
    expect(limitProof(base)).toBe('proven');
    expect(limitProof({ ...base, limit_probe_refused: 'false' })).toBe('not_enforced');
    expect(limitProof({ ...base, limit_probe_refused: '' })).toBe('unproven');
    expect(limitProof({ ...base, job_limit_readback_bytes: String(5 * GIB - 4096) })).toBe(
      'readback_mismatch',
    );
    expect(limitProof({ ...base, job_limit_flags_readback: '0x2000' })).toBe('readback_mismatch');
    expect(
      limitProof({ ...base, job_limit_readback_bytes: '', job_limit_flags_readback: '' }),
    ).toBe('unproven');
    expect(limitProof({ job_commit_limit_bytes: String(5 * GIB) })).toBe('unproven');
    expect(limitProof({ job_commit_limit_bytes: '' })).toBe('no_limit');
    expect(
      limitProof({
        job_commit_limit_bytes: '',
        job_limit_readback_bytes: '0',
        job_limit_flags_readback: '0x2000',
      }),
    ).toBe('no_limit');
    expect(
      limitProof({
        job_commit_limit_bytes: '',
        job_limit_readback_bytes: '1',
        job_limit_flags_readback: '0x2000',
      }),
    ).toBe('readback_mismatch');
  });
});
