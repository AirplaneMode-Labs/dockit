# scripts/win: the Windows benchmark under an emulated memory cap

`run-capped.ps1` is what the manual `bench-windows` workflow (`.github/workflows/bench-windows.yml`) runs on each leg of its fixed matrix. It is the first
Windows run of `npm run bench:e2e`, and it measures an **emulated** environment: a GitHub-hosted Windows Server VM (4 vCPU and 16 GB RAM on a public
repository), not a laptop. Nothing it measures fills a `laptop_8gb` cell; every one of those still reads "not measured on 8 GB", and the Sprint 5 done-when
stays NOT met (owner runbook step 5).

**Status after the first successful run (bench-windows run 44656249868, 20 Nov 2026, dockit commit `5705baa`): the script works, and the memory limit is unproven.**
All four legs ran to the end and their rows are committed. The run shows that the Job Object holds the whole process tree, and it does not show that the limit
bound anything: see "What the first run does not show" below. **The change that settles it is written and has not run on Windows:** the script now reads the limit back
from the system, probes it from inside the job before the benchmark, logs the job's peak on every tick, counts the job's memory-limit messages on a completion port, and
there is a fifth leg, 2 GiB, a control that must fail to complete the benchmark. Every test of it runs on a Mac with kernel32 stubbed (`test/win-run-capped-stub.test.ts`), so
they prove what the script does with the kernel's answers, not what the kernel answers; the next dispatch is what measures that. Until it has run, the committed rows stay as
they are, labelled "limit unproven".

## What the Job Object holds

The script creates a Windows Job Object and puts **its own pwsh process** in it. Everything started from there inherits the job: node (the benchmark), the
Windows PowerShell sampler that node starts, and every Chrome process. So the limit covers the **pwsh, node and Chrome process tree**, not Chrome alone;
the few hundred MB the other three hold is inside the figure, and the label of every row says so. The job's limit is a limit on **committed** memory
(`JOB_OBJECT_LIMIT_JOB_MEMORY`), which is what Windows rations; it is not a limit on physical memory. With 16 GB of RAM behind it a capped job never pages: it
fits, or an allocation fails (a renderer out-of-memory, or a failed `WebAssembly.Memory.grow`), and the benchmark records the reason within seconds.

| Leg (`matrix.cap`) | Job commit limit    | Flags                                       |
| ------------------ | ------------------- | ------------------------------------------- |
| `none`             | none                | `0x2000` (kill on job close)                |
| `8GiB`             | 8,589,934,592 bytes | `0x2200` (job memory and kill on job close) |
| `6GiB`             | 6,442,450,944 bytes | `0x2200`                                    |
| `5GiB`             | 5,368,709,120 bytes | `0x2200`                                    |
| `2GiB` (control)   | 2,147,483,648 bytes | `0x2200`                                    |

No breakaway flag is ever set, so no child can leave the job on its own. Chrome's own sandbox puts its children in nested jobs; Windows 8 and later nest jobs and
charge the outer limit. `limitBytes` and `limitFlags` in `job-summary.json` are the script's own constants; since the change after the first run the summary also holds
`readBack`, which is asked of the system (`QueryInformationJobObject`, class 9) right after the call that set the limit and again after the process was put in the job, and a leg
whose read-back differs from what was set ends with exit code 6 before it starts the benchmark. The first run's summaries have no `readBack`: that is the gap described below.

## Files it writes (into `bench-out/`, uploaded with `if: always()` for seven days)

- `e2e-emulated-win-vm.csv` and `e2e-emulated-win-vm-questions.csv`: the rows, with an `environment` column and the emulated columns
  (`scripts/lib/bench-columns.mjs`). The job columns are filled in afterwards by `scripts/bench-emulated-merge.mjs` from `job-summary.json`.
