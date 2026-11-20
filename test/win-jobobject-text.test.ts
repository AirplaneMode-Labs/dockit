import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';
import { hasPwsh, pwshParseErrors } from './helpers/pwsh.ts';
import { parseCsv } from '../scripts/bench-readme.mjs';

// scripts/win/run-capped.ps1 runs only on Windows, and this Mac has none: it ran for the first time in bench-windows run 44656249868 (20 Nov 2026). So this file is
// a static check of its text (S1, TD-113): only documented kernel32 calls, exactly the two limit-flag values, no breakaway, no download, no environment dump, one
// inline C# class compiled by Add-Type -TypeDefinition (compiled for real by PowerShell's own compiler in the last describe), the 144-byte size assertion before any
// call, the cap validated, and the order of the new steps (read-back, probe, then the benchmark). It proves what the file says; test/win-run-capped-stub.test.ts runs it
// with kernel32 stubbed; what the run showed (the job holds the whole tree) and what it did not (that the limit bound anything) is in scripts/win/README.md.
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
  // the limit evidence: VirtualAlloc and VirtualFree commit and release the probe's memory inside the job (MEM_COMMIT | MEM_RESERVE, MEM_RELEASE; nothing is touched),
  // CreateIoCompletionPort and GetQueuedCompletionStatus count the job's JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages
  'VirtualAlloc',
  'VirtualFree',
  'CreateIoCompletionPort',
  'GetQueuedCompletionStatus',
];
const REQUIRED_CALLS = [
  ...ALLOWED_CALLS.slice(0, 6),
  'VirtualAlloc',
  'VirtualFree',
  'CreateIoCompletionPort',
  'GetQueuedCompletionStatus',
];

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
  it('queries the extended limit information (class 9) and the process id list (class 3), sets class 9, and associates the completion port (class 7) and nothing else', () => {
    expect(code).toMatch(/SetInformationJobObject\(job, 9,/u);
    expect(code).toMatch(/QueryInformationJobObject\(job, 9,/u);
    expect(code).toMatch(/QueryInformationJobObject\(job, 3,/u);
    expect(code).toMatch(/SetInformationJobObject\(job, 7,/u);
    const classes = [...code.matchAll(/(?:Set|Query)InformationJobObject\(job, (\d+),/gu)].map(
      (m) => m[1],
    );
    expect(new Set(classes)).toEqual(new Set(['9', '3', '7']));
  });
  it('puts the current process in the job and no other process', () => {
    expect(code).toMatch(/AssignProcessToJobObject\(job, GetCurrentProcess\(\)\)/u);
    expect([...code.matchAll(/AssignProcessToJobObject\(/gu)].length).toBe(2); // the import and the one call
  });
});

describe('run-capped.ps1: the limit flags are exactly 0x2200 (capped) and 0x2000 (none), never a breakaway', () => {
  it('writes both values and nothing else as a LimitFlags value (the read-back assigns LimitFlags from the system, which is not a write)', () => {
    expect(code).toContain('0x2200');
    expect(code).toContain('0x2000');
    const writes = [...code.matchAll(/BasicLimitInformation\.LimitFlags\s*=\s*([^;]+);/gu)].map(
      (m) => m[1]!.trim(),
    );
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatch(/^limitBytes >= 0 \? 0x2200u : 0x2000u$/u);
    expect(
      [...code.matchAll(/\.LimitFlags\s*=\s*([^;]+);/gu)].map((m) => m[1]!.trim()).sort(),
    ).toEqual(
      ['info.BasicLimitInformation.LimitFlags', 'limitBytes >= 0 ? 0x2200u : 0x2000u'].sort(),
    );
  });
  it('names no breakaway flag, in any spelling (0x800 is JOB_OBJECT_LIMIT_BREAKAWAY_OK; 0x8000, the release flag of VirtualFree, is a different number)', () => {
    for (const bad of ['BREAKAWAY', 'SILENT_BREAKAWAY', 'CREATE_BREAKAWAY']) {
      expect(code.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    }
    expect(code).not.toMatch(/(?<![0-9A-Fa-fx])0x0*800[uU]?(?![0-9A-Fa-f])/u);
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
      'ReadBack(',
      'TryCommit(',
      'AttachCompletionPort(',
      'Drain(',
      'ProcessIds(',
    ]) {
      const first = code.search(new RegExp(`\\[DockitJob\\]::${call.replace('(', '\\(')}`, 'u'));
      expect(first, call).toBeGreaterThan(sizeCheck);
    }
  });
  it('validates Cap against exactly none, 8GiB, 6GiB, 5GiB and the 2GiB control, case-sensitively, before anything else runs', () => {
    expect(code).toMatch(/\$Cap -cnotin @\('none', '8GiB', '6GiB', '5GiB', '2GiB'\)/u);
    const validate = code.search(/\$Cap -cnotin/u);
    expect(validate).toBeGreaterThan(0);
    expect(validate).toBeLessThan(code.search(/Add-Type/u));
    expect(code).toMatch(/exit 2/u);
  });
  it('the limits are 8, 6, 5 and 2 GiB as exact byte counts, and 2GiB is the one control cap', () => {
    for (const n of ['8589934592', '6442450944', '5368709120', '2147483648'])
      expect(code).toContain(n);
    expect(code).toMatch(/\$IsControl = \$Cap -ceq '2GiB'/u);
    expect(code).toMatch(/\$ControlTimeoutMinutes = 12/u);
    expect(code).toMatch(
      /if \(\$IsControl -and -not \$PSBoundParameters\.ContainsKey\('TimeoutMinutes'\)\) \{ \$TimeoutMinutes = \$ControlTimeoutMinutes \}/u,
    );
    expect(code).toContain("' (control leg, expected to fail)'");
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
    // the completion port, only when it could not be associated with the job, and the process handle of the membership check
    expect(closes).toEqual(['port', 'h']);
  });
});

// The first dispatch (run 44651054609) stopped at its checksum step on every leg; the second (run 44656249868) ran the script. What is checked here is what can be
// checked without Windows: PowerShell's own parser reads the whole file (pwsh is preinstalled on every GitHub runner; where there is none the test is skipped), and the text
// holds the guards that keep a run from ending without a trace.
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
    // the job limit is 90 minutes, or 20 on the control leg (which stops itself after 12): the script's time limit is below each
    const job = /timeout-minutes: \$\{\{ matrix\.control && (\d+) \|\| (\d+) \}\}/u.exec(wf)!;
    expect(80).toBeLessThan(Number(job[2]));
    expect(12).toBeLessThan(Number(job[1]));
    expect(code).toMatch(/\$proc\.Kill\(\$true\)/u);
    expect(code).toMatch(/\$benchExit = if \(\$timedOut\) \{ 124 \}/u);
    expect(code).toMatch(/\$exitCode = \$benchExit\n/u);
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

// The change of 20 Nov 2026 (after bench-windows run 44656249868): the limit is read back, probed from inside the job, counted on a completion port, and a control leg
// must fail. What is checked here is the order and the shape of those steps in the text; test/win-run-capped-stub.test.ts runs them with kernel32 stubbed.
describe('run-capped.ps1: read-back, probe, completion port and the control verdict', () => {
  const at = (re: RegExp) => code.search(re);

  it('reads the limit back from the system (never from its own constants) right after Create and again right after the process is assigned, and exits 6 on a difference', () => {
    expect(code).toMatch(/function Get-ReadBack \{\n {2}\$r = \[DockitJob\]::ReadBack\(\$job\)/u);
    const create = at(/\$job = \[DockitJob\]::Create\(/u);
    const first = at(/\$rb1 = Get-ReadBack/u);
    const assign = at(/\[DockitJob\]::AssignCurrentProcess\(\$job\)/u);
    const second = at(/\$rb2 = Get-ReadBack/u);
    expect(create).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(create);
    expect(assign).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(assign);
    // flags and JobMemoryLimit are what is compared, against what Create sets
    expect(code).toMatch(
      /\(\(\$rb\['flags'\] -ceq \$ExpectedFlagsText\) -and \(\[uint64\]\$rb\['jobMemoryLimit'\] -eq \$ExpectedLimit\)\)/u,
    );
    expect(code).toMatch(
      /\$ExpectedFlagsText = if \(\$null -eq \$LimitBytes\) \{ '0x2000' \} else \{ '0x2200' \}/u,
    );
    expect(code).toMatch(
      /\$ExpectedLimit = if \(\$null -eq \$LimitBytes\) \{ \[uint64\]0 \} else \{ \[uint64\]\$LimitBytes \}/u,
    );
    // exit 6 is the one exit of Stop-ForReadBack, which both read-backs call, before the benchmark is started
    expect([...code.matchAll(/\bexit 6\b/gu)]).toHaveLength(1);
    expect(code).toMatch(/function Stop-ForReadBack[\s\S]*?\n {2}exit 6\n\}/u);
    expect([...code.matchAll(/Stop-ForReadBack '/gu)]).toHaveLength(2);
    expect(at(/Stop-ForReadBack 'after assign'/u)).toBeLessThan(
      at(/Start-Process -FilePath \$node/u),
    );
    expect(code).toContain("failReason'] = 'limit_readback_mismatch'");
  });

  it('on the leg with no limit it records that no limit is set (JobMemoryLimit 0, flags 0x2000) and probes nothing', () => {
    expect(code).toContain(
      'no limit is set on this leg: JobMemoryLimit reads 0 and only KILL_ON_JOB_CLOSE (0x2000) is on',
    );
    expect(code).toContain("reason = 'no limit is set on this leg, so there is nothing to probe'");
    expect(code).toMatch(/if \(\$null -ne \$LimitBytes\) \{\n {2}\$over = /u);
  });

  it('probes from inside the job, after the second read-back and before node starts: a small commit, then limit + 256 MiB, both freed', () => {
    expect(code).toMatch(/\$ProbeSmallBytes = \[uint64\]67108864\n/u);
    expect(code).toMatch(/\$ProbeOverBytes = \[uint64\]268435456\n/u);
    expect(code).toMatch(/\$over = \[uint64\]\$LimitBytes \+ \$ProbeOverBytes/u);
    const probe = at(/\$over = \[uint64\]\$LimitBytes/u);
    expect(probe).toBeGreaterThan(at(/\$rb2 = Get-ReadBack/u));
    expect(probe).toBeLessThan(at(/Start-Process -FilePath \$node/u));
    // VirtualAlloc(IntPtr.Zero, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE), freed with MEM_RELEASE and a size of zero; nothing touches the memory
    expect(code).toMatch(/VirtualAlloc\(IntPtr\.Zero, new UIntPtr\(bytes\), 0x3000u, 0x04u\)/u);
    expect(code).toMatch(/VirtualFree\(p, UIntPtr\.Zero, 0x8000u\)/u);
    expect(code).not.toMatch(/Marshal\.(WriteByte|WriteInt|Copy)|ZeroMemory|FillMemory/u);
    // the peak before, after the small commit and after the probe, and the answer to the question whether a refused commit is counted in the peak
    for (const k of [
      'peakBeforeBytes',
      'peakAfterSmallCommitBytes',
      'peakAfterBytes',
      'jobMemoryLimitMessagesAfterProbe',
    ])
      expect(code, k).toContain(k);
    expect(code).toMatch(
      /\$refused = if \(\$big\.Committed\) \{ \$false \} elseif \(\$smallOk -and \$roomOk\) \{ \$true \} else \{ \$null \}/u,
    );
    expect(code).toMatch(/\$limitNotEnforced = \(\$refused -eq \$false\)/u);
    expect(code).toMatch(/\$facts\['limitNotEnforced'\] = \$limitNotEnforced/u);
  });

  it('a commit that succeeds marks the leg limitNotEnforced with a warning and never aborts the benchmark (the one exit in the probe is none)', () => {
    const probeBlock = code.slice(
      at(/\$probe = \[ordered\]@\{ ran = \$false/u),
      at(/\$facts\['probe'\] = \$probe/u),
    );
    expect(probeBlock).toContain(
      '::warning::run-capped: the commit of limit + 256 MiB succeeded inside the job, so the cap was NOT in force',
    );
    expect(probeBlock).not.toMatch(/\bexit\b|\bthrow\b|\bbreak\b|\breturn\b/u);
  });

  it('does not let the probe pass for the whole-tree peak: peakIncludesProbe is recorded from the final peak against the one after the probe', () => {
    expect(code).toMatch(
      /\$probe\['peakIncludesProbe'\] = \(\$peak -le \[uint64\]\$probe\['peakAfterBytes'\]\)/u,
    );
  });

  it('attaches a completion port whose failure is recorded and never stops the run, drains it on every tick, and counts JOB_OBJECT_MSG_JOB_MEMORY_LIMIT (10)', () => {
    expect(code).toMatch(
      /try \{\n {2}\$port = \[DockitJob\]::AttachCompletionPort\(\$job\)\n\} catch \{\n {2}\$port = \[IntPtr\]::Zero\n {2}\$portError = /u,
    );
    expect(code).toMatch(/message == 10u\)/u);
    expect(code).toMatch(/MsgJobMemoryLimit\+\+/u);
    expect(code).toMatch(
      /function Update-CompletionPort \{\n {2}if \(\$script:port -eq \[IntPtr\]::Zero\) \{ return \}\n {2}try \{ \[DockitJob\]::Drain\(\$script:port\) \} catch/u,
    );
    const tick = /function Test-MembershipOnce \{[\s\S]*?\n\}\n/u.exec(code)![0];
    expect(tick).toContain('Update-CompletionPort');
    expect(tick).toMatch(/peakJob = \$peakJob/u);
    expect(tick).toMatch(/peakProc = \$peakProc/u);
    expect(tick).toMatch(/jobMemoryLimitMessages = \$messages/u);
    // a failed read of the peak is a gap in the tick, never the end of the sampler
    expect(tick).toMatch(/try \{\n\s+\$rb = Get-ReadBack[\s\S]*?\} catch \{ \$null = \$_ \}/u);
  });

  it('the summary is version 2 and holds the read-backs, the probe, the port, the first and last peak of the sampler and the final peak', () => {
    expect(code).toMatch(/summaryVersion = 2\n/u);
    for (const k of [
      'controlLeg = $IsControl',
      'limitSet = ($null -ne $LimitBytes)',
      'benchStarted = $script:benchStarted',
      "$facts['readBack']",
      "$facts['probe']",
      "$facts['completionPort']",
      'peakJobSamples = [ordered]@{ firstSample = $peakFirst; lastSample = $peakLast',
      'peakJobMemoryBytes = [int64]$peak',
      'benchProgress = $progress',
    ])
      expect(code, k).toContain(k);
    // written before the benchmark as well, so a leg the runner cancels still leaves the evidence
    expect(code).toMatch(/Write-Summary @\{ phase = 'before-benchmark' \}/u);
  });

  it('writes a summary that says the benchmark started right after it starts it, and a failed tick (even a failed note of it) never ends the sampler', () => {
    const started = at(
      /\$benchStarted = \$true\n\s+Write-Summary @\{ phase = 'benchmark-running' \}/u,
    );
    expect(started).toBeGreaterThan(at(/Start-Process -FilePath \$node/u));
    expect(started).toBeLessThan(at(/while \(-not \$proc\.HasExited\)/u));
    const wrapper = /function Test-Membership \{[\s\S]*?\n\}\n/u.exec(code)![0];
    expect(wrapper).toMatch(
      /try \{ Test-MembershipOnce \} catch \{[\s\S]*try \{ Add-Content -Path \$membershipFile[\s\S]*\} catch \{ \$null = \$_ \}\n\s*\}/u,
    );
  });

  it('the control leg: a verdict function, exit 0 only for a benchmark that did not complete with the probe refused, 7 when it completed, 8 when the stop proves nothing', () => {
    const fn = /function Get-ControlVerdict[\s\S]*?\n\}\n/u.exec(code)![0];
    expect(fn).toMatch(
      /if \(\$benchCompleted\) \{ return \[ordered\]@\{ outcome = 'completed_unexpectedly'; verdict = 'cap_does_nothing'; exit = 7 \} \}/u,
    );
    expect(fn).toMatch(/if \(\$probeRefused -eq \$true\)/u);
    expect(fn).toMatch(/verdict = 'control_passed'; exit = 0/u);
    expect(fn).toMatch(/outcome = 'inconclusive'; verdict = 'control_inconclusive'; exit = 8/u);
    expect(code).toMatch(/\$benchCompleted = \(-not \$timedOut\) -and \(\$benchExit -eq 0\)/u);
    expect(code).toMatch(/\$exitCode = \[int\]\$v\['exit'\]/u);
    expect(code).toContain(
      '::error::run-capped: the benchmark completed under the control limit of $LimitBytes bytes: the cap does nothing',
    );
    // the exit codes are all in the header, once
    const header = raw.slice(0, raw.indexOf('[CmdletBinding()]'));
    for (const c of ['124', '2', '3', '4', '5', '6', '7', '8']) expect(header).toContain(`${c} `);
    expect(header).toMatch(/exit code is the verdict instead/u);
  });
});

// The C# of the script compiled by PowerShell's own compiler (Add-Type, the very call the script makes; on this machine and on a GitHub runner it is Roslyn): the kernel32
// imports are declared and never called here, so what this proves is that the class compiles, that the structure marshals to 144 bytes, and that the new types exist.
describe('run-capped.ps1: the C# class compiles', () => {
  it.skipIf(!hasPwsh())(
    'Add-Type -TypeDefinition accepts the here-string, StructSize() is 144 and the evidence types and members are there',
    { timeout: SPAWN_TEST_TIMEOUT_MS },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'dockit-cs-'));
      const driver = join(dir, 'compile.ps1');
      writeFileSync(
        driver,
        [
          'param([string]$Script)',
          '$text = [System.IO.File]::ReadAllText($Script)',
          String.raw`$m = [regex]::Match($text, '(?s)\$Source = @''\n(.*?)\n''@')`,
          'Add-Type -TypeDefinition $m.Groups[1].Value',
          "Write-Output ('size=' + [DockitJob]::StructSize())",
          "Write-Output ('members=' + (([DockitJob].GetMembers() | Where-Object { $_.MemberType -in 'Method', 'Field' } | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ','))",
          "Write-Output ('types=' + (([DockitJob].GetNestedTypes() | ForEach-Object { $_.Name } | Sort-Object) -join ','))",
        ].join('\n'),
      );
      const r = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          driver,
          join(root, 'scripts', 'win', 'run-capped.ps1'),
        ],
        { encoding: 'utf8' },
      );
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toMatch(/^size=144$/mu);
      const members = /^members=(.*)$/mu.exec(r.stdout)![1]!.split(',');
      for (const m of [
        'ReadBack',
        'TryCommit',
        'AttachCompletionPort',
        'Drain',
        'MsgJobMemoryLimit',
        'FirstJobMemoryLimitPid',
        'Create',
        'AssignCurrentProcess',
        'Membership',
        'ProcessIds',
      ])
        expect(members, m).toContain(m);
      const types = /^types=(.*)$/mu.exec(r.stdout)![1]!.split(',');
      for (const t of [
        'CommitResult',
        'JobReadback',
        'JOBOBJECT_ASSOCIATE_COMPLETION_PORT',
        'JOBOBJECT_EXTENDED_LIMIT_INFORMATION',
      ])
        expect(types, t).toContain(t);
    },
  );
});

describe('scripts/win/README.md says what the script does', () => {
  const readme = readFileSync(join(root, 'scripts', 'win', 'README.md'), 'utf8');
  it('lists the same limits and flags as the script, as numbers a reader can check', () => {
    for (const [pretty, plain] of [
      ['8,589,934,592', '8589934592'],
      ['6,442,450,944', '6442450944'],
      ['5,368,709,120', '5368709120'],
      ['2,147,483,648', '2147483648'],
    ]) {
      expect(readme).toContain(pretty);
      expect(code).toContain(plain);
    }
    expect(readme).toContain('0x2200');
    expect(readme).toContain('0x2000');
    expect(readme).toContain('144');
  });
  it('says the job holds pwsh, node and Chrome, records the three dispatches, says the limit is proven in force and the anomaly settled, and that no 8 GB cell is filled', () => {
    const flat = readme.replace(/\s+/g, ' ');
    expect(readme).toContain('pwsh, node and Chrome process tree');
    for (const id of ['44651054609', '44656249868', '44666921454'])
      expect(readme, id).toContain(`| ${id} |`);
    expect(flat).toContain(
      'the memory limit is proven in force on every capped leg, and the anomaly the second dispatch left is settled',
    );
    expect(flat).toContain(
      '**Why the third run replaces the second in the live files and is not appended to them.**',
    );
    expect(flat).toContain('`docs/benchmarks/history/`');
    expect(flat).toContain('`docs/benchmarks/emulated-win-vm-run-44666921454/`');
    expect(flat).toContain('explanation 2 is the one');
    expect(flat).toContain(
      '**a whole-tree peak above a limit does not mean the limit was exceeded**',
    );
    expect(flat).toContain('**the limit is proven in force on the 8, 6, 5 and 2 GiB legs**');
    expect(flat).toContain(
      'Explanation 1 of the second dispatch (the limit was not in effect) is excluded.',
    );
    expect(flat).toContain(
      'On the 5 GiB leg it is **2**: commits were refused while the benchmark ran',
    );
    expect(flat).toContain('On the **8 and 6 GiB legs the count is 0**');
    expect(flat).toContain('### The 2 GiB control passed');
    expect(flat).toContain('`control.verdict` is `control_passed`');
    expect(flat).toContain('### No claim about speed under a cap');
    expect(flat).toContain('It is not a laptop and not an 8 GB figure');
    expect(flat).toContain("Sprint 5's 8 GB done-when stays NOT met (owner runbook step 5)");
    expect(readme).not.toMatch(
      /the memory limit is unproven|has never run|None of this has run|What only the first run can prove|not yet run on Windows|has not run on Windows/u,
    );
    expect(readme).toMatch(/not measured on 8 GB/u);
    expect(readme).toMatch(/done-when\s+stays NOT met/u);
    expect(readme).toMatch(/is \*\*not built\*\*/u);
  });
  it('describes the change that settled the limit as written and tested with kernel32 stubbed and then run on Windows: read-back, peak on every tick, probe, 2 GiB control, completion port, and what each outcome of the dispatch was', () => {
    expect(readme).toMatch(
      /The change that settled it \(written and tested with kernel32 stubbed, then run on Windows in run 44666921454\)/u,
    );
    expect(readme).toMatch(/\*\*Read the limit back\.\*\*/u);
    expect(readme).toMatch(/\*\*Log `PeakJobMemoryUsed` on every 2-second tick\*\*/u);
    expect(readme).toMatch(/\*\*Probe the limit inside the job before the benchmark\*\*/u);
    expect(readme).toMatch(/\*\*A control leg that must fail\.\*\*/u);
    expect(readme).toMatch(/\*\*A completion port on the job\*\*/u);
    expect(readme).toContain('JOB_OBJECT_MSG_JOB_MEMORY_LIMIT');
    expect(readme).toContain('test/win-run-capped-stub.test.ts');
    // what the stub cannot show is said, and so is the answer to explanation 2
    expect(readme).toMatch(/They do not show what the real kernel answers/u);
    expect(readme).toMatch(/that is the answer to explanation 2/u);
    // the table of outcomes names every distinct result, and says which one happened
    for (const k of [
      'readBack.equal',
      'limitNotEnforced',
      'Exit 6',
      'Control exit 7',
      'Control exit 8',
      'firstJobMemoryLimitPid',
      'What run 44666921454 recorded',
    ])
      expect(readme, k).toContain(k);
    for (const k of [
      'cap_does_nothing',
      'control_passed',
      'control_inconclusive',
      'failed_as_expected',
    ])
      expect(readme, k).toContain(k);
    expect(readme).toContain('limit proven in force (probe refused, read-back equal)');
    expect(readme).not.toMatch(/\(not made: it needs a Windows run to test\)/u);
    expect(readme).not.toMatch(/Until a dispatch with this change has run/u);
  });
  it('documents the exit codes, the probe sizes and the empty whole-tree peak the same way the script does', () => {
    expect(readme).toMatch(/exits 124 when it had to stop the benchmark/u);
    expect(readme).toMatch(/5 for an error it did not expect/u);
    expect(readme).toMatch(/6 for a read-back that differs from what was set/u);
    expect(readme).toMatch(/on the control leg 0, 7 or 8 as the\s+verdict/u);
    expect(readme).toMatch(/commits 64 MiB[\s\S]*limit plus 256 MiB/u);
    expect(readme).toMatch(/`probe\.peakIncludesProbe`[\s\S]*empty cell \(not measured\)/u);
    expect(code).toContain('$ProbeSmallBytes = [uint64]67108864');
    expect(code).toContain('$ProbeOverBytes = [uint64]268435456');
    expect(readme).toMatch(/12 on the control leg, below its 20/u);
  });
  it('quotes the committed figures of both runs, byte for byte: the second run (history) whole-tree peaks and its 5 GiB leg above its own limit, the third run probe peaks and message counts', () => {
    const fmt = (n: number) => n.toLocaleString('en-US');
    const history = parseCsv(
      readFileSync(
        join(root, 'docs', 'benchmarks', 'history', 'e2e-emulated-win-vm-run-44656249868.csv'),
        'utf8',
      ),
    );
    const peaks = new Map(
      history.map((r) => [r.job_commit_limit_bytes!, Number(r.job_commit_peak_bytes)]),
    );
    expect([...peaks.keys()]).toEqual(['', '8589934592', '6442450944', '5368709120']);
    for (const p of peaks.values()) expect(readme).toContain(fmt(p));
    const five = peaks.get('5368709120')!;
    expect(five).toBeGreaterThan(5368709120);
    expect(readme).toContain(`**${fmt(five)} bytes, ${fmt(five - 5368709120)} bytes`);
    // the third run: every number the README quotes is in a committed job-summary.json
    const dir = join(root, 'docs', 'benchmarks', 'emulated-win-vm-run-44666921454');
    for (const cap of ['8GiB', '6GiB', '5GiB', '2GiB']) {
      const sum = JSON.parse(readFileSync(join(dir, cap, 'job-summary.json'), 'utf8'));
      for (const n of [
        sum.limitBytes,
        sum.probe.peakBeforeBytes,
        sum.probe.peakAfterSmallCommitBytes,
        sum.probe.peakAfterBytes,
      ])
        expect(readme, `${cap} ${n}`).toContain(fmt(n));
      expect(sum.probe.lastError).toBe(1455);
      expect(sum.probe.refused).toBe(true);
      const held = sum.probe.peakAfterBytes - sum.limitBytes - sum.probe.overLimitBytes;
      expect(readme, `${cap} held ${held}`).toContain(fmt(held));
    }
    const none = JSON.parse(readFileSync(join(dir, 'none', 'job-summary.json'), 'utf8'));
    expect(readme).toContain(fmt(none.peakJobMemoryBytes));
    const five3 = JSON.parse(readFileSync(join(dir, '5GiB', 'job-summary.json'), 'utf8'));
    expect(readme).toContain(fmt(five3.peakJobMemoryBytes));
    expect(five3.completionPort.jobMemoryLimitMessages).toBe(3);
    expect(five3.probe.jobMemoryLimitMessagesAfterProbe).toBe(1);
  });
});
