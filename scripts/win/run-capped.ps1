# run-capped.ps1: runs the dockit end-to-end benchmark with the pwsh, node and Chrome process tree inside a Windows Job Object (B6, TD-113).
#
#   & ./scripts/win/run-capped.ps1 -Cap <none|8GiB|6GiB|5GiB|2GiB> -OutDir bench-out [-TimeoutMinutes <n>]
#
# What it does, in this order:
#   1. refuses any Cap outside none, 8GiB, 6GiB, 5GiB and 2GiB (case-sensitive), before anything else runs. 2GiB is the CONTROL leg: its limit is far below what the benchmark
#      needs (the lowest Chrome-only commit peak of the first run was 3.94 GB), so a limit that is really in force must stop it, and the leg is green only when it does;
#   2. compiles one small C# class with Add-Type -TypeDefinition (documented kernel32 calls only, no new dependency) and asserts that the marshalled
#      JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes (x64) before it makes a single call;
#   3. creates a Job Object with KILL_ON_JOB_CLOSE (and, for a cap, JOB_MEMORY: a limit on the job-wide committed memory), attaches an I/O completion port to it (a failure
#      there is recorded and never stops the run), READS THE LIMIT BACK with QueryInformationJobObject (class 9) right after the call that set it and again after it puts THIS
#      pwsh process in the job, and ends with exit code 6 and the reason in the summary when LimitFlags or JobMemoryLimit differ from what it set; node, the Windows
#      sampler and every Chrome process started from here inherit the job (no breakaway flag is ever set);
#   4. on a capped leg, PROBES the limit from inside the job before the benchmark starts: it commits 64 MiB (must succeed) and then limit + 256 MiB (VirtualAlloc with
#      MEM_COMMIT | MEM_RESERVE, which must be refused), frees whatever it got, and records probeRefused, the last error and PeakJobMemoryUsed before and after, which says
#      whether a refused commit is counted in the peak. A commit that succeeds marks the leg limitNotEnforced: the benchmark still runs (its figures are still a measurement)
#      and the README and the site then say the cap was not in force;
#   5. starts node scripts/bench-e2e.mjs with an --environment label built from this machine's own WMI facts, and every 2 seconds checks each chrome.exe that carries the
#      benchmark profile folder with IsProcessInJob (job-membership.jsonl, counting any process outside the job as an escape), reads PeakJobMemoryUsed and drains the
#      completion port (JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages) into the same line;
#   6. writes job-summary.json (version 2: the cap, what was set, both read-backs, the probe, the completion-port counts, the first and last peak of the sampler, the
#      final PeakJobMemoryUsed, the escapes) and exits with the benchmark's exit code. Exit codes: 124 when the time limit stopped the benchmark, 2 for a cap or label that
#      is not allowed, 3 for a structure that is not 144 bytes, 4 when the job could not be made or this process put in it, 5 for an unexpected error of this script, 6 for
#      a read-back that differs from what was set. On the control leg the exit code is the verdict instead: 0 when the benchmark did NOT complete and the limit was proven
#      by the probe and the read-back (the control passed), 7 when the benchmark completed (the cap does nothing), 8 when it did not complete but the probe did not refuse
#      the commit (the failure proves nothing about the limit).
# It prints no environment variable and makes no network call. Its first run was the second dispatch of the bench-windows workflow (run 44656249868, 20 Nov 2026): the job
# held the whole process tree, but the limit was never read back and the 5GiB leg's own PeakJobMemoryUsed was above its limit, so the limit was unproven; the read-back, the
# probe, the completion port and the control leg above are the change that settles it, and scripts/win/README.md has the evidence. The job's handle is never closed
# here: KILL_ON_JOB_CLOSE would end this process with it. TimeoutMinutes (default 80; 12 on the control leg unless given) is below the workflow's job limit (90; 20 on the
# control leg), so a benchmark that hangs is stopped here, with its children, and still leaves job-summary.json and the log for the upload step, instead of being
# cancelled by the runner.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Cap,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Runs = 5,
  [int]$TimeoutMinutes = 80
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Cap -cnotin @('none', '8GiB', '6GiB', '5GiB', '2GiB')) {
  [Console]::Error.WriteLine('run-capped: Cap must be one of none, 8GiB, 6GiB, 5GiB, 2GiB')
  exit 2
}
$LimitBytes = @{ 'none' = $null; '8GiB' = [int64]8589934592; '6GiB' = [int64]6442450944; '5GiB' = [int64]5368709120; '2GiB' = [int64]2147483648 }[$Cap]
$IsControl = $Cap -ceq '2GiB'
$ControlTimeoutMinutes = 12
if ($IsControl -and -not $PSBoundParameters.ContainsKey('TimeoutMinutes')) { $TimeoutMinutes = $ControlTimeoutMinutes }
# what Create() sets: kill on close (0x2000), plus job memory (0x200) on a capped leg; the read-back must say exactly this
$ExpectedFlagsText = if ($null -eq $LimitBytes) { '0x2000' } else { '0x2200' }
$ExpectedLimit = if ($null -eq $LimitBytes) { [uint64]0 } else { [uint64]$LimitBytes }
# the probe: a small commit that must succeed (so a refusal is not the probe call failing for its own reasons), then the limit plus 256 MiB, which must be refused
$ProbeSmallBytes = [uint64]67108864
$ProbeOverBytes = [uint64]268435456

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

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT
    {
        public IntPtr CompletionKey;
        public IntPtr CompletionPort;
    }

    // what QueryInformationJobObject (class 9) says about the job: the flags and limits as they are, and the two high-water marks
    public sealed class JobReadback
    {
        public uint LimitFlags;
        public ulong JobMemoryLimit;
        public ulong ProcessMemoryLimit;
        public ulong PeakProcessMemoryUsed;
        public ulong PeakJobMemoryUsed;
    }

    // the outcome of one commit attempt: Committed (VirtualAlloc returned memory), Freed (it was released again; true when nothing was committed), Error (the Win32 error of a refusal)
    public sealed class CommitResult
    {
        public bool Committed;
        public bool Freed;
        public int Error;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualAlloc(IntPtr lpAddress, UIntPtr dwSize, uint flAllocationType, uint flProtect);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool VirtualFree(IntPtr lpAddress, UIntPtr dwSize, uint dwFreeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateIoCompletionPort(IntPtr FileHandle, IntPtr ExistingCompletionPort, UIntPtr CompletionKey, uint NumberOfConcurrentThreads);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetQueuedCompletionStatus(IntPtr CompletionPort, out uint lpNumberOfBytesTransferred, out UIntPtr lpCompletionKey, out IntPtr lpOverlapped, uint dwMilliseconds);

    // the messages a job posts to its completion port, counted over the whole run (JOB_OBJECT_MSG_*: NEW_PROCESS 6, EXIT_PROCESS 7, ABNORMAL_EXIT_PROCESS 8,
    // PROCESS_MEMORY_LIMIT 9, JOB_MEMORY_LIMIT 10); FirstJobMemoryLimitPid is the process id that came with the first JOB_MEMORY_LIMIT message
    public static long MsgNewProcess;
    public static long MsgExitProcess;
    public static long MsgAbnormalExit;
    public static long MsgProcessMemoryLimit;
    public static long MsgJobMemoryLimit;
    public static long MsgOther;
    public static long FirstJobMemoryLimitPid = -1;

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

    // JobObjectExtendedLimitInformation (class 9) read from the system, never from the constants this script set
    public static JobReadback ReadBack(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr p = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 9, p, (uint)size, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(p, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            JobReadback r = new JobReadback();
            r.LimitFlags = info.BasicLimitInformation.LimitFlags;
            r.JobMemoryLimit = (ulong)info.JobMemoryLimit;
            r.ProcessMemoryLimit = (ulong)info.ProcessMemoryLimit;
            r.PeakProcessMemoryUsed = (ulong)info.PeakProcessMemoryUsed;
            r.PeakJobMemoryUsed = (ulong)info.PeakJobMemoryUsed;
            return r;
        }
        finally
        {
            Marshal.FreeHGlobal(p);
        }
    }

    // commits bytes in this process (MEM_COMMIT | MEM_RESERVE = 0x3000, PAGE_READWRITE = 0x04; nothing is touched, so no physical memory is used) and releases them again
    // (MEM_RELEASE = 0x8000 with a size of 0). Inside a job with a job-wide commit limit, a commit that would take the job over the limit is refused.
    public static CommitResult TryCommit(ulong bytes)
    {
        CommitResult r = new CommitResult();
        IntPtr p = VirtualAlloc(IntPtr.Zero, new UIntPtr(bytes), 0x3000u, 0x04u);
        if (p == IntPtr.Zero)
        {
            r.Committed = false;
            r.Freed = true;
            r.Error = Marshal.GetLastWin32Error();
            return r;
        }
        r.Committed = true;
        r.Freed = VirtualFree(p, UIntPtr.Zero, 0x8000u);
        r.Error = 0;
        return r;
    }

    // a new completion port, associated with the job (JobObjectAssociateCompletionPortInformation = 7); the handle is kept open for the life of the run
    public static IntPtr AttachCompletionPort(IntPtr job)
    {
        IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1u);
        if (port == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateIoCompletionPort");
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT assoc = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT();
        assoc.CompletionKey = new IntPtr(0x444B);
        assoc.CompletionPort = port;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT));
        IntPtr p = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(assoc, p, false);
            if (!SetInformationJobObject(job, 7, p, (uint)size))
            {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(port);
                throw new Win32Exception(error, "SetInformationJobObject (completion port)");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(p);
        }
        return port;
    }

    // takes every message that is waiting (a zero timeout never blocks) and adds it to the counters above
    public static void Drain(IntPtr port)
    {
        for (int n = 0; n < 100000; n++)
        {
            uint message;
            UIntPtr key;
            IntPtr overlapped;
            if (!GetQueuedCompletionStatus(port, out message, out key, out overlapped, 0u)) return;
            if (message == 6u) MsgNewProcess++;
            else if (message == 7u) MsgExitProcess++;
            else if (message == 8u) MsgAbnormalExit++;
            else if (message == 9u) MsgProcessMemoryLimit++;
            else if (message == 10u)
            {
                if (MsgJobMemoryLimit == 0) FirstJobMemoryLimitPid = overlapped.ToInt64();
                MsgJobMemoryLimit++;
            }
            else MsgOther++;
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
$limitText = if ($null -eq $LimitBytes) { 'with no job limit' } else { ('under a job commit limit of ' + $LimitBytes + ' bytes') + $(if ($IsControl) { ' (control leg, expected to fail)' } else { '' }) }
$label = "emulated: GitHub-hosted $osName VM, $arch, $cpus vCPU, $ramGb GB RAM, pwsh, node and Chrome process tree $limitText; not a laptop"
if ($label -cnotmatch '^emulated: [A-Za-z0-9 ,.;:()/+-]{1,300}; not a laptop$') {
  [Console]::Error.WriteLine('run-capped: the environment label is not in the allowed form')
  exit 2
}
# the system's free virtual memory (physical and page file) just before the probe: a refusal only means the job limit when the system had room for the commit
$systemFreeVirtualBytes = [uint64]([uint64]$os.FreeVirtualMemory * 1024)

Add-Type -TypeDefinition $Source
if ([DockitJob]::StructSize() -ne 144) {
  [Console]::Error.WriteLine("run-capped: JOBOBJECT_EXTENDED_LIMIT_INFORMATION marshals to $([DockitJob]::StructSize()) bytes, not 144")
  exit 3
}

# every path below is absolute: .NET (File.Open, WriteAllText) resolves a relative one against the process working directory, PowerShell against its own location
$OutDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$summaryFile = Join-Path $OutDir 'job-summary.json'
$membershipFile = Join-Path $OutDir 'job-membership.jsonl'
$logFile = Join-Path $OutDir 'bench.log'
$errFile = Join-Path $OutDir 'bench.err.log'
$csvFile = Join-Path $OutDir 'e2e-emulated-win-vm.csv'
Set-Content -Path $membershipFile -Value '' -NoNewline
$utf8 = New-Object System.Text.UTF8Encoding $false

# state of the run: set before the first function or statement that can fail, so the catch below can always read it
$job = [IntPtr]::Zero
$port = [IntPtr]::Zero
$portError = $null
$facts = [ordered]@{}
$benchStarted = $false
$proc = $null
$escaped = New-Object 'System.Collections.Generic.HashSet[int]'
$samples = 0
$chromeSeenMax = 0
$unknownMax = 0
$peakFirst = $null
$peakLast = $null
$logPos = 0L
$exitCode = 1
$timedOut = $false

function Write-Summary($extra) {
  $summary = [ordered]@{
    summaryVersion = 2
    cap = $Cap
    limitBytes = $LimitBytes
    limitFlags = $ExpectedFlagsText
    structSize = 144
    label = $label
    controlLeg = $IsControl
    limitSet = ($null -ne $LimitBytes)
    benchStarted = $script:benchStarted
  }
  foreach ($k in $script:facts.Keys) { $summary[$k] = $script:facts[$k] }
  foreach ($k in $extra.Keys) { $summary[$k] = $extra[$k] }
  [System.IO.File]::WriteAllText($summaryFile, ($summary | ConvertTo-Json -Depth 6), $utf8)
}

# the job as the system reports it: flags and limits as they are, and the high-water marks. Never read from the constants above.
function Get-ReadBack {
  $r = [DockitJob]::ReadBack($job)
  [ordered]@{
    flags = ('0x{0:X4}' -f [uint32]$r.LimitFlags)
    jobMemoryLimit = [uint64]$r.JobMemoryLimit
    processMemoryLimit = [uint64]$r.ProcessMemoryLimit
    peakJobMemoryUsed = [uint64]$r.PeakJobMemoryUsed
    peakProcessMemoryUsed = [uint64]$r.PeakProcessMemoryUsed
  }
}

# equal to what Create() set: the same flags and the same JobMemoryLimit (0 on the leg with no limit, which is how 'no limit is set' reads)
function Test-ReadBackEqual($rb) {
  return (($rb['flags'] -ceq $ExpectedFlagsText) -and ([uint64]$rb['jobMemoryLimit'] -eq $ExpectedLimit))
}

function Get-CompletionPortCounts {
  [ordered]@{
    attached = ($script:port -ne [IntPtr]::Zero)
    error = $script:portError
    jobMemoryLimitMessages = if ($script:port -ne [IntPtr]::Zero) { [int64][DockitJob]::MsgJobMemoryLimit } else { $null }
    processMemoryLimitMessages = [int64][DockitJob]::MsgProcessMemoryLimit
    abnormalExitMessages = [int64][DockitJob]::MsgAbnormalExit
    newProcessMessages = [int64][DockitJob]::MsgNewProcess
    exitProcessMessages = [int64][DockitJob]::MsgExitProcess
    otherMessages = [int64][DockitJob]::MsgOther
    firstJobMemoryLimitPid = if ([DockitJob]::MsgJobMemoryLimit -gt 0) { [int64][DockitJob]::FirstJobMemoryLimitPid } else { $null }
  }
}

function Update-CompletionPort {
  if ($script:port -eq [IntPtr]::Zero) { return }
  try { [DockitJob]::Drain($script:port) } catch { $null = $_ }
}

# a read-back that differs from what was set ends the leg here, before any benchmark: the figures of a run under a limit nobody can vouch for are not worth the minutes
function Stop-ForReadBack($when, $rb) {
  $script:facts['failReason'] = 'limit_readback_mismatch'
  $script:facts['failDetail'] = "read-back ${when}: flags $($rb['flags']), JobMemoryLimit $($rb['jobMemoryLimit']); set: flags $ExpectedFlagsText, JobMemoryLimit $ExpectedLimit"
  Write-Summary @{ phase = 'readback-mismatch' }
  Write-Host "::error::run-capped: the limit read back $when differs from what was set ($($script:facts['failDetail']))"
  exit 6
}

$limitArg = if ($null -eq $LimitBytes) { [int64]-1 } else { $LimitBytes }
try {
  $job = [DockitJob]::Create($limitArg)
} catch {
  Write-Summary @{ createError = $_.Exception.Message }
  [Console]::Error.WriteLine("run-capped: the job could not be created: $($_.Exception.Message)")
  exit 4
}
# a completion port counts what the job reports (JOB_OBJECT_MSG_JOB_MEMORY_LIMIT among it); it is evidence only, so a failure to attach it is written down and the run goes on
try {
  $port = [DockitJob]::AttachCompletionPort($job)
} catch {
  $port = [IntPtr]::Zero
  $portError = $_.Exception.Message
}
Write-Host "run-capped: job created, cap $Cap$(if ($IsControl) { ' (control leg: the benchmark is expected NOT to complete)' } else { '' })"
Write-Host $(if ($port -ne [IntPtr]::Zero) { 'run-capped: completion port attached to the job' } else { "run-capped: no completion port: $portError" })

# the read-back: first right after the call that set the limit, then again once this process is in the job
$rb1 = Get-ReadBack
$facts['readBack'] = [ordered]@{
  expectedFlags = $ExpectedFlagsText
  expectedJobMemoryLimit = $ExpectedLimit
  afterCreate = $rb1
  afterAssign = $null
  equal = $null
  note = $(if ($null -eq $LimitBytes) { 'no limit is set on this leg: JobMemoryLimit reads 0 and only KILL_ON_JOB_CLOSE (0x2000) is on' } else { 'a job-wide commit limit is set on this leg' })
}
Write-Host "run-capped: read-back after create: LimitFlags $($rb1['flags']), JobMemoryLimit $($rb1['jobMemoryLimit']) (set: $ExpectedFlagsText, $ExpectedLimit)"
if (-not (Test-ReadBackEqual $rb1)) {
  $facts['readBack']['equal'] = $false
  Stop-ForReadBack 'after create' $rb1
}
try {
  [DockitJob]::AssignCurrentProcess($job)
} catch {
  # an enclosing job that does not allow nesting would end here: say so in the summary (the merge step then fails visibly) and stop
  Write-Summary @{ assignError = $_.Exception.Message }
  [Console]::Error.WriteLine("run-capped: this process could not be put in the job: $($_.Exception.Message)")
  exit 4
}
$rb2 = Get-ReadBack
$facts['readBack']['afterAssign'] = $rb2
$facts['readBack']['equal'] = (Test-ReadBackEqual $rb2)
Write-Host "run-capped: this process is in the job; read-back after assign: LimitFlags $($rb2['flags']), JobMemoryLimit $($rb2['jobMemoryLimit']), PeakJobMemoryUsed $($rb2['peakJobMemoryUsed'])"
if (-not $facts['readBack']['equal']) { Stop-ForReadBack 'after assign' $rb2 }
Write-Host "run-capped: $label"

# the probe, from inside the job and before node starts: a commit of limit + 256 MiB must be refused on a capped leg. 'refused' is true only when the 64 MiB commit
# succeeded and the system had the room (so a refusal is the job's limit and not the probe call or a full system), false when the big commit succeeded (the cap was not in
# force: the memory is freed again at once), and null when a refusal cannot be told from either of those.
$probe = [ordered]@{ ran = $false; reason = 'no limit is set on this leg, so there is nothing to probe' }
$limitNotEnforced = $false
if ($null -ne $LimitBytes) {
  $over = [uint64]$LimitBytes + $ProbeOverBytes
  $peakBefore = [uint64](Get-ReadBack)['peakJobMemoryUsed']
  $small = [DockitJob]::TryCommit($ProbeSmallBytes)
  $peakAfterSmall = [uint64](Get-ReadBack)['peakJobMemoryUsed']
  $big = [DockitJob]::TryCommit($over)
  $peakAfter = [uint64](Get-ReadBack)['peakJobMemoryUsed']
  Update-CompletionPort
  $smallOk = ($small.Committed -and $small.Freed)
  $roomOk = ($systemFreeVirtualBytes -ge ($over + [uint64]1073741824))
  $refused = if ($big.Committed) { $false } elseif ($smallOk -and $roomOk) { $true } else { $null }
  $limitNotEnforced = ($refused -eq $false)
  $errorName = switch ([int]$big.Error) { 0 { $null } 1455 { 'ERROR_COMMITMENT_LIMIT' } 8 { 'ERROR_NOT_ENOUGH_MEMORY' } default { 'other' } }
  $probe = [ordered]@{
    ran = $true
    bytes = $over
    overLimitBytes = $ProbeOverBytes
    smallBytes = $ProbeSmallBytes
    smallCommitOk = $smallOk
    systemFreeVirtualMemoryBytes = $systemFreeVirtualBytes
    systemRoomOk = $roomOk
    committed = [bool]$big.Committed
    refused = $refused
    lastError = [int]$big.Error
    lastErrorName = $errorName
    freed = [bool]($big.Freed -and $small.Freed)
    peakBeforeBytes = $peakBefore
    peakAfterSmallCommitBytes = $peakAfterSmall
    peakAfterBytes = $peakAfter
    peakIncludesProbe = $null
    jobMemoryLimitMessagesAfterProbe = $(if ($port -ne [IntPtr]::Zero) { [int64][DockitJob]::MsgJobMemoryLimit } else { $null })
  }
  Write-Host "run-capped: probe: committed $ProbeSmallBytes bytes ok=$smallOk; commit of limit + 256 MiB ($over bytes) refused=$refused (error $($big.Error)); PeakJobMemoryUsed before $peakBefore, after the small commit $peakAfterSmall, after the probe $peakAfter"
  if ($limitNotEnforced) { Write-Host "::warning::run-capped: the commit of limit + 256 MiB succeeded inside the job, so the cap was NOT in force on this leg; the benchmark still runs and its figures are marked accordingly" }
  elseif ($null -eq $refused) { Write-Host "::warning::run-capped: the probe was inconclusive (small commit ok=$smallOk, system room ok=$roomOk); the limit stays unproven on this leg" }
}
$facts['probe'] = $probe
$facts['limitNotEnforced'] = $limitNotEnforced
$facts['controlLegExpected'] = $IsControl
# written now so that a run the runner has to cancel still leaves the evidence
$facts['completionPort'] = Get-CompletionPortCounts
Write-Summary @{ phase = 'before-benchmark' }

function Show-NewLog {
  # prints what node has written to bench.log since the last call, so the Actions log shows the run as it happens. A read that fails (a sharing violation, a file not
  # there yet) is skipped: the file is complete either way and is uploaded, so it is never a reason to stop the benchmark
  try {
    if (-not (Test-Path -LiteralPath $logFile)) { return }
    $fs = [System.IO.File]::Open($logFile, 'Open', 'Read', 'ReadWrite')
    try {
      if ($fs.Length -gt $script:logPos) {
        $null = $fs.Seek($script:logPos, 'Begin')
        $buf = New-Object byte[] ([int]($fs.Length - $script:logPos))
        $n = $fs.Read($buf, 0, $buf.Length)
        $script:logPos += $n
        Write-Host ($utf8.GetString($buf, 0, $n)) -NoNewline
      }
    } finally { $fs.Dispose() }
  } catch {
    Write-Host "run-capped: bench.log could not be read just now: $($_.Exception.Message)"
  }
}

function Test-Membership {
  try { Test-MembershipOnce } catch {
    # a failed look is a gap in the record, not a reason to stop the benchmark. Writing the gap down can fail too (a job that is at its commit limit refuses this process an
    # allocation as well, which is what the control leg is for): that is not a reason to stop either
    try { Add-Content -Path $membershipFile -Value ([ordered]@{ t = (Get-Date).ToUniversalTime().ToString('o'); error = $_.Exception.Message } | ConvertTo-Json -Compress) } catch { $null = $_ }
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
  # the high-water marks of the job and the messages of the completion port, on every tick (the documented query has no field for the job's CURRENT commit, only these two peaks)
  $peakJob = $null
  $peakProc = $null
  $messages = $null
  try {
    $rb = Get-ReadBack
    $peakJob = $rb['peakJobMemoryUsed']
    $peakProc = $rb['peakProcessMemoryUsed']
    if ($null -eq $script:peakFirst) { $script:peakFirst = $peakJob }
    $script:peakLast = $peakJob
  } catch { $null = $_ }
  Update-CompletionPort
  if ($port -ne [IntPtr]::Zero) { $messages = [int64][DockitJob]::MsgJobMemoryLimit }
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
    peakJob = $peakJob
    peakProc = $peakProc
    jobMemoryLimitMessages = $messages
  }
  Add-Content -Path $membershipFile -Value ($line | ConvertTo-Json -Compress)
}

# how far the benchmark got, from the CSV it wrote and the last line of its log: a control leg's evidence, and a line in every summary
function Get-BenchProgress {
  $rows = @()
  try { if (Test-Path -LiteralPath $csvFile) { $rows = @(Import-Csv -LiteralPath $csvFile) } } catch { $rows = @() }
  $completed = 0
  $reason = $null
  foreach ($r in $rows) {
    $reasonCell = if ($r.PSObject.Properties['failure_reason']) { [string]$r.failure_reason } else { '' }
    $runCell = if ($r.PSObject.Properties['run']) { [string]$r.run } else { '' }
    if ($reasonCell -ne '' -and $null -eq $reason) { $reason = $reasonCell }
    if ($reasonCell -eq '' -and $runCell -match '^[1-9][0-9]*$') { $completed++ }
  }
  # the last line of the log and of the error log (where bench-e2e writes 'FAILED (<reason>): ...'), as plain ASCII and at most 200 characters
  $last = Get-LastLine $logFile
  $lastError = Get-LastLine $errFile
  [ordered]@{ rowsWritten = $rows.Count; completedRuns = $completed; failureReason = $reason; lastLogLine = $last; lastErrorLine = $lastError }
}

function Get-LastLine($file) {
  try {
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    $tail = @(Get-Content -LiteralPath $file -Tail 20 | Where-Object { $_ -and $_.Trim() -ne '' })
    if ($tail.Count -eq 0) { return '' }
    $line = ([string]$tail[$tail.Count - 1] -replace '[^\x20-\x7e]', '?').Trim()
    if ($line.Length -gt 200) { $line = $line.Substring(0, 200) }
    return $line
  } catch { return '' }
}

# the verdict of the control leg: green only when the benchmark did NOT complete and the limit was shown to be in force (probe refused, read-back equal: a failure with no
# such proof could be anything); red when it completed (the cap does nothing) or when it stopped for a reason the limit is not shown to explain
function Get-ControlVerdict($benchCompleted, $timedOutNow, $probeRefused) {
  if ($benchCompleted) { return [ordered]@{ outcome = 'completed_unexpectedly'; verdict = 'cap_does_nothing'; exit = 7 } }
  if ($probeRefused -eq $true) {
    return [ordered]@{ outcome = $(if ($timedOutNow) { 'timed_out' } else { 'failed_as_expected' }); verdict = 'control_passed'; exit = 0 }
  }
  return [ordered]@{ outcome = 'inconclusive'; verdict = 'control_inconclusive'; exit = 8 }
}

# the benchmark: node and everything it starts inherit the job. Anything this script does not expect ends in the catch below, which says so in the summary and the
# log (a bare terminating error would leave neither) and stops node and its children.
try {
  $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
  $env:DOCKIT_BENCH_CSV = $csvFile
  $env:DOCKIT_BENCH_Q_CSV = Join-Path $OutDir 'e2e-emulated-win-vm-questions.csv'
  $benchArgs = @('scripts/bench-e2e.mjs', '--environment', ('"' + $label + '"'), '--dist', 'dist', '--runs', "$Runs")
  $proc = Start-Process -FilePath $node -ArgumentList $benchArgs -WorkingDirectory (Get-Location).Path -NoNewWindow -PassThru -RedirectStandardOutput $logFile -RedirectStandardError $errFile
  $null = $proc.Handle
  $benchStarted = $true
  # a summary that says the benchmark started, for a leg the runner has to cancel
  Write-Summary @{ phase = 'benchmark-running' }
  Write-Host "run-capped: started $node as process $($proc.Id); it is stopped after $TimeoutMinutes minutes if it has not finished"

  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not $proc.HasExited) {
    Test-Membership
    Show-NewLog
    if ($clock.Elapsed.TotalMinutes -ge $TimeoutMinutes) {
      $timedOut = $true
      Write-Host "::error::run-capped: the benchmark had not finished after $TimeoutMinutes minutes; stopping it and its children"
      try { $proc.Kill($true) } catch { Write-Host "run-capped: it could not be stopped: $($_.Exception.Message)" }
      break
    }
    Start-Sleep -Seconds 2
  }
  $null = $proc.WaitForExit(120000)
  Test-Membership
  Show-NewLog
  if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile | ForEach-Object { Write-Host $_ } }

  $final = Get-ReadBack
  $peak = [uint64]$final['peakJobMemoryUsed']
  # a missing exit code (the known Start-Process -PassThru pitfall) is a failure, never a pass; the time limit has a code of its own
  $benchExit = if ($timedOut) { 124 } elseif ($null -eq $proc.ExitCode) { 1 } else { [int]$proc.ExitCode }
  $exitCode = $benchExit
  # the high-water mark is the probe's, not the benchmark's, when the benchmark never took it higher than the probe had: then the whole-tree figure is not the run's
  if ($probe['ran']) { $probe['peakIncludesProbe'] = ($peak -le [uint64]$probe['peakAfterBytes']) }
  $progress = Get-BenchProgress
  $extra = [ordered]@{
    phase = 'finished'
    peakJobMemoryBytes = [int64]$peak
    peakProcessMemoryBytes = [int64]$final['peakProcessMemoryUsed']
    peakJobSamples = [ordered]@{ firstSample = $peakFirst; lastSample = $peakLast; ticks = $samples; final = $peak }
    readBackAtEnd = $final
    escapes = $escaped.Count
    escapedPids = @($escaped)
    membershipSamples = $samples
    chromeProcessesSeenMax = $chromeSeenMax
    unknownMembershipMax = $unknownMax
    benchExitCode = $benchExit
    timedOut = $timedOut
    benchProgress = $progress
  }
  $facts['completionPort'] = Get-CompletionPortCounts
  if ($IsControl) {
    $benchCompleted = (-not $timedOut) -and ($benchExit -eq 0)
    $refusedNow = $probe['refused']
    $v = Get-ControlVerdict $benchCompleted $timedOut $refusedNow
    $exitCode = [int]$v['exit']
    $extra['control'] = [ordered]@{
      expected = 'the benchmark must not complete under this limit'
      benchCompleted = $benchCompleted
      outcome = $v['outcome']
      verdict = $v['verdict']
      failureReason = $progress['failureReason']
      completedRuns = $progress['completedRuns']
      rowsWritten = $progress['rowsWritten']
      lastLogLine = $progress['lastLogLine']
      lastErrorLine = $progress['lastErrorLine']
      legExitCode = $exitCode
    }
  }
  $extra['legExitCode'] = $exitCode
  Write-Summary $extra
  Write-Host "run-capped: peak job commit $peak bytes (first sample $peakFirst, last $peakLast), Chrome processes outside the job: $($escaped.Count), job memory limit messages: $([DockitJob]::MsgJobMemoryLimit), benchmark exit code $benchExit"
  if ($escaped.Count -gt 0) { Write-Host "::warning::run-capped: $($escaped.Count) Chrome process(es) were seen outside the job; the whole-tree figure under-counts" }
  if ($IsControl) {
    Write-Host "run-capped: control leg: $($extra['control']['verdict']) ($($extra['control']['outcome'])): $($progress['completedRuns']) completed run(s), failure reason '$($progress['failureReason'])', exit $exitCode"
    if ($exitCode -eq 7) { Write-Host "::error::run-capped: the benchmark completed under the control limit of $LimitBytes bytes: the cap does nothing, so no capped leg of this run means anything" }
    if ($exitCode -eq 8) { Write-Host "::error::run-capped: the control leg stopped, but the probe did not prove the limit in force, so the stop proves nothing about the cap" }
  }
} catch {
  $message = $_.Exception.Message
  [Console]::Error.WriteLine("run-capped: unexpected error: $message")
  try { if ($null -ne $proc -and -not $proc.HasExited) { $proc.Kill($true) } } catch { $null = $_ }
  $exitCode = 5
  # best effort: the figures the merge step needs, so that a script error does not also fail it
  $fallback = [ordered]@{ scriptError = $message; benchExitCode = $exitCode; legExitCode = $exitCode; phase = 'script-error' }
  try { $fallback['peakJobMemoryBytes'] = [int64](Get-ReadBack)['peakJobMemoryUsed'] } catch { $fallback['peakJobMemoryBytes'] = 0 }
  $fallback['escapes'] = $escaped.Count
  if ($probe['ran'] -and $null -eq $probe['peakIncludesProbe']) { $probe['peakIncludesProbe'] = $false }
  try { Write-Summary $fallback } catch { $null = $_ }
}
exit $exitCode
