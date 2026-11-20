import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the REAL scripts/win/run-capped.ps1 on a machine that has no Windows: the C# class it compiles is rewritten so that every kernel32 import becomes a call into a
// small managed stand-in (Kernel32Stub, below) that behaves like a job object with, or without, an enforced commit limit; Get-CimInstance is a function of the
// driver; and `node scripts/bench-e2e.mjs` is a fake that writes a CSV the way the real one does (with the repository's own column list and zero-row writer) and exits
// the way the scenario says. So the PowerShell around the calls (read-back, probe, completion port, control-leg verdict, summary, exit codes) is the code that will run
// on Windows; only the kernel32 answers are scripted. What this cannot show is what the real kernel says: that is the next bench-windows dispatch.

const root = join(import.meta.dirname, '..', '..');
export const scriptPath = join(root, 'scripts', 'win', 'run-capped.ps1');

/** The kernel32 stand-in. Behaviour is chosen by environment variables, read by the C# (the script under test is never given them). */
const STUB = String.raw`
public static class Kernel32Stub
{
    static DockitJob.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
    static bool assigned;
    static ulong committed;
    static ulong peak;
    static long nextBlock = 0x10000;
    static Dictionary<long, ulong> blocks = new Dictionary<long, ulong>();
    static Queue<uint> messages = new Queue<uint>();
    static Queue<long> messagePids = new Queue<long>();

    static string Env(string name) { return Environment.GetEnvironmentVariable(name) ?? ""; }
    static bool Enforce() { return Env("STUB_ENFORCE") != "0"; }
    static bool Capped() { return (info.BasicLimitInformation.LimitFlags & 0x200u) != 0; }
    static void Raise(ulong v) { if (v > peak) peak = v; }

    public static IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName) { return new IntPtr(0x1000); }

    public static bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength)
    {
        if (JobObjectInfoClass == 9)
        {
            info = (DockitJob.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(lpJobObjectInfo, typeof(DockitJob.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            return true;
        }
        return JobObjectInfoClass == 7;
    }

    public static bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess)
    {
        if (Env("STUB_ASSIGN_FAIL") == "1") { Marshal.SetLastPInvokeError(5); return false; }
        assigned = true;
        committed = 157286400UL;
        Raise(committed);
        messages.Enqueue(6u);
        messagePids.Enqueue(1);
        return true;
    }

    public static bool QueryInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength, IntPtr lpReturnLength)
    {
        if (JobObjectInfoClass == 3)
        {
            Marshal.WriteInt32(lpJobObjectInfo, 0, 3);
            Marshal.WriteInt32(lpJobObjectInfo, 4, 3);
            for (int i = 0; i < 3; i++) Marshal.WriteIntPtr(lpJobObjectInfo, 8 + i * IntPtr.Size, new IntPtr(100 + i));
            return true;
        }
        DockitJob.JOBOBJECT_EXTENDED_LIMIT_INFORMATION o = info;
        string mode = Env("STUB_READBACK");
        if (mode == "flags-create") o.BasicLimitInformation.LimitFlags = o.BasicLimitInformation.LimitFlags ^ 0x4u;
        if (mode == "limit-assign" && assigned) o.JobMemoryLimit = new UIntPtr(((ulong)o.JobMemoryLimit) - 4096UL);
        ulong reported = peak;
        // the fake benchmark leaves a marker file when it starts; from then on the job's high-water mark is the benchmark's own
        string marker = Env("STUB_MARKER");
        if (marker != "" && File.Exists(marker) && Env("STUB_BENCH_PEAK") != "") reported = Math.Max(reported, ulong.Parse(Env("STUB_BENCH_PEAK")));
        o.PeakJobMemoryUsed = new UIntPtr(reported);
        o.PeakProcessMemoryUsed = new UIntPtr(reported / 2UL);
        Marshal.StructureToPtr(o, lpJobObjectInfo, false);
        return true;
    }

    public static bool IsProcessInJob(IntPtr ProcessHandle, IntPtr JobHandle, out bool Result)
    {
        Result = Env("STUB_ESCAPE") != "1";
        return true;
    }

    public static bool CloseHandle(IntPtr hObject) { return true; }
    public static IntPtr GetCurrentProcess() { return new IntPtr(-1); }
    public static IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId) { return new IntPtr(1); }

    public static IntPtr VirtualAlloc(IntPtr lpAddress, UIntPtr dwSize, uint flAllocationType, uint flProtect)
    {
        ulong size = (ulong)dwSize;
        if (Env("STUB_SMALL_FAIL") == "1" && size == 67108864UL) { Marshal.SetLastPInvokeError(8); return IntPtr.Zero; }
        ulong limit = Capped() ? (ulong)info.JobMemoryLimit : ulong.MaxValue;
        if (Enforce() && committed + size > limit)
        {
            // what a refused commit does to the high-water mark is a property of the real kernel, which is exactly what the probe measures: both are scriptable here
            if (Env("STUB_REFUSED_COUNTS") == "1") Raise(committed + size);
            messages.Enqueue(10u);
            messagePids.Enqueue(4321);
            Marshal.SetLastPInvokeError(1455);
            return IntPtr.Zero;
        }
        committed += size;
        Raise(committed);
        nextBlock += 0x10000;
        blocks[nextBlock] = size;
        return new IntPtr(nextBlock);
    }

    public static bool VirtualFree(IntPtr lpAddress, UIntPtr dwSize, uint dwFreeType)
    {
        if (Env("STUB_FREE_FAIL") == "1") { Marshal.SetLastPInvokeError(87); return false; }
        ulong size;
        if (!blocks.TryGetValue(lpAddress.ToInt64(), out size)) return false;
        blocks.Remove(lpAddress.ToInt64());
        committed -= size;
        return true;
    }

    public static IntPtr CreateIoCompletionPort(IntPtr FileHandle, IntPtr ExistingCompletionPort, UIntPtr CompletionKey, uint NumberOfConcurrentThreads)
    {
        if (Env("STUB_NO_IOCP") == "1") { Marshal.SetLastPInvokeError(87); return IntPtr.Zero; }
        return new IntPtr(0x2000);
    }

    public static bool GetQueuedCompletionStatus(IntPtr CompletionPort, out uint lpNumberOfBytesTransferred, out UIntPtr lpCompletionKey, out IntPtr lpOverlapped, uint dwMilliseconds)
    {
        lpCompletionKey = UIntPtr.Zero;
        if (messages.Count == 0)
        {
            lpNumberOfBytesTransferred = 0u;
            lpOverlapped = IntPtr.Zero;
            Marshal.SetLastPInvokeError(258);
            return false;
        }
        lpNumberOfBytesTransferred = messages.Dequeue();
        lpOverlapped = new IntPtr(messagePids.Dequeue());
        return true;
    }
}
`;

