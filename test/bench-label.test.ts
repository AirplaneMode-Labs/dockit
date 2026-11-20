import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { guardLaptopCsvs } from './helpers/laptop-csv-guard.ts';
import { machineLabel } from '../scripts/lib/e2e-harness.mjs';
import {
  ENVIRONMENT_LABEL_RE,
  MACHINE_8GB_OR_LAPTOP_RE,
  validateEnvironmentLabel,
} from '../scripts/lib/bench-columns.mjs';
import { SPAWN_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';

// B6 / TD-113: a runner is never printed as a laptop. machineLabel() takes the environment label and the CI flag as arguments (bench-e2e.mjs reads
// GITHUB_ACTIONS once and passes it in), so nothing here depends on the environment the tests run in.
const root = join(import.meta.dirname, '..');
vi.setConfig({ testTimeout: SPAWN_TEST_TIMEOUT_MS });
guardLaptopCsvs();
const GOOD =
  'emulated: GitHub-hosted Windows Server 2025 VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree under a job commit limit of 6442450944 bytes; not a laptop';
const NONE =
  'emulated: GitHub-hosted Windows Server 2025 VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree with no job limit; not a laptop';

/** The current environment minus every runner variable, so a spawned script never sees GITHUB_ACTIONS unless the test says so. */
const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(GITHUB_|RUNNER_|CI$)/u.test(k)),
  ),
  // if a script under test ever got as far as writing, it writes here and never over the committed laptop CSVs
  DOCKIT_BENCH_CSV: join(os.tmpdir(), 'dockit-label-test-e2e.csv'),
  DOCKIT_BENCH_Q_CSV: join(os.tmpdir(), 'dockit-label-test-e2e-questions.csv'),
  ...extra,
});

describe('machineLabel (B6, TD-113)', () => {
  it('a local run without a label keeps the existing format: <cpu model> <N> GB', () => {
    const want = `${os.cpus()[0]?.model.trim() ?? 'unknown cpu'} ${Math.round(os.totalmem() / 2 ** 30)} GB`;
    expect(machineLabel()).toBe(want);
    expect(machineLabel({})).toBe(want);
    expect(machineLabel({ ci: false })).toBe(want);
  });

  it('a CI runner with no label throws, and the message names the flag', () => {
    expect(() => machineLabel({ ci: true })).toThrow(
      'a CI runner needs an explicit --environment label',
    );
    expect(() => machineLabel({ ci: true, environment: undefined })).toThrow(/--environment/u);
    expect(() => machineLabel({ ci: true, environment: '' })).toThrow(/--environment/u);
  });

  it('a valid label is returned verbatim, in CI and locally, for the capped legs and the unlimited one', () => {
    for (const ci of [true, false]) {
      expect(machineLabel({ environment: GOOD, ci })).toBe(GOOD);
      expect(machineLabel({ environment: NONE, ci })).toBe(NONE);
    }
  });

  it('the label names the whole pwsh, node and Chrome process tree and ends with "; not a laptop"', () => {
    expect(GOOD).toContain('pwsh, node and Chrome process tree');
    expect(GOOD.endsWith('; not a laptop')).toBe(true);
    expect(ENVIRONMENT_LABEL_RE.test(GOOD)).toBe(true);
    expect(ENVIRONMENT_LABEL_RE.test(NONE)).toBe(true);
  });
});