- `bench.log`: the benchmark's console output.
- `job-summary.json` (version 2): the cap, the limit and flags that were set, `controlLeg`, `benchStarted`, `readBack` (after create, after assign, `equal`), `probe` (see
  below), `limitNotEnforced`, `completionPort` (the counts of the job's messages), `peakJobMemoryBytes` (`PeakJobMemoryUsed` at the end: the whole tree's peak commit),
  `peakJobSamples` (the first and last value the sampler saw, and the tick count), the number of Chrome processes seen outside the job, the benchmark's exit code, `timedOut`,
  `benchProgress` (rows written, runs completed, the failure reason, the last line of the log and of the error log) and, on the control leg, `control` (the outcome and the verdict).
  The script exits 124 when it had to stop the benchmark after `-TimeoutMinutes` (80, below the job's 90-minute limit; 12 on the control leg, below its 20; the children
  are stopped with it), 5 for an error it did not expect (written as `scriptError`), 6 for a read-back that differs from what was set, and on the control leg 0, 7 or 8 as the
  verdict (below); every one leaves the summary, the log and the membership file for the upload. It is also written before the benchmark starts (`phase` says which), so a leg
  the runner cancels still leaves the evidence. A summary with no `summaryVersion` is the first run's; the merge step reads both.
- `job-membership.jsonl`: one line every 2 seconds: how many `chrome.exe` carrying the benchmark profile were running, how many `IsProcessInJob` put in the job,
  which ones were outside it (escapes), the process ids the job lists, and since the change after the first run `peakJob` and `peakProc` (`PeakJobMemoryUsed` and
  `PeakProcessMemoryUsed` as the system reports them) and `jobMemoryLimitMessages` (the running count). The documented query has no field for the job's _current_ commit, only these two
  high-water marks, so the line carries them and the Chrome-only commit stays in the benchmark's own CSV.
- `env.txt` (written by the workflow before this script): the machine's own facts, never an environment variable.

## The first run: 20 Nov 2026

The first dispatch (run 44651054609) stopped on all four legs at the check of `dist-SHA256SUMS`, before this script was reached (fixed; see the CHANGELOG). The
second dispatch (run 44656249868, dockit `5705baa`, started 01:49 UTC) was green on all four legs. Its rows are in `docs/benchmarks/e2e-emulated-win-vm.csv` and
`e2e-emulated-win-vm-questions.csv` (24 and 168 rows, none left out), imported with the repository's own merge step and writers; the raw artefacts expire after seven
days. Every leg had its own runner VM. The machine facts, from each leg's `env.txt`:

| Leg  | CPU                   | Chrome        | Page file     | Whole-tree peak (`PeakJobMemoryUsed`) | Limit           |
| ---- | --------------------- | ------------- | ------------- | ------------------------------------- | --------------- |
| none | Intel Xeon 6973P-C    | 157.0.8103.79 | `C:` 2,944 MB | 6,181,113,856 B (5.76 GiB)            | none            |
| 8GiB | AMD EPYC 9V45 96-Core | 156.0.8078.80 | `C:` 2,944 MB | 6,071,017,472 B (5.65 GiB)            | 8,589,934,592 B |
| 6GiB | AMD EPYC 9V74 80-Core | 156.0.8078.80 | `C:` 2,944 MB | 6,073,286,656 B (5.66 GiB)            | 6,442,450,944 B |
| 5GiB | AMD EPYC 7763 64-Core | 156.0.8078.80 | `D:` 2,944 MB | 6,074,314,752 B (5.66 GiB)            | 5,368,709,120 B |

Every leg: Windows Server 2025 Datacenter 10.0.26100, 17,174,360,064 bytes of physical memory, 4 logical processors, Defender real-time protection off. The legs
differ in CPU model, in the Chrome build of the `none` leg and in where the page file sits, so **a difference in time between two legs is not an effect of the cap**:
median first token ran 7.1 s on the 9V45, 9.9 s on the 9V74 and 11.5 s on the 7763 (a spread of 1 to 3 percent between runs inside each of those three legs), and the `none` leg, which has no limit at all, took as long in total (23.9 s) as the 5GiB leg (23.9 s).