/** The script with its C# class rewritten to call Kernel32Stub instead of kernel32.dll, and the stand-in appended. */
export function stubbedScript(raw: string): string {
  const m = /\$Source = @'\n([\s\S]*?)\n'@/u.exec(raw);
  if (m === null) throw new Error('run-capped.ps1: no $Source here-string');
  let calls = 0;
  const csharp = m[1]!.replace(
    /\[DllImport\("kernel32\.dll"[^\]]*\)\]\s*public static extern (\S+) (\w+)\(([^)]*)\);/gu,
    (_all, ret: string, name: string, params: string) => {
      calls++;
      const names = params
        .split(',')
        .map((p) => p.trim())
        .map((p) => `${p.startsWith('out ') ? 'out ' : ''}${p.split(/\s+/u).at(-1)}`)
        .join(', ');
      return `public static ${ret} ${name}(${params}) { return Kernel32Stub.${name}(${names}); }`;
    },
  );
  if (calls < 10) throw new Error(`only ${calls} kernel32 imports rewritten`);
  if (csharp.includes('DllImport')) throw new Error('a DllImport was left in the C#');
  const body = `using System.Collections.Generic;\nusing System.IO;\n${csharp}\n${STUB}`;
  return raw.replace(m[0], () => `$Source = @'\n${body}\n'@`);
}

/** The fake benchmark: bench-e2e.mjs as far as run-capped.ps1 can tell (its arguments, its two CSV paths, its log, its exit code). */
const FAKE_BENCH = String.raw`
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const cols = await import(pathToFileURL(join(process.env.DOCKIT_STUB_ROOT, 'scripts', 'lib', 'bench-columns.mjs')).href);
const args = process.argv.slice(2);
const label = args[args.indexOf('--environment') + 1];
const mode = process.env.FAKE_BENCH;
writeFileSync(process.env.STUB_MARKER, 'started');
console.log('fake bench-e2e: ' + mode);
await new Promise((r) => setTimeout(r, 2600));
const write = (file, c, rows) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, cols.csv(c, rows));
};
if (mode === 'crash') {
  console.error('fake bench-e2e: crashed before it wrote anything');
  process.exit(1);
}
const date = '2026-11-21T00:00:00.000Z';
if (mode === 'fail') {
  const z = cols.runZeroRows({ date, label, commit: 'fakecommit001', reason: 'out_of_memory' });
  write(process.env.DOCKIT_BENCH_CSV, cols.E2E_EMULATED_COLUMNS, [z.e2e]);
  write(process.env.DOCKIT_BENCH_Q_CSV, cols.Q_EMULATED_COLUMNS, [z.q]);
  console.error('bench-e2e: FAILED (out_of_memory): the fake ran out');
  process.exit(1);
}
const rows = [];
const qrows = [];
for (let run = 1; run <= 6; run++) {
  const base = Object.fromEntries(cols.E2E_EMULATED_COLUMNS.map((c) => [c, '']));
  rows.push({
    ...base, date, machine: label, chrome: 'Chrome/156.0.8078.80', commit: 'fakecommit001', run, restart: run === 6, first_token_ms: 9000, total_ms: 14000,
    requests_after_offline: 0, answer_ok: true, laptop_8gb: cols.LAPTOP_8GB, environment: label, process_commit_peak_bytes: 4000000000, sampler_median_interval_ms: 540,
  });
  qrows.push({ date, machine: label, commit: 'fakecommit001', run, restart: run === 6, qid: 'q1', answer_ok: true, correct_source_page: true, top_retrieved_page_ok: true, first_token_ms: 9000, total_ms: 14000, laptop_8gb: cols.LAPTOP_8GB, environment: label, failure_reason: '' });
}
write(process.env.DOCKIT_BENCH_CSV, cols.E2E_EMULATED_COLUMNS, rows);
write(process.env.DOCKIT_BENCH_Q_CSV, cols.Q_EMULATED_COLUMNS, qrows);
console.log('fake bench-e2e: wrote 6 rows');
`;