describe('the label rules (no runner reads as a laptop or as an 8 GB machine)', () => {
  const bad: [string, string][] = [
    ['no emulated prefix', 'GitHub-hosted Windows VM; not a laptop'],
    ['no not-a-laptop suffix', 'emulated: GitHub-hosted Windows VM, 4 vCPU, 16 GB RAM'],
    ['suffix not at the end', 'emulated: VM; not a laptop, really'],
    ['laptop elsewhere in the text', 'emulated: laptop-like VM on a runner; not a laptop'],
    ['laptop in upper case elsewhere', 'emulated: LAPTOP class VM; not a laptop'],
    ['an 8 GB figure', 'emulated: Windows VM with 8 GB RAM; not a laptop'],
    ['an 8GB figure without a space', 'emulated: Windows VM, 8GB RAM; not a laptop'],
    ['an 8 gb figure in lower case', 'emulated: Windows VM, 8 gb; not a laptop'],
    ['an 8 GiB figure (BUG-T1-S7-05)', 'emulated: VM with 8 GiB RAM; not a laptop'],
    ['an 8192 MB figure', 'emulated: VM with 8192 MB RAM; not a laptop'],
    ['an 8192MB figure without a space', 'emulated: VM with 8192MB RAM; not a laptop'],
    ['an 8.0 GB figure', 'emulated: VM with 8.0 GB RAM; not a laptop'],
    ['an 8-GB figure', 'emulated: VM with 8-GB RAM; not a laptop'],
    ['an 8 G figure', 'emulated: VM with 8 G RAM; not a laptop'],
    ['a notebook', 'emulated: notebook VM; not a laptop'],
    ['an 8.00 GB figure (BUG-T1-S7-09)', 'emulated: VM with 8.00 GB RAM; not a laptop'],
    ['an 8,0 GB figure', 'emulated: VM with 8,0 GB RAM; not a laptop'],
    ['an 8 GBs figure', 'emulated: VM with 8 GBs RAM; not a laptop'],
    ['an 8 GByte figure', 'emulated: VM with 8 GByte RAM; not a laptop'],
    ['an 8 GBytes figure', 'emulated: VM with 8 GBytes RAM; not a laptop'],
    ['an 8 gig figure', 'emulated: VM with 8 gig RAM; not a laptop'],
    ['an 8 gigabytes figure', 'emulated: VM with 8 gigabytes RAM; not a laptop'],
    ['an 8 gigabyte figure', 'emulated: VM with 8 gigabyte RAM; not a laptop'],
    ['an 8 gibibytes figure', 'emulated: VM with 8 gibibytes RAM; not a laptop'],
    ['an 8. GB figure', 'emulated: VM with 8. GB RAM; not a laptop'],
    ['an 8000 MB figure', 'emulated: VM with 8000 MB RAM; not a laptop'],
    ['an 8000 MiB figure', 'emulated: VM with 8000 MiB RAM; not a laptop'],
    ['an 8192 MiB figure', 'emulated: VM with 8192 MiB RAM; not a laptop'],
    ['an 8192 M figure', 'emulated: VM with 8192 M RAM; not a laptop'],
    ['eight GB spelled out', 'emulated: VM with eight GB RAM; not a laptop'],
    ['eight gigabytes spelled out', 'emulated: VM with eight gigabytes RAM; not a laptop'],
    ['an 8 GB figure in upper case', 'emulated: VM WITH 8 GIGABYTES; not a laptop'],
    ['an empty body', 'emulated: ; not a laptop'],
    ['a markup character', 'emulated: <b>VM</b>; not a laptop'],
    ['a quote', 'emulated: VM "x"; not a laptop'],
    ['a spreadsheet formula start inside', 'emulated: =HYPERLINK(1); not a laptop'],
    ['a newline', 'emulated: VM\n; not a laptop'],
    ['over 300 characters', `emulated: ${'a'.repeat(301)}; not a laptop`],
  ];
  it.each(bad)('refuses %s', (_why, label) => {
    expect(() => validateEnvironmentLabel(label)).toThrow(/environment label/u);
    expect(() => machineLabel({ environment: label, ci: false })).toThrow(/environment label/u);
    expect(() => machineLabel({ environment: label, ci: true })).toThrow(/environment label/u);
  });

  const good: [string, string][] = [
    ['a 16 GB figure', 'emulated: Windows VM, 16 GB RAM; not a laptop'],
    ['an 18 GB figure (the 8 is part of a longer number)', 'emulated: VM, 18 GB RAM; not a laptop'],
    ['a 128 GB figure', 'emulated: VM, 128 GB RAM; not a laptop'],
    ['a decimal 1.8 GB figure', 'emulated: VM, 1.8 GB; not a laptop'],
    [
      'a job limit written in bytes (8 GiB)',
      'emulated: tree under a job commit limit of 8589934592 bytes; not a laptop',
    ],
    ['a 48 GB figure', 'emulated: VM, 48 GB RAM; not a laptop'],
    ['an 80000 MB figure', 'emulated: VM, 80000 MB; not a laptop'],
    ['a 4 vCPU count', 'emulated: VM, 4 vCPU; not a laptop'],
    [
      'the 6442450944 and 5368709120 byte limits',
      'emulated: tree under a job commit limit of 6442450944 bytes; not a laptop',
    ],
    [
      'the 5368709120 byte limit',
      'emulated: tree under a job commit limit of 5368709120 bytes; not a laptop',
    ],
    [
      'the unlimited leg',
      'emulated: pwsh, node and Chrome process tree with no job limit; not a laptop',
    ],
    ['a 6 GiB and a 5 GiB limit', 'emulated: 6 GiB then 5 GiB; not a laptop'],
    [
      'the label shape run-capped.ps1 builds from WMI facts',
      'emulated: GitHub-hosted Windows Server 2025 Datacenter VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree under a job commit limit of 8589934592 bytes; not a laptop',
    ],
    ['300 characters', `emulated: ${'a'.repeat(300)}; not a laptop`],
  ];
  it.each(good)('accepts %s', (_why, label) => {
    expect(validateEnvironmentLabel(label)).toBe(label);
  });

  it('refuses a label that is not a string', () => {
    // @ts-expect-error: the point of the test
    expect(() => validateEnvironmentLabel(42)).toThrow(/environment label/u);
    // @ts-expect-error: the point of the test
    expect(() => validateEnvironmentLabel(null)).toThrow(/environment label/u);
  });
});

