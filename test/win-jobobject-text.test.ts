import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';
import { hasPwsh, pwshParseErrors } from './helpers/pwsh.ts';

// scripts/win/run-capped.ps1 has never run on Windows: this Mac has no Windows and the first run is the bench-windows workflow. So this file is a static
// check of its text (S1, TD-113): only documented kernel32 calls, exactly the two limit-flag values, no breakaway, no download, no environment dump, one
// inline C# class compiled by Add-Type -TypeDefinition, the 144-byte size assertion before any call, and the cap validated. It proves what the file says;
// the struct marshalling and the job membership of Chrome's children are proven only by the first Windows run (scripts/win/README.md lists them).
const root = join(import.meta.dirname, '..');
const raw = readFileSync(join(root, 'scripts', 'win', 'run-capped.ps1'), 'utf8');

/** The script without PowerShell comments (a '#' line, a <# ... #> block) and without C# line comments, so a comment cannot trip or hide a rule. */
const code = raw
  .replace(/<#[\s\S]*?#>/gu, '')
  .split('\n')
  .filter((l) => !/^\s*#/u.test(l))
  .map((l) => l.replace(/^(\s*)\/\/.*$/u, '$1'))
  .join('\n');

const ALLOWED_CALLS = [
  'CreateJobObjectW',
  'SetInformationJobObject',
  'AssignProcessToJobObject',
  'QueryInformationJobObject',
  'IsProcessInJob',
  'CloseHandle',
  // GetCurrentProcess names the process that is put in the job (AssignProcessToJobObject(GetCurrentProcess())), OpenProcess opens a Chrome process
  // for the IsProcessInJob membership check with PROCESS_QUERY_INFORMATION only
  'GetCurrentProcess',
  'OpenProcess',
];
const REQUIRED_CALLS = ALLOWED_CALLS.slice(0, 6);

describe('run-capped.ps1: the file itself', () => {
  it('is ASCII only with LF line endings (Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page)', () => {
    expect(/^[\x00-\x7f]*$/u.test(raw)).toBe(true);
    expect(raw.includes('\r')).toBe(false);
  });
  it('carries one param block with Cap and OutDir and sets strict mode and ErrorActionPreference Stop', () => {
    expect(code).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[string\]\$Cap/u);
    expect(code).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[string\]\$OutDir/u);
    expect(code).toMatch(/Set-StrictMode -Version Latest/u);
    expect(code).toMatch(/\$ErrorActionPreference = 'Stop'/u);
  });
});