/** The driver: Get-CimInstance as a function (it shadows the cmdlet on every platform), then the stubbed script, then its exit code. */
const DRIVER = String.raw`
param([string]$Script, [string]$Cap, [string]$OutDir)
function Get-CimInstance {
  param([Parameter(Position = 0)][string]$ClassName, [string]$Filter)
  switch ($ClassName) {
    'Win32_ComputerSystem' { [pscustomobject]@{ NumberOfLogicalProcessors = 4; TotalPhysicalMemory = [uint64]17174360064 } }
    'Win32_OperatingSystem' { [pscustomobject]@{ Caption = 'Microsoft Windows Server 2025 Datacenter'; FreeVirtualMemory = [uint64]($env:STUB_FREE_VIRTUAL_KB) } }
    'Win32_Process' {
      if ($env:FAKE_CHROME -eq '1') { [pscustomobject]@{ ProcessId = 4242; CommandLine = 'chrome.exe --user-data-dir=/x/chrome-profile-abc' } }
    }
  }
}
& $Script -Cap $Cap -OutDir $OutDir
exit $LASTEXITCODE
`;

export interface StubOptions {
  cap: string;
  /** what the fake benchmark does: complete (six rows, exit 0), fail (a run-0 row with out_of_memory, exit 1) or crash (no CSV at all, exit 1) */
  bench?: 'complete' | 'fail' | 'crash';
  /** the stub's behaviour and the fake's numbers, as environment variables (STUB_ENFORCE, STUB_READBACK, STUB_BENCH_PEAK, ...) */
  env?: Record<string, string>;
}

export interface StubResult {
  status: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
  summary: Record<string, any> | null;
  csv: string | null;
  membership: Record<string, any>[];
}

/** Runs the stubbed script once, in a scratch folder, and collects everything it left behind. */
export function runCappedStub(opts: StubOptions): Promise<StubResult> {
  const dir = mkdtempSync(join(tmpdir(), 'dockit-capped-'));
  const work = join(dir, 'work');
  const outDir = join(dir, 'out');
  mkdirSync(join(work, 'scripts'), { recursive: true });
  writeFileSync(join(work, 'scripts', 'bench-e2e.mjs'), FAKE_BENCH);
  writeFileSync(
    join(dir, 'run-capped.stubbed.ps1'),
    stubbedScript(readFileSync(scriptPath, 'utf8')),
  );
  writeFileSync(join(dir, 'driver.ps1'), DRIVER);
  const env = {
    ...process.env,
    DOCKIT_STUB_ROOT: root,
    FAKE_BENCH: opts.bench ?? 'complete',
    STUB_MARKER: join(dir, 'bench-started.marker'),
    // 16 GB of free virtual memory, in KB: room for any probe
    STUB_FREE_VIRTUAL_KB: String(16 * 1024 * 1024),
    ...opts.env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(dir, 'driver.ps1'),
        join(dir, 'run-capped.stubbed.ps1'),
        opts.cap,
        outDir,
      ],
      { cwd: work, env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => {
      const read = (f: string) =>
        existsSync(join(outDir, f)) ? readFileSync(join(outDir, f), 'utf8') : null;
      const summary = read('job-summary.json');
      const membership = (read('job-membership.jsonl') ?? '')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, any>);
      resolve({
        status,
        stdout,
        stderr,
        outDir,
        summary: summary === null ? null : (JSON.parse(summary) as Record<string, any>),
        csv: read('e2e-emulated-win-vm.csv'),
        membership,
      });
    });
  });
}