// BUG-T1-S7-09: widened pattern; the site importer pins the same source string
const SHARED_SOURCE = String.raw`(^|[^0-9.,])(8([.,][0-9]+)?[ .-]{0,2}(GiB|GBytes?|GBs?|gigabytes?|gibibytes?|gig|G)\b|(8000|8192)([.,]0+)? ?(MiB|MB|M)\b)|\beight[ -]?(GB|GiB|gigabytes?|gibibytes?)\b|notebook|laptop`;

describe('the screen is one shared pattern (BUG-T1-S7-05)', () => {
  it('the site importer carries the same MACHINE_8GB_OR_LAPTOP_RE source as dockit (read as text, no import across repos)', () => {
    const own = readFileSync(join(root, 'scripts', 'lib', 'bench-columns.mjs'), 'utf8');
    expect(own).toMatch(/safety net for hand-typed labels/u);
    expect(MACHINE_8GB_OR_LAPTOP_RE.source).toBe(SHARED_SOURCE);
  });
  it('run-capped.ps1 builds its job limit in bytes, so the 8 GiB leg label passes the screen', () => {
    const ps = readFileSync(join(root, 'scripts', 'win', 'run-capped.ps1'), 'utf8');
    expect(ps).toContain("'under a job commit limit of ' + $LimitBytes + ' bytes'");
  });
});

describe('bench-e2e.mjs: a CI runner never prints a machine string it chose itself', () => {
  it('treats CI=true like GITHUB_ACTIONS=true (BUG-T1-S7-09): no --environment is refused under either', () => {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'bench-e2e.mjs')], {
      encoding: 'utf8',
      env: cleanEnv({ CI: 'true' }),
      timeout: 20_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('a CI runner needs an explicit --environment label');
  });
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'bench-e2e.mjs'), ...args], {
      encoding: 'utf8',
      env,
      timeout: 20_000,
    });

  it('exits 2 with the message when GITHUB_ACTIONS is true and no --environment is given (before it starts a server or a browser)', () => {
    const r = run([], cleanEnv({ GITHUB_ACTIONS: 'true' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('a CI runner needs an explicit --environment label');
    expect(r.stdout).not.toContain('serving');
  });

  it('exits 2 for a label that reads as a laptop or an 8 GB machine, in CI or not', () => {
    for (const env of [cleanEnv(), cleanEnv({ GITHUB_ACTIONS: 'true' })]) {
      for (const label of [
        'emulated: my laptop; not a laptop',
        'emulated: VM, 8 GB; not a laptop',
      ]) {
        const r = run(['--environment', label], env);
        expect(r.status, label).toBe(2);
        expect(r.stderr).toMatch(/environment label/u);
      }
    }
  });

  it('reads GITHUB_ACTIONS and CI once each and the harness reads no runner variable at all (the CI flag is passed in)', () => {
    const bench = readFileSync(join(root, 'scripts', 'bench-e2e.mjs'), 'utf8');
    expect(bench.match(/GITHUB_ACTIONS/gu)?.length).toBe(1);
    expect(bench.match(/process\.env\.CI\b/gu)?.length).toBe(1);
    expect(bench).toMatch(/machineLabel\(\{[^}]*ci[^}]*\}\)/u);
    const harness = readFileSync(join(root, 'scripts', 'lib', 'e2e-harness.mjs'), 'utf8');
    expect(harness).not.toMatch(/process\.env/u);
  });
});