### What the first run shows

Per leg, 6 runs (five in one Chrome session and one after a Chrome restart), medians over all six rows as the importers compute them (a median of an even count is
rounded half up):

| Leg  | First token, ms | Total, ms | Tokens per second | Chrome-only commit peak (median / worst) | Whole-tree peak | Answers  |
| ---- | --------------- | --------- | ----------------- | ---------------------------------------- | --------------- | -------- |
| none | 9,835           | 23,862    | 3.25              | 4,688 MiB / 5,308 MiB                    | 5,895 MiB       | 24 of 36 |
| 8GiB | 7,111           | 14,865    | 6.75              | 4,757 MiB / 5,371 MiB                    | 5,790 MiB       | 24 of 36 |
| 6GiB | 9,856           | 19,071    | 6.00              | 3,864 MiB / 5,337 MiB                    | 5,792 MiB       | 24 of 36 |
| 5GiB | 11,511          | 23,888    | 4.70              | 3,834 MiB / 3,851 MiB                    | 5,793 MiB       | 24 of 36 |

- The script ran: the 144-byte structure was accepted by `SetInformationJobObject` (a refusal would have thrown before any benchmark started), `AssignProcessToJobObject`
  succeeded under the runner's own job (nesting is allowed, so no `assignError`), no leg timed out, and every leg exited 0.
- **The whole tree was in the job.** 1,748 membership samples over the four legs: every `chrome.exe` that carried the benchmark profile was in the job in every
  sample, `job_escapes` is 0, no process could not be asked, and the job listed 11 process ids at steady state (pwsh, node, the Windows PowerShell sampler and eight Chrome
  processes).
- Chrome started and ran inside the job on all four legs, launched the way the harness launches an emulated run (`chromiumSandbox: true`; the log does not print the launch flags, so the sandbox is the
  code's word, not the run's). No request left the page after the model was cached (`requests_after_offline` 0 on all 24 runs),
  no failure reason was recorded on any row, `bench.err.log` is empty, and the worker WebAssembly peak is the same 2,349,596,672 bytes on every row of every leg.
- The answers equal the Mac's question by question: the same 24 of 36 with the correct source page over all runs, the same two questions (q2 and q6) wrong in every run
  of every leg, the refusal question refused every time.
- `PeakJobMemoryUsed` tracks the commit of the tree. In the three legs where the Chrome-only sampler caught its highest runs, the whole-tree peak is the Chrome-only
  maximum plus 418, 455 and 587 MiB (8GiB, 6GiB, none), which is the size of pwsh, node and the PowerShell sampler together.
- The Windows sampler's median interval was 537 to 561 ms per run (it sleeps 500 ms and enumerates every process on each tick).

### What the first run does not show: that the limit bound anything

The 5GiB leg reports a whole-tree peak of **6,074,314,752 bytes, 705,605,632 bytes (673 MiB, 13.1 percent) above its own limit of 5,368,709,120 bytes**, and still exited 0 with
correct answers. Microsoft's documentation for the structure says what each field means; it does not explain this:

- `JobMemoryLimit` (with `JOB_OBJECT_LIMIT_JOB_MEMORY`): "the limit for the virtual memory that can be committed for the job". The flag's entry says that "when a process attempts
  to commit memory that would exceed the job-wide limit, it fails", and the structure's remarks say that "the set of processes associated with a job could never exceed" a job-wide
  limit. Under Nested Jobs, commit charge is one of the limits whose effective value is enforced down the job chain, and a nested job's accounting includes its child jobs.
- `PeakJobMemoryUsed`: "the peak memory usage of all processes currently associated with the job", tracked "constantly" by the system. The documentation does not say whether
  a commit that the limit refused is counted. (It is a high-water mark that survives the processes: the script reads it after node has exited.)

What the evidence settles, question by question:

