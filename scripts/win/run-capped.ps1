# run-capped.ps1: runs the dockit end-to-end benchmark with the pwsh, node and Chrome process tree inside a Windows Job Object (B6, TD-113).
#
#   & ./scripts/win/run-capped.ps1 -Cap <none|8GiB|6GiB|5GiB> -OutDir bench-out
#
# What it does, in this order:
#   1. refuses any Cap outside none, 8GiB, 6GiB and 5GiB (case-sensitive), before anything else runs;
#   2. compiles one small C# class with Add-Type -TypeDefinition (documented kernel32 calls only, no new dependency) and asserts that the marshalled
#      JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes (x64) before it makes a single call;
#   3. creates a Job Object with KILL_ON_JOB_CLOSE (and, for a cap, JOB_MEMORY: a limit on the job-wide committed memory), puts THIS pwsh process in it, so
#      node, the Windows sampler and every Chrome process started from here inherit it (no breakaway flag is ever set);
#   4. starts node scripts/bench-e2e.mjs with an --environment label built from this machine's own WMI facts, and every 2 seconds checks each chrome.exe
#      that carries the benchmark profile folder with IsProcessInJob, writing job-membership.jsonl and counting any process outside the job as an escape;
#   5. writes job-summary.json (cap, limit, PeakJobMemoryUsed, escapes) and exits with the benchmark's exit code.
# It prints no environment variable and makes no network call. It has never run: the first run is the bench-windows workflow, and
# scripts/win/README.md lists what only that run can prove. The job's handle is never closed here: KILL_ON_JOB_CLOSE would end this process with it.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Cap,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Runs = 5
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Cap -cnotin @('none', '8GiB', '6GiB', '5GiB')) {
  [Console]::Error.WriteLine('run-capped: Cap must be one of none, 8GiB, 6GiB, 5GiB')
  exit 2
}
$LimitBytes = @{ 'none' = $null; '8GiB' = [int64]8589934592; '6GiB' = [int64]6442450944; '5GiB' = [int64]5368709120 }[$Cap]

$Source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DockitJob
{
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength, IntPtr lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr ProcessHandle, IntPtr JobHandle, out bool Result);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    // the size of the structure as the runtime lays it out: 144 bytes on x64 (BASIC 64 + IO_COUNTERS 48 + four SIZE_T 32)
    public static int StructSize()
    {
        return Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    }

    // limitBytes below zero: no commit limit, only KILL_ON_JOB_CLOSE (0x2000); otherwise JOB_MEMORY and KILL_ON_JOB_CLOSE (0x2200)
    public static IntPtr Create(long limitBytes)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = limitBytes >= 0 ? 0x2200u : 0x2000u;
        if (limitBytes >= 0) info.JobMemoryLimit = new UIntPtr((ulong)limitBytes);
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr p = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, p, false);
            if (!SetInformationJobObject(job, 9, p, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject");
        }
        finally
        {
            Marshal.FreeHGlobal(p);
        }
        return job;
    }

    public static void AssignCurrentProcess(IntPtr job)
    {
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject");
    }

    public static ulong PeakJobMemory(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr p = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 9, p, (uint)size, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(p, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            return (ulong)info.PeakJobMemoryUsed;
        }
        finally
        {
            Marshal.FreeHGlobal(p);
        }
    }

    // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORDs (assigned, listed) and then the process ids as pointer-sized values
    public static uint[] ProcessIds(IntPtr job)
    {
        int capacity = 4096;
        int size = 8 + capacity * IntPtr.Size;
        IntPtr p = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 3, p, (uint)size, IntPtr.Zero)) return new uint[0];
            int listed = Marshal.ReadInt32(p, 4);
            uint[] ids = new uint[listed];
            for (int i = 0; i < listed; i++) ids[i] = (uint)Marshal.ReadIntPtr(p, 8 + i * IntPtr.Size).ToInt64();
            return ids;
        }
        finally
        {
            Marshal.FreeHGlobal(p);
        }
    }

    // 1: in the job (or in a job nested under it); 0: outside it; -1: the process could not be opened or asked
    public static int Membership(IntPtr job, uint pid)
    {
        // PROCESS_QUERY_LIMITED_INFORMATION (0x1000): the least privilege IsProcessInJob accepts; sandboxed Chrome children may deny 0x0400 (BUG-T3-S7-10)
        IntPtr h = OpenProcess(0x1000u, false, pid);
        if (h == IntPtr.Zero) return -1;
        try
        {
            bool inJob;
            if (!IsProcessInJob(h, job, out inJob)) return -1;
            return inJob ? 1 : 0;
        }
        finally
        {
            CloseHandle(h);
        }
    }
}
'@