describe('run-capped.ps1: only documented kernel32 calls', () => {
  const imports = [
    ...code.matchAll(
      /\[DllImport\("([^"]+)"[^\]]*\)\]\s*public static extern [\w.\[\]]+ (\w+)\(/gu,
    ),
  ];
  it('every DllImport is kernel32.dll and every function is on the allowed list', () => {
    expect(imports.length).toBeGreaterThanOrEqual(REQUIRED_CALLS.length);
    for (const [, dll, name] of imports) {
      expect(dll!.toLowerCase(), name).toBe('kernel32.dll');
      expect(ALLOWED_CALLS, `${name} is not an allowed call`).toContain(name);
    }
    expect([...code.matchAll(/DllImport/gu)].length).toBe(imports.length);
  });
  it('uses every call of the stated list at least once as an import', () => {
    const names = imports.map((m) => m[2]);
    for (const c of REQUIRED_CALLS) expect(names).toContain(c);
  });
  it('queries the extended limit information (class 9) and the process id list (class 3), and sets class 9', () => {
    expect(code).toMatch(/SetInformationJobObject\(job, 9,/u);
    expect(code).toMatch(/QueryInformationJobObject\(job, 9,/u);
    expect(code).toMatch(/QueryInformationJobObject\(job, 3,/u);
  });
  it('puts the current process in the job and no other process', () => {
    expect(code).toMatch(/AssignProcessToJobObject\(job, GetCurrentProcess\(\)\)/u);
    expect([...code.matchAll(/AssignProcessToJobObject\(/gu)].length).toBe(2); // the import and the one call
  });
});

describe('run-capped.ps1: the limit flags are exactly 0x2200 (capped) and 0x2000 (none), never a breakaway', () => {
  it('writes both values and nothing else as a LimitFlags value', () => {
    expect(code).toContain('0x2200');
    expect(code).toContain('0x2000');
    const flags = [...code.matchAll(/LimitFlags\s*=\s*([^;]+);/gu)].map((m) => m[1]!.trim());
    expect(flags.length).toBe(1);
    expect(flags[0]).toMatch(/^limitBytes >= 0 \? 0x2200u : 0x2000u$/u);
  });
  it('names no breakaway flag, in any spelling', () => {
    for (const bad of ['0x800', 'BREAKAWAY', 'SILENT_BREAKAWAY', 'CREATE_BREAKAWAY']) {
      expect(code.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    }
  });
  it('the access mask for the membership check is PROCESS_QUERY_LIMITED_INFORMATION only (0x1000), never 0x0400 (BUG-T3-S7-10)', () => {
    expect(code).toMatch(/OpenProcess\(0x1000u, false,/u);
    expect(code).not.toMatch(/OpenProcess\(0x0400u/u);
    expect(code).not.toMatch(/0x0400/u);
  });
});

describe('run-capped.ps1: the size assertion and the cap validation come first', () => {
  it('asserts Marshal.SizeOf(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) is 144 before the first kernel32 call is made', () => {
    expect(code).toContain('Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))');
    const sizeCheck = code.search(/StructSize\(\) -ne 144/u);
    expect(sizeCheck).toBeGreaterThan(0);
    for (const call of [
      'Create(',
      'AssignCurrentProcess(',
      'Membership(',
      'PeakJobMemory(',
      'ProcessIds(',
    ]) {
      const first = code.search(new RegExp(`\\[DockitJob\\]::${call.replace('(', '\\(')}`, 'u'));
      expect(first, call).toBeGreaterThan(sizeCheck);
    }
  });
  it('validates Cap against exactly none, 8GiB, 6GiB and 5GiB, case-sensitively, before anything else runs', () => {
    expect(code).toMatch(/\$Cap -cnotin @\('none', '8GiB', '6GiB', '5GiB'\)/u);
    const validate = code.search(/\$Cap -cnotin/u);
    expect(validate).toBeGreaterThan(0);
    expect(validate).toBeLessThan(code.search(/Add-Type/u));
    expect(code).toMatch(/exit 2/u);
  });
  it('the limits are 8, 6 and 5 GiB as exact byte counts', () => {
    for (const n of ['8589934592', '6442450944', '5368709120']) expect(code).toContain(n);
  });
});

describe('run-capped.ps1: what it must never contain', () => {
  const forbidden: [string, RegExp][] = [
    ['Set-MpPreference', /Set-MpPreference/iu],
    ['Add-MpPreference', /Add-MpPreference/iu],
    ['reg add', /\breg(\.exe)?\s+add\b/iu],
    ['Set-ItemProperty on HKLM', /Set-ItemProperty[^\n]*HKLM/iu],
    ['New-ItemProperty on HKLM', /New-ItemProperty[^\n]*HKLM/iu],
    ['-Verb RunAs', /-Verb\s+RunAs/iu],
    ['Invoke-Expression', /Invoke-Expression/iu],
    ['iex', /(^|[\s;|(])iex(\s|$|[;|)])/iu],
    ['DownloadString', /DownloadString/iu],
    ['DownloadFile', /DownloadFile/iu],
    ['Invoke-WebRequest', /Invoke-WebRequest/iu],
    ['Invoke-RestMethod', /Invoke-RestMethod/iu],
    ['Start-BitsTransfer', /Start-BitsTransfer/iu],
    ['curl', /(^|[\s;|(])curl(\.exe)?(\s|$)/iu],
    ['wget', /(^|[\s;|(])wget(\.exe)?(\s|$)/iu],
    ['Get-ChildItem env:', /Get-ChildItem\s+(-Path\s+)?env:/iu],
    ['gci env:', /(^|[\s;|(])gci\s+env:/iu],
    ['dir env:', /(^|[\s;|(])dir\s+env:/iu],
    ['ls env:', /(^|[\s;|(])ls\s+env:/iu],
    ['Get-Item env:', /Get-Item\s+(-Path\s+)?env:/iu],
    ['an environment dump', /GetEnvironmentVariables\(\)/iu],
    ['set as a command', /(^|[;|&(]\s*|^\s*)set\s*($|[;|&)])/imu],
    ['cmd /c', /\bcmd(\.exe)?\s+\/c\b/iu],
    ['Start-Process -Verb', /Start-Process[^\n]*-Verb/iu],
    ['Install-Module or Install-Package', /Install-(Module|Package)/iu],
    ['a registry write', /\bHKLM:|\bHKCU:/iu],
    ['an http URL', /https?:\/\//iu],
    ['--no-sandbox', /--no-sandbox/iu],
  ];
  it.each(forbidden)('has no %s', (_name, re) => {
    expect(code).not.toMatch(re);
  });

  it('reads only the environment variables it was given or writes (no $env: other than the two CSV paths)', () => {
    const names = new Set([...code.matchAll(/\$env:(\w+)/giu)].map((m) => m[1]!));
    expect([...names].sort()).toEqual(['DOCKIT_BENCH_CSV', 'DOCKIT_BENCH_Q_CSV']);
  });
});

describe('run-capped.ps1: Add-Type', () => {
  it('compiles one inline C# class with -TypeDefinition and a here-string, with no -Path, -AssemblyName, -MemberDefinition or reference to a file', () => {
    const uses = [...code.matchAll(/Add-Type\b[^\n]*/gu)].map((m) => m[0]);
    expect(uses.length).toBe(1);
    expect(uses[0]).toMatch(/^Add-Type -TypeDefinition \$Source$/u);
    expect(code).not.toMatch(
      /Add-Type[^\n]*(-Path|-AssemblyName|-LiteralPath|-MemberDefinition|-ReferencedAssemblies)/u,
    );
    expect(code).toMatch(/\$Source = @'\n[\s\S]*\n'@/u);
    expect(code).not.toMatch(/\[Reflection\.Assembly\]::Load|Assembly\.LoadFrom|LoadFile\(/iu);
  });
});

describe('run-capped.ps1: what it writes and how it launches the benchmark', () => {
  it('builds the label from WMI facts, names the pwsh, node and Chrome process tree, and ends it with "; not a laptop"', () => {
    expect(code).toMatch(/Win32_ComputerSystem/u);
    expect(code).toMatch(/Win32_OperatingSystem/u);
    expect(code).toContain('pwsh, node and Chrome process tree');
    expect(code).toContain('; not a laptop');
    expect(code).toContain('no job limit');
    expect(code).toContain('job commit limit');
  });
  it('launches node on scripts/bench-e2e.mjs with --environment, --dist and the output files in OutDir, with no sandbox flag', () => {
    expect(code).toContain('scripts/bench-e2e.mjs');
    expect(code).toContain('--environment');
    expect(code).toContain("'--dist', 'dist'");
    expect(code).toContain('e2e-emulated-win-vm.csv');
    expect(code).toContain('e2e-emulated-win-vm-questions.csv');
  });
  it('writes job-summary.json and job-membership.jsonl, checks Chrome membership with IsProcessInJob every 2 s and records escapes', () => {
    expect(code).toContain('job-summary.json');
    expect(code).toContain('job-membership.jsonl');
    expect(code).toMatch(/Start-Sleep -Seconds 2/u);
    expect(code).toContain('chrome-profile-');
    expect(code).toMatch(/escapes = /u);
    expect(code).toMatch(/peakJobMemoryBytes/u);
  });
  it('never closes the job handle itself (KILL_ON_JOB_CLOSE would end pwsh, and the exit code with it)', () => {
    // calls only: the declaration of the import ('extern bool CloseHandle(IntPtr hObject)') is not one
    const closes = [...code.matchAll(/(?<!extern bool )CloseHandle\(([^)]*)\)/gu)].map((m) => m[1]);
    expect(closes).toEqual(['h']); // the process handle of the membership check, in the C# helper
  });
});

// First dispatch (run 44651054609): the workflow stopped at its checksum step on every leg, so this script has still not run on Windows. What is checked here is what can be
// checked without Windows: PowerShell's own parser reads the whole file (pwsh is preinstalled on every GitHub runner; where there is none the test is skipped), and the text
// holds the guards that keep a first run from ending without a trace.
describe('run-capped.ps1: parses, and cannot end without a trace', () => {
  it.skipIf(!hasPwsh())(
    'PowerShell parses the whole file without an error',
    { timeout: SPAWN_TEST_TIMEOUT_MS },
    () => {
      expect(pwshParseErrors(raw)).toEqual([]);
    },
  );

  it('makes OutDir absolute before any .NET call resolves a path against the process working directory', () => {
    const abs = code.search(
      /\$OutDir = \$ExecutionContext\.SessionState\.Path\.GetUnresolvedProviderPathFromPSPath\(\$OutDir\)/u,
    );
    expect(abs).toBeGreaterThan(0);
    expect(abs).toBeLessThan(code.search(/\[System\.IO\.File\]::Open\(/u));
    expect(abs).toBeLessThan(code.search(/\$summaryFile = Join-Path/u));
  });

  it('stops a benchmark that outlives its time limit, below the workflow job limit, with its children, and records it', () => {
    expect(code).toMatch(/\[int\]\$TimeoutMinutes = 80/u);
    const wf = readFileSync(join(root, '.github', 'workflows', 'bench-windows.yml'), 'utf8');
    const job = Number(/timeout-minutes: (\d+)/u.exec(wf)![1]);
    expect(80).toBeLessThan(job);
    expect(code).toMatch(/\$proc\.Kill\(\$true\)/u);
    expect(code).toMatch(/\$exitCode = if \(\$timedOut\) \{ 124 \}/u);
    expect(code).toMatch(/timedOut = \$timedOut/u);
  });

  it('reading the log is never fatal, and an unexpected error is written to the summary, the log and the exit code (5) with node and its children stopped', () => {
    const show = /function Show-NewLog \{[\s\S]*?\n\}\n/u.exec(code)![0];
    expect(show).toMatch(/\btry \{[\s\S]*\} catch \{/u);
    expect(code).toMatch(/\$proc = \$null\n/u); // defined before the catch can read it (strict mode refuses an unset variable)
    expect(code).toMatch(/\} catch \{\n {2}\$message = \$_\.Exception\.Message\n/u);
    expect(code).toMatch(/scriptError = \$message/u);
    expect(code).toMatch(/\$exitCode = 5/u);
  });
});

describe('scripts/win/README.md says what the script does', () => {
  const readme = readFileSync(join(root, 'scripts', 'win', 'README.md'), 'utf8');
  it('lists the same limits and flags as the script, as numbers a reader can check', () => {
    for (const [pretty, plain] of [
      ['8,589,934,592', '8589934592'],
      ['6,442,450,944', '6442450944'],
      ['5,368,709,120', '5368709120'],
    ]) {
      expect(readme).toContain(pretty);
      expect(code).toContain(plain);
    }
    expect(readme).toContain('0x2200');
    expect(readme).toContain('0x2000');
    expect(readme).toContain('144');
  });
  it('says the job holds pwsh, node and Chrome, that nothing here ran, and that no 8 GB cell is filled', () => {
    expect(readme).toContain('pwsh, node and Chrome process tree');
    expect(readme).toMatch(/has never run|None of this has run/u);
    expect(readme).toMatch(/not measured on 8 GB/u);
    expect(readme).toMatch(/done-when\s+stays NOT met/u);
    expect(readme).toMatch(/is \*\*not built\*\*/u);
  });
});