- **Was the peak recorded before the limit was set?** No. `Create()` sets the limit with `SetInformationJobObject`, which succeeded, before `AssignProcessToJobObject` puts pwsh in the
  job and before node starts; every byte of Chrome's commit came after it. (The model download, before the first run, is inside the job too.)
- **Is there a read-back of the limit in the logs?** No. `job-summary.json` holds `limitBytes` and `limitFlags` as the script's own constants, and nothing queries the job for its limit.
  The struct was accepted and its `PeakJobMemoryUsed` field (offset 136) reads a sensible number, so the layout is right at least there; that is not a proof that the limit field was
  applied.
- **Is the peak a different quantity from the limit?** Probably the same quantity: where the sampler saw the highs, the whole-tree peak is the Chrome commit sum plus the pwsh and node share
  (above), so it is a commit figure, not a working-set one. Whether it also counts a refused commit is not documented.
- **Did a commit fail inside Chrome?** Nothing says so: no failure reason, no crash, an empty error log, the same WebAssembly peak and the same answers as the uncapped legs. A failed
  allocation that Chrome or V8 recovers from (a buffer allocation retried after a garbage collection, for example) would leave none of these traces.
- **Is the slower 5GiB leg the cap?** Not settled, but nothing in the times asks for the cap as an explanation. Every leg ran on a different processor model, the `none` leg on a Xeon and Chrome 157, and the
  `none` leg, with no limit at all, is as slow in total as the 5GiB leg (23.9 s each), so the times cannot be read as an effect of the cap.
- **One thing is different in the 5GiB leg.** The Chrome-only commit peak is flat at about 3.7 GiB (3.94 to 4.04 GB) in all six runs of that leg, while 8 of the 18 runs of the other three legs reach
  5.05 to 5.25 GiB (8GiB: runs 2, 5, 6; 6GiB: runs 4, 5; none: runs 1, 2, 6). If a spike of that size (about 1.5 GB over the usual peak, which would bring the whole tree to about the
  5.65 GiB the other legs report) could not fit under 5 GiB, a binding limit would remove it from every run of that leg and nowhere else, which is what the rows show. With the
  per-run rate of the other legs, six runs without one happen by chance about 3 times in 100; that is a post-hoc count over four legs on four different VMs, so it is a hint, not a result.
  The whole-tree peak of the 5GiB leg is within 3.3 MB (0.05 percent) of the 8GiB leg's and 1.0 MB of the 6GiB leg's, which is what the same allocations, attempted without a limit, would give.

So two explanations fit the numbers, and the run cannot choose between them:

1. **The limit was not in effect** (not applied, or not covering the allocations Chrome makes): the 5GiB leg is an uncapped run on a slower VM, the Chrome-only sampler happened not to
   see the high that the job saw (the model download before the first run is the one stretch it does not sample), and the flat 3.7 GiB is chance.
2. **The limit was in effect, and `PeakJobMemoryUsed` also counts a commit the limit then refused**: the extra 1.5 GB of commit that the other legs show was refused in the 5GiB leg, whatever asked for it recovered,
   and the high-water mark kept the attempt. That would be a result worth having (dockit completes with its largest commit refused), but nothing in this run proves it.