# the label is built from this machine's own facts, never typed (the limit is written in bytes: a figure like '8 GiB' would trip the 8 GB screen, BUG-T1-S7-05): 'emulated: <what was run>; not a laptop'
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$osName = ($os.Caption -replace '^Microsoft ', '' -replace '[^A-Za-z0-9 ]', ' ' -replace '\s+', ' ').Trim()
$cpus = [int]$cs.NumberOfLogicalProcessors
$ramGb = [int][math]::Round($cs.TotalPhysicalMemory / 1GB)
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLower()
$limitText = if ($null -eq $LimitBytes) { 'with no job limit' } else { ('under a job commit limit of ' + $LimitBytes + ' bytes') }
$label = "emulated: GitHub-hosted $osName VM, $arch, $cpus vCPU, $ramGb GB RAM, pwsh, node and Chrome process tree $limitText; not a laptop"
if ($label -cnotmatch '^emulated: [A-Za-z0-9 ,.;:()/+-]{1,300}; not a laptop$') {
  [Console]::Error.WriteLine('run-capped: the environment label is not in the allowed form')
  exit 2
}

Add-Type -TypeDefinition $Source
if ([DockitJob]::StructSize() -ne 144) {
  [Console]::Error.WriteLine("run-capped: JOBOBJECT_EXTENDED_LIMIT_INFORMATION marshals to $([DockitJob]::StructSize()) bytes, not 144")
  exit 3
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$summaryFile = Join-Path $OutDir 'job-summary.json'
$membershipFile = Join-Path $OutDir 'job-membership.jsonl'
$logFile = Join-Path $OutDir 'bench.log'
$errFile = Join-Path $OutDir 'bench.err.log'
Set-Content -Path $membershipFile -Value '' -NoNewline
$utf8 = New-Object System.Text.UTF8Encoding $false

function Write-Summary($extra) {
  $summary = [ordered]@{
    cap = $Cap
    limitBytes = $LimitBytes
    limitFlags = if ($null -eq $LimitBytes) { '0x2000' } else { '0x2200' }
    structSize = 144
    label = $label
  }
  foreach ($k in $extra.Keys) { $summary[$k] = $extra[$k] }
  [System.IO.File]::WriteAllText($summaryFile, ($summary | ConvertTo-Json -Depth 4), $utf8)
}

$limitArg = if ($null -eq $LimitBytes) { [int64]-1 } else { $LimitBytes }
$job = [DockitJob]::Create($limitArg)
try {
  [DockitJob]::AssignCurrentProcess($job)
} catch {
  # an enclosing job that does not allow nesting would end here: say so in the summary (the merge step then fails visibly) and stop
  Write-Summary @{ assignError = $_.Exception.Message }
  [Console]::Error.WriteLine("run-capped: this process could not be put in the job: $($_.Exception.Message)")
  exit 4
}
Write-Host "run-capped: job created, cap $Cap, this process is in it"
Write-Host "run-capped: $label"

# the benchmark: node and everything it starts inherit the job
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$env:DOCKIT_BENCH_CSV = Join-Path $OutDir 'e2e-emulated-win-vm.csv'
$env:DOCKIT_BENCH_Q_CSV = Join-Path $OutDir 'e2e-emulated-win-vm-questions.csv'
$benchArgs = @('scripts/bench-e2e.mjs', '--environment', ('"' + $label + '"'), '--dist', 'dist', '--runs', "$Runs")
$proc = Start-Process -FilePath $node -ArgumentList $benchArgs -WorkingDirectory (Get-Location).Path -NoNewWindow -PassThru -RedirectStandardOutput $logFile -RedirectStandardError $errFile
$null = $proc.Handle

$escaped = New-Object 'System.Collections.Generic.HashSet[int]'
$samples = 0
$chromeSeenMax = 0
$unknownMax = 0
$logPos = 0L

function Show-NewLog {
  # prints what node has written to bench.log since the last call, so the Actions log shows the run as it happens
  if (-not (Test-Path $logFile)) { return }
  $fs = [System.IO.File]::Open($logFile, 'Open', 'Read', 'ReadWrite')
  try {
    if ($fs.Length -gt $script:logPos) {
      $null = $fs.Seek($script:logPos, 'Begin')
      $buf = New-Object byte[] ($fs.Length - $script:logPos)
      $n = $fs.Read($buf, 0, $buf.Length)
      $script:logPos += $n
      Write-Host ($utf8.GetString($buf, 0, $n)) -NoNewline
    }
  } finally { $fs.Dispose() }
}

function Test-Membership {
  try { Test-MembershipOnce } catch {
    # a failed look is a gap in the record, not a reason to stop the benchmark
    Add-Content -Path $membershipFile -Value ([ordered]@{ t = (Get-Date).ToUniversalTime().ToString('o'); error = $_.Exception.Message } | ConvertTo-Json -Compress)
  }
}

function Test-MembershipOnce {
  $chrome = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('chrome-profile-') })
  $in = 0
  $unknown = 0
  $out = @()
  foreach ($c in $chrome) {
    switch ([DockitJob]::Membership($job, [uint32]$c.ProcessId)) {
      1 { $in++ }
      0 { $out += [int]$c.ProcessId; $null = $escaped.Add([int]$c.ProcessId) }
      default { $unknown++ }
    }
  }
  $script:samples++
  if ($chrome.Count -gt $script:chromeSeenMax) { $script:chromeSeenMax = $chrome.Count }
  if ($unknown -gt $script:unknownMax) { $script:unknownMax = $unknown }
  $line = [ordered]@{
    t = (Get-Date).ToUniversalTime().ToString('o')
    chrome = $chrome.Count
    inJob = $in
    escaped = @($out)
    unknown = $unknown
    jobPids = @([DockitJob]::ProcessIds($job))
  }
  Add-Content -Path $membershipFile -Value ($line | ConvertTo-Json -Compress)
}

while (-not $proc.HasExited) {
  Test-Membership
  Show-NewLog
  Start-Sleep -Seconds 2
}
$proc.WaitForExit()
Test-Membership
Show-NewLog
if (Test-Path $errFile) { Get-Content -Path $errFile | ForEach-Object { Write-Host $_ } }

$peak = [DockitJob]::PeakJobMemory($job)
# a missing exit code (the known Start-Process -PassThru pitfall) is a failure, never a pass
$exitCode = if ($null -eq $proc.ExitCode) { 1 } else { [int]$proc.ExitCode }
Write-Summary @{
  peakJobMemoryBytes = [int64]$peak
  escapes = $escaped.Count
  escapedPids = @($escaped)
  membershipSamples = $samples
  chromeProcessesSeenMax = $chromeSeenMax
  unknownMembershipMax = $unknownMax
  benchExitCode = $exitCode
}
Write-Host "run-capped: peak job commit $peak bytes, Chrome processes outside the job: $($escaped.Count), benchmark exit code $exitCode"
if ($escaped.Count -gt 0) { Write-Host "::warning::run-capped: $($escaped.Count) Chrome process(es) were seen outside the job; the whole-tree figure under-counts" }
exit $exitCode