**What these runs are, plainly:** a correct end-to-end run of dockit on Windows Server 2025 in Chrome with the sandbox on, with the whole process tree inside a Job Object, whose measured
whole-tree commit peak (5.65 to 5.76 GiB; in the three legs where the sampler caught it, 5.2 to 5.25 GiB of that was Chrome's) is a real figure for this workload on a 16 GB VM. They are **not** evidence that dockit works under an 8, 6 or 5 GiB
cap, they are not an 8 GB laptop figure, and the labels of the capped rows describe the configuration the script asked for, not one the run demonstrated. The README and the site say the same next
to the figures, computed from the rows.

### The change that settles it (written and tested with kernel32 stubbed; not yet run on Windows)

The four additions proposed after the first run, and the optional fifth, are in `run-capped.ps1`, `scripts/bench-emulated-merge.mjs`, `scripts/bench-readme.mjs`, the workflow and the
site importer. In the order the script does them:

1. **Read the limit back.** After `Create()` and again after `AssignCurrentProcess`, `QueryInformationJobObject(job, 9)` is called and `LimitFlags` and `JobMemoryLimit` are compared with what
   was set (`0x2200` and the limit; `0x2000` and 0 on the leg with no limit, which is how "no limit is set" reads). Both read-backs are logged and written to `readBack` in the summary; a
   difference ends the leg with exit code 6 and `failReason: limit_readback_mismatch`, before any benchmark.
2. **Log `PeakJobMemoryUsed` on every 2-second tick** into `job-membership.jsonl` (with `PeakProcessMemoryUsed`, from the same query), and record the first and the last value and the final
   one in `peakJobSamples`. The documented query has no field for the job's current commit, so "current `JobMemoryUsed`" is not logged: there is none to read.
3. **Probe the limit inside the job before the benchmark** (capped legs only). The pwsh process, already in the job, commits 64 MiB with `VirtualAlloc(MEM_COMMIT | MEM_RESERVE)`, which must
   succeed, and then the limit plus 256 MiB, which must be refused; both are freed at once with `VirtualFree(MEM_RELEASE)` and nothing is touched. The summary says `probe.refused` (**true**
   only when the 64 MiB commit worked and the system's free virtual memory was at least the probe plus 1 GiB, so the refusal is the job's limit and not the probe call or a full system;
   **false** when the big commit succeeded; **null**, inconclusive, otherwise), the last error (1455 is `ERROR_COMMITMENT_LIMIT`), and `PeakJobMemoryUsed` before the probe, after the small commit and
   after the big one: **that is the answer to explanation 2**, because a refused commit that is counted in the peak shows as a peak of about the limit plus 256 MiB right after a probe that
   was refused, and one that is not counted shows as a peak that did not move. A commit that succeeds sets `limitNotEnforced`; the benchmark still runs, its figures are still a
   measurement, and the README and the site then say the cap was not in force. The probe's own commit is in the job's high-water mark for good, so when the benchmark never took
   `PeakJobMemoryUsed` above what the probe left (`probe.peakIncludesProbe`), the merge step writes the whole-tree peak as an empty cell (not measured) rather than a figure that is the probe's.
4. **A control leg that must fail.** `2GiB` (2,147,483,648 bytes; the lowest per-run Chrome-only commit peak of the first run was 3.94 GB, and the README block computes the
   comparison from the rows it is given). The leg is green only when the benchmark did **not** complete (a failure reason, a non-zero exit or the 12-minute stop) **and** the probe refused the
   commit and the read-back was equal: exit 0, `control.verdict: control_passed`. If the benchmark completes, exit 7 (`cap_does_nothing`): no capped leg means anything. If it stops but the probe
   did not prove the limit, exit 8 (`control_inconclusive`): the stop proves nothing about the cap. The leg's rows carry `control_leg` `true`, and the README and the site report
   them as a control, in a paragraph of their own, never in the table or in a median. A control that fails before the benchmark writes a row has no CSV; the merge step then prints one line
   and exits 0.
5. **A completion port on the job** (optional, kept because it is about 40 lines and every failure of it is recorded and ignored). It counts the job's messages over the whole run,
   `JOB_OBJECT_MSG_JOB_MEMORY_LIMIT` (10) among them, and the process id that came with the first one. A count above zero ties a refusal to the job's limit; zero with a peak above the limit
   would mean the limit was not enforced.

What the stub tests do and do not show. `test/win-run-capped-stub.test.ts` compiles the real C# class with every `kernel32` import replaced by a managed stand-in and runs the real script
against a fake benchmark: they show the read-back, the probe (including the three outcomes and the freed memory), the port, the peaks, the summary, the exit codes and the control verdict
behave as written, for a stand-in kernel that enforces the limit, one that does not and one that counts a refused commit in the peak. They do not show what the real kernel answers, whether
`VirtualAlloc` in pwsh is refused by the job on the runner, whether the flags read back as exactly `0x2200` when the job is nested under the runner's own job, or whether a completion
port changes anything. Those are the questions of the next dispatch, and each has a distinct, recorded outcome:

| What the next dispatch records                                                                                   | How to read it                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every capped leg: `readBack.equal` true and `probe.refused` true; the control leg exits 0 (`failed_as_expected`) | The limit is in force: a commit above it is refused and a benchmark far above it cannot complete. The capped legs are then results under their commit limits, and the README says "limit proven in force (probe refused, read-back equal)". |
| `probe.peakAfterBytes` above the limit on a refused probe                                                        | A refused commit is counted in `PeakJobMemoryUsed` (explanation 2): the first run's 5GiB peak above its limit is then an artefact of the counter, not memory the tree held.                                                                 |
| `probe.peakAfterBytes` equal to the peak after the small commit on a refused probe                               | A refused commit is not counted. A peak above the limit at the end of a leg would then be a puzzle again (a real commit above a limit that refuses them), and the leg's own figures say so.                                                 |
| `probe.refused` false, `limitNotEnforced` true                                                                   | Explanation 1: the limit is not in force on the runner (applied but not covering the allocation, or ignored). The benchmark still ran; the leg is the same run with no effective cap, and the control leg will not have failed either.      |
| Exit 6 on any leg                                                                                                | The system reports flags or a limit other than the ones set (the structure, a flag the kernel adds, or nesting under the runner's job). The summary has both sets of values.                                                                |
| Control exit 7                                                                                                   | The 2 GiB limit did nothing: the finding is about the script or the runner, not about dockit, and no capped leg of that run counts.                                                                                                         |
| Control exit 8                                                                                                   | The control stopped for a reason the limit is not shown to explain (the probe did not refuse the commit, or was inconclusive).                                                                                                              |
| `completionPort.jobMemoryLimitMessages` above 0                                                                  | The job posted the limit message: Chrome, V8 or the probe asked for a commit that took the job over its limit, with `firstJobMemoryLimitPid` naming the first process.                                                                      |

Until a dispatch with this change has run, the rows stay as committed, with the caveat the README and the site print beside them. The private-repository route (a 2 vCPU, 8 GB runner) is **not built**: it
costs minutes and the owner decides; it is recorded as an option in PLAN.md.

## What the first run answered, of the eight open questions

1. **The struct marshalling.** The 144-byte assertion held and `SetInformationJobObject` accepted the layout. Whether the limit is enforced: **still open** (above); the read-back and the probe are what answer it on the next dispatch.
2. **That Chrome's children stay inside the job.** Yes: `job_escapes` 0 in all four legs, in 1,748 samples, and the job's own process list held pwsh, node, the sampler and eight Chrome processes.
3. **How the runner nests its own job.** `AssignProcessToJobObject` succeeded on all four legs: the runner's step allows nesting, and no `assignError` was written.
4. **The sampler's real interval.** A median of 537 to 561 ms per run (`sampler_median_interval_ms`), against the 500 ms it sleeps.
5. **The commit figures.** The Chrome-only sum and `PeakJobMemoryUsed` agree to within the pwsh, node and sampler share (418 to 587 MiB) in the three legs where the sampler caught the highest runs; in the 5GiB leg
   they differ by 1,942 MiB, because the job saw a high that the sampler did not (see above).
6. **The cap at which an answer fails.** **Still open:** no leg failed, and no leg shows its limit taking effect. The 2 GiB control leg is the first test of a cap that must fail.
7. **Windows PowerShell 5.1 and encoding.** The sampler worked on all four legs (181 to 293 samples per run). The label is ASCII, so a non-ASCII command line was not exercised.
8. **Chrome with its sandbox on.** Chrome started and ran inside the job on all four legs with the harness's emulated-run launch (`chromiumSandbox: true`); the log does not print the flags.
