# scripts/win: the Windows benchmark under an emulated memory cap

`run-capped.ps1` is what the manual `bench-windows` workflow (`.github/workflows/bench-windows.yml`) runs on each leg of its fixed matrix. It is the Windows run of `npm run bench:e2e`, and it measures an **emulated** environment: a GitHub-hosted Windows Server VM (4 vCPU and 16 GB RAM on a public
repository), not a laptop. Nothing it measures fills a `laptop_8gb` cell; every one of those still reads "not measured on 8 GB", and the Sprint 5 done-when
stays NOT met (owner runbook step 5).

**Status after the third dispatch (bench-windows run 44666921454, 20 Nov 2026, dockit commit `f6a71ca`): the script works, the memory limit is proven in force on every capped leg, and the anomaly the second dispatch left is settled.**
The Job Object holds the whole process tree; the system reports the limit that was set; a commit of the limit plus 256 MiB made from inside the job is refused; the job's `PeakJobMemoryUsed` counts such a refused commit, which is why a
peak can sit above a limit that held (the second dispatch's 5 GiB leg is that case); on the 5 GiB leg commits were refused while the benchmark ran and it still finished all six runs with the same answers; and the 2 GiB control, whose limit is
below what the benchmark needs, did not complete, as it must. It is still **one run on a 16 GB VM with a limit on committed memory only**: it does not limit physical RAM, and it does not model an 8 GB machine's operating system and other apps,
an integrated GPU, thermal limits or its disk, so it is not an 8 GB result. The evidence is under "What the evidence run shows" below, what it leaves open under "What it does not show", and the history of the three dispatches (with the second one's
conclusion, written before the evidence existed) is kept under "The three dispatches". The second dispatch's rows are unchanged in `docs/benchmarks/history/`.

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
whose read-back differs from what was set ends with exit code 6 before it starts the benchmark. The second dispatch's summaries (written before the evidence existed) have no `readBack`: that is the gap described below; every summary of the third dispatch has it.

## Files it writes (into `bench-out/`, uploaded with `if: always()` for seven days)

- `e2e-emulated-win-vm.csv` and `e2e-emulated-win-vm-questions.csv`: the rows, with an `environment` column and the emulated columns
  (`scripts/lib/bench-columns.mjs`). The job columns and the evidence columns are filled in afterwards by `scripts/bench-emulated-merge.mjs` from `job-summary.json`, among them `probe_memory_limit_messages` (the completion port's count when the probe ended, so that the messages posted while the benchmark ran can be told from the probe's own). A control leg that wrote no row (it was stopped by its time limit before its first run finished) gets one marker row from the same step: run 0, every figure empty, no failure reason.
- `bench.log`: the benchmark's console output.
- `job-summary.json` (version 2): the cap, the limit and flags that were set, `controlLeg`, `benchStarted`, `readBack` (after create, after assign, `equal`), `probe` (see
  below), `limitNotEnforced`, `completionPort` (the counts of the job's messages), `peakJobMemoryBytes` (`PeakJobMemoryUsed` at the end: the whole tree's peak commit),
  `peakJobSamples` (the first and last value the sampler saw, and the tick count), the number of Chrome processes seen outside the job, the benchmark's exit code, `timedOut`,
  `benchProgress` (rows written, runs completed, the failure reason, the last line of the log and of the error log) and, on the control leg, `control` (the outcome and the verdict).
  The script exits 124 when it had to stop the benchmark after `-TimeoutMinutes` (80, below the job's 90-minute limit; 12 on the control leg, below its 20; the children
  are stopped with it), 5 for an error it did not expect (written as `scriptError`), 6 for a read-back that differs from what was set, and on the control leg 0, 7 or 8 as the
  verdict (below); every one leaves the summary, the log and the membership file for the upload. It is also written before the benchmark starts (`phase` says which), so a leg
  the runner cancels still leaves the evidence. A summary with no `summaryVersion` is the second dispatch's; the merge step reads both.
- `job-membership.jsonl`: one line every 2 seconds: how many `chrome.exe` carrying the benchmark profile were running, how many `IsProcessInJob` put in the job,
  which ones were outside it (escapes), the process ids the job lists, and since the change after the first run `peakJob` and `peakProc` (`PeakJobMemoryUsed` and
  `PeakProcessMemoryUsed` as the system reports them) and `jobMemoryLimitMessages` (the running count). The documented query has no field for the job's _current_ commit, only these two
  high-water marks, so the line carries them and the Chrome-only commit stays in the benchmark's own CSV.
- `env.txt` (written by the workflow before this script): the machine's own facts, never an environment variable.

## The three dispatches

| Run         | dockit commit | What happened                                                                                                                                                                                                                                              | Where its rows are                                                                                                                                                                       |
| ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 44651054609 | `f886506`     | Stopped on all four legs at the check of `dist-SHA256SUMS`, before this script was reached (fixed; see the CHANGELOG). No benchmark ran.                                                                                                                   | none                                                                                                                                                                                     |
| 44656249868 | `5705baa`     | Green on all four legs (none, 8, 6 and 5 GiB). It showed that the Job Object holds the tree and that dockit finishes with the Mac's answers. It could not show that the limit bound anything, and its 5 GiB leg's whole-tree peak was above its own limit. | `docs/benchmarks/history/e2e-emulated-win-vm-run-44656249868.csv` and `...-questions.csv` (24 and 168 rows), unchanged since they were first committed; in no README or site figure.     |
| 44666921454 | `f6a71ca`     | Green on all five legs (the 2 GiB control is green because the benchmark did not complete). The first dispatch with the limit read back, probed and counted on a completion port.                                                                          | `docs/benchmarks/e2e-emulated-win-vm.csv` and `...-questions.csv` (25 and 168 rows); every leg's `job-summary.json` and `env.txt` in `docs/benchmarks/emulated-win-vm-run-44666921454/`. |

**Why the third run replaces the second in the live files and is not appended to them.** The two runs measure the same configuration with the same benchmark code (`bench-e2e.mjs` differs only by six empty evidence columns, which the merge step fills); the third has the instrument the
second lacked. The second run's capped rows are, by their own evidence, "not a result under a cap", and next to the third run's rows in one table they would invite exactly the reading they cannot support. The readers group rows by the `environment`
label, which is built from the machine's own facts and is therefore identical in both runs, so appending would pool twelve rows into each leg's median, across two VMs per leg and two versions of the script, unless the CSV gained a run key and both
readers (this repository's README block and the site importer) learned to split on it, all for rows that cannot be used as results. Nothing is lost: the second run's rows are kept byte for byte under `docs/benchmarks/history/` (a test pins their
count, header, commit and peaks), this file records what it showed and what it left open, and git history has the commit that first imported them.

**How the third run was imported.** Each benchmark leg's CSV (written by `f6a71ca` with the 46-column header) went through the repository's own `merge()`, which fills `probe_memory_limit_messages`, upgrades the header, and was a no-op on every other cell (they already
equalled the workflow's own merge), and then through the CSV writer, which refuses a row without `not measured on 8 GB` or with a label that reads as a laptop; the legs are in matrix order (none, 8, 6, 5 GiB). The control leg wrote no CSV, so its single marker row
(run 0, every figure empty, no failure reason; the label of its own summary; the commit `f6a71cab4ab1` from the artefact name; no date) comes from `controlMarkerCsv()`. The artefacts expire after seven days; what the repository keeps is the CSVs, every leg's
`job-summary.json` (byte for byte, with LF line endings) and `env.txt`. `test/bench-emulated-run2.test.ts` re-derives every evidence cell of every row from those committed summaries.

## The first complete run (run 44656249868): the limit unproven

Kept as it was written after that run, with its conclusion. Its rows are unchanged in `docs/benchmarks/history/`; the third dispatch settled the question it ends on (the next sections). "The first run" below means this one.

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

### What it showed

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

### What it did not show: that the limit bound anything

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

**Settled by the third dispatch:** explanation 2. See "What the evidence run shows" below.

## The change that settled it (written and tested with kernel32 stubbed, then run on Windows in run 44666921454)

The four additions proposed after the first complete run, and the optional fifth, are in `run-capped.ps1`, `scripts/bench-emulated-merge.mjs`, `scripts/bench-readme.mjs`, the workflow and the
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
4. **A control leg that must fail.** `2GiB` (2,147,483,648 bytes; the lowest per-run Chrome-only commit peak of the first complete run was 3.94 GB, and the README block computes the
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
port changes anything. Those were the questions of the next dispatch, run 44666921454, which answered them (yes, yes, yes and no); each had a distinct, recorded outcome, and the last column says which one happened:

| What the next dispatch records                                                                                   | How to read it                                                                                                                                                                                                                              | What run 44666921454 recorded                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every capped leg: `readBack.equal` true and `probe.refused` true; the control leg exits 0 (`failed_as_expected`) | The limit is in force: a commit above it is refused and a benchmark far above it cannot complete. The capped legs are then results under their commit limits, and the README says "limit proven in force (probe refused, read-back equal)". | **Happened:** the 8, 6, 5 and 2 GiB legs read back equal and refused the probe; the control exited 0 with `control.verdict` `control_passed` and `control.outcome` `timed_out` (it did not complete in its 12 minutes, which is a stop by the time limit and not a failure reason). |
| `probe.peakAfterBytes` above the limit on a refused probe                                                        | A refused commit is counted in `PeakJobMemoryUsed` (explanation 2): the first run's 5GiB peak above its limit is then an artefact of the counter, not memory the tree held.                                                                 | **Happened** on all four capped legs.                                                                                                                                                                                                                                               |
| `probe.peakAfterBytes` equal to the peak after the small commit on a refused probe                               | A refused commit is not counted. A peak above the limit at the end of a leg would then be a puzzle again (a real commit above a limit that refuses them), and the leg's own figures say so.                                                 | Did not happen.                                                                                                                                                                                                                                                                     |
| `probe.refused` false, `limitNotEnforced` true                                                                   | Explanation 1: the limit is not in force on the runner (applied but not covering the allocation, or ignored). The benchmark still ran; the leg is the same run with no effective cap, and the control leg will not have failed either.      | Did not happen.                                                                                                                                                                                                                                                                     |
| Exit 6 on any leg                                                                                                | The system reports flags or a limit other than the ones set (the structure, a flag the kernel adds, or nesting under the runner's job). The summary has both sets of values.                                                                | Did not happen: the flags read back as exactly `0x2200`, nested under the runner's own job.                                                                                                                                                                                         |
| Control exit 7                                                                                                   | The 2 GiB limit did nothing: the finding is about the script or the runner, not about dockit, and no capped leg of that run counts.                                                                                                         | Did not happen.                                                                                                                                                                                                                                                                     |
| Control exit 8                                                                                                   | The control stopped for a reason the limit is not shown to explain (the probe did not refuse the commit, or was inconclusive).                                                                                                              | Did not happen.                                                                                                                                                                                                                                                                     |
| `completionPort.jobMemoryLimitMessages` above 0                                                                  | The job posted the limit message: Chrome, V8 or the probe asked for a commit that took the job over its limit, with `firstJobMemoryLimitPid` naming the first process.                                                                      | **Happened** on every capped leg (1 on the 8 and 6 GiB legs, 3 on the 5 GiB leg, 2 on the control); `firstJobMemoryLimitPid` was pwsh's own process id on each, so the first message was the probe's.                                                                               |

The private-repository route (a 2 vCPU, 8 GB runner) is **not built**: it costs minutes and the owner decides; it is recorded as an option in PLAN.md.

## What the evidence run shows (run 44666921454)

Every leg had its own runner VM. The machine facts, from each leg's `env.txt` (committed), and the medians of its six rows as the importers compute them (an even count is rounded half up); the question set is the answers that hold the expected text and cite the right page, over the 36 answerable rows of the six runs:

| Leg (`matrix.cap`) | CPU                              | Chrome        | Page file     | First token, ms | Total, ms | Tokens per second | Chrome-only commit peak (median / worst) | Question set | Result                                  |
| ------------------ | -------------------------------- | ------------- | ------------- | --------------- | --------- | ----------------- | ---------------------------------------- | ------------ | --------------------------------------- |
| `none`             | AMD EPYC 9V74 80-Core            | 156.0.8078.80 | `C:` 2,944 MB | 9,920           | 19,592    | 5.95              | 4,148 MiB / 5,334 MiB                    | 24 of 36     | 6 runs, exit 0                          |
| `8GiB`             | Intel Xeon Platinum 8370C 2.8GHz | 156.0.8078.80 | `D:` 2,944 MB | 12,413          | 27,113    | 3.40              | 3,847 MiB / 5,473 MiB                    | 24 of 36     | 6 runs, exit 0                          |
| `6GiB`             | AMD EPYC 7763 64-Core            | 156.0.8078.80 | `D:` 2,944 MB | 11,516          | 24,017    | 4.60              | 3,864 MiB / 5,321 MiB                    | 24 of 36     | 6 runs, exit 0                          |
| `5GiB`             | AMD EPYC 9V45 96-Core            | 157.0.8103.79 | `C:` 2,944 MB | 7,216           | 15,079    | 6.75              | 3,774 MiB / 4,501 MiB                    | 24 of 36     | 6 runs, exit 0                          |
| `2GiB` (control)   | AMD EPYC 7763 64-Core            | 157.0.8103.79 | `D:` 2,944 MB | none            | none      | none              | none                                     | none         | did not complete (exit 124), as it must |

Every leg: Windows Server 2025 Datacenter 10.0.26100, 17,174,360,064 bytes of physical memory, 4 logical processors, Defender real-time protection off. The same two questions (q2 and q6) are wrong in every run of every benchmark leg and the question with
no answer is refused every time, as on the Mac; the worker WebAssembly peak is 2,349,596,672 bytes on every row; `requests_after_offline` is 0 on all 24 rows; no row has a failure reason; no Chrome process was ever outside the job (2,193 membership
samples over the five legs); `bench.err.log` is empty on every leg.

### The limit is in force

Per leg, what the system said (`job-summary.json`, committed) and what the commit probe did. The probe, in pwsh and already inside the job, commits 64 MiB (which must succeed) and then the limit plus 256 MiB (which must be refused), and frees both at once:

| Leg    | Limit, bytes  | `LimitFlags` and `JobMemoryLimit` read back after create / after assign / at the end | 64 MiB, then limit + 256 MiB   | `PeakJobMemoryUsed` before the probe / after the 64 MiB / after the refused commit | Memory-limit messages: whole run / the probe's / during the benchmark |
| ------ | ------------- | ------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `8GiB` | 8,589,934,592 | `0x2200` and the limit, all three times                                              | committed; refused, error 1455 | 89,481,216 / 156,725,248 / 8,965,201,920                                           | 1 / 1 / 0                                                             |
| `6GiB` | 6,442,450,944 | the same                                                                             | committed; refused, error 1455 | 87,027,712 / 154,271,744 / 6,811,119,616                                           | 1 / 1 / 0                                                             |
| `5GiB` | 5,368,709,120 | the same                                                                             | committed; refused, error 1455 | 87,236,608 / 154,476,544 / 5,735,489,536                                           | 3 / 1 / 2                                                             |
| `2GiB` | 2,147,483,648 | the same                                                                             | committed; refused, error 1455 | 86,843,392 / 154,087,424 / 2,507,501,568                                           | 2 / 1 / 1                                                             |
| `none` | none          | `0x2000` and 0 (no limit set), all three times                                       | no probe: nothing to probe     | 104,140,800 at the first tick, 6,081,593,344 at the end                            | 0 / none / 0                                                          |

1,455 is `ERROR_COMMITMENT_LIMIT`. On every capped leg the 64 MiB commit worked, the system had room for the big one (17.6 GB of free virtual memory against a probe of at most 8.9 GB, so the refusal is the job's limit and not a full machine), and the
flags read back as exactly `0x2200` although the job is nested under the runner's own. So **the limit is proven in force on the 8, 6, 5 and 2 GiB legs**, by both halves the README block asks for (the read-back is equal and the probe was refused), and it was
still equal at the end of each run. Explanation 1 of the second dispatch (the limit was not in effect) is excluded.

### The peak counts refused commits: explanation 2 is the one

`PeakJobMemoryUsed` after the refused probe is **above the limit** on every capped leg, by the probe's 256 MiB plus 87 to 107 MB that the job itself held at that moment (before the probe the peak was 87 to 89 MB): 8GiB 106,831,872 B, 6GiB 100,233,216 B, 5GiB 98,344,960 B,
2GiB 91,582,464 B. A commit that the limit refused is counted in the high-water mark as the current commit plus the size that was asked for, so **a whole-tree peak above a limit does not mean the limit was exceeded**. That is what the second dispatch's 5 GiB leg
showed (6,074,314,752 B against a limit of 5,368,709,120 B), and it explains the third dispatch's own 5 GiB peak (6,092,845,056 B, 5,811 MiB) too: its membership log shows the peak and the memory-limit count moving together after the probe, from 5,735,489,536 B (the probe's, count 1) to
5,859,475,456 B when the count became 2 (the sample at 03:23:23Z, 27 seconds in) and to 6,092,845,056 B when it became 3 (03:32:21Z). On the 6 and 8 GiB legs neither the peak nor the count moved at any of their 512 and 574 samples after the probe. The leg with no limit, where nothing can be refused, reads a real
whole-tree peak of 6,081,593,344 B (5,800 MiB), within 11 MB of the 5 GiB leg's: consistent with the same demand, of which the 5 GiB limit refused the part above it (the legs ran on different VMs, so this is consistent, not a measurement of the refused amount). The first
memory-limit message of every capped leg carries the process id that is first in the job's list, which is pwsh itself: it is the probe's.

What that means for the table of the README and of the site: the whole-tree peak of the 8 GiB, 6 GiB and 2 GiB legs is **not measured** (their high-water mark was already as high after the probe as at the end, so it is the probe's), the 5 GiB leg's figure is shown with the statement that it counts
commits the limit refused, and the leg with no limit is the only whole-tree peak that is memory the tree held.

### Commits were refused during the 5 GiB benchmark, and it finished

The messages during the benchmark are the whole-run count minus the count when the probe ended (`limitMessages()` in `scripts/lib/bench-columns.mjs`; each is the system's notice that a process in the job asked for a commit past the limit; the documentation says delivery of these
messages is not guaranteed, so the count is a floor, and a zero is what the port saw, not a proof). On the 5 GiB leg it is **2**: commits were refused while the benchmark ran, and the leg still ran all six runs (five in one Chrome session and one after a Chrome restart) to exit 0 with no failure reason, the same 24 of 36
answers as the leg with no limit and the Mac, and no request after the model was cached. The Chrome-only commit peak is consistent with a limit that held the commit down: in the three legs where nothing was refused (no limit, 8 and 6 GiB) the highest run reaches 5,321 to 5,473 MiB, and in the
5 GiB leg no run is above 4,501 MiB. On the **8 and 6 GiB legs the count is 0**: no commit was refused while the benchmark ran, and they ran as the leg with no limit. What is not known is which process was refused, how it recovered, or whether the refusals cost time: the log does not record it, and no claim about speed follows (below).

### The 2 GiB control passed

The benchmark must not complete under a limit below what it needs (the lowest Chrome-only commit peak of any benchmark run is 3,708 MiB, against a limit of 2,048 MiB). It did not: the script stopped it at its 12-minute limit (`benchExitCode` 124, `timedOut` true, `control.outcome` `timed_out`),
having written no row (`benchProgress.rowsWritten` 0, the last line of the log "cache phase done": the model was cached, and no run finished), with no failure reason (fail-fast saw no crash) and 2 memory-limit messages, the probe's at the start and one 45 seconds later, and nothing for the 11 minutes after that.
Its limit is proven in force, so `control.verdict` is `control_passed` and the leg is green (exit 0). **What it shows:** a limit that is in force stops this benchmark from completing. **What it does not show:** how it stopped. Nothing crashed that fail-fast could name, so the benchmark hung or crawled after a refused commit rather than failing at once, and the log does not say where.
The control wrote no CSV, so the committed runs file holds one marker row for it (`control_leg` true, run 0, no figure, no failure reason), and the README block and the site report it as a control: in no table row, no median, no peak.

### No claim about speed under a cap

Each leg ran on its own VM with its own processor, and the first-token medians follow the processor, not the cap: 7.2 s on the EPYC 9V45 (the 5 GiB leg, the tightest cap), 9.9 s on the 9V74 (no limit), 11.5 s on the 7763 (6 GiB), 12.4 s on the Xeon 8370C (8 GiB). The second dispatch ran the same four caps on
different VMs and ordered them differently (its 5 GiB leg was the slowest, this one's the fastest), and **the same three EPYC processors gave the same medians in both dispatches under other caps**: the 9V45 7,111 ms there (its 8 GiB leg) and 7,216 ms here (5 GiB), the 9V74 9,856 ms (6 GiB) and 9,920 ms (no limit), the 7763 11,511 ms (5 GiB) and 11,516 ms (6 GiB). So the time follows the processor, and with one run per leg and a different VM each time no difference in time between two legs is an effect of the cap; the README and the site say so beside the figures.

## What it does not show

- **It is not a laptop and not an 8 GB figure.** The VM has 4 vCPU and 16 GB of RAM behind a limit on _committed_ memory; with that much RAM nothing is paged under pressure, so a leg either fits or an allocation fails. A real 8 GB laptop shares its memory with an operating system, a browser's other tabs and other apps, has an integrated GPU that takes some of it, throttles when hot and reads a model from a
  slower disk. None of that is here. Every `laptop_8gb` cell still reads "not measured on 8 GB", and Sprint 5's 8 GB done-when stays NOT met (owner runbook step 5).
- **The limit covers the pwsh, node and Chrome process tree**, not Chrome alone; the few hundred MB the other two hold are inside every figure.
- **One run per leg, each on its own VM.** No speed claim; no claim that the 5 GiB figures would repeat (how many commits are refused, and when, depends on timing).
- **Where an answer starts to fail is still open.** The 5 GiB leg finishes with commits refused and the 2 GiB control does not complete; the cap between them was not searched.
- **The private-repository route** (a 2 vCPU, 8 GB runner, a closer stand-in for an 8 GB laptop) is **not built**: it costs minutes and the owner decides; it is recorded as an option in PLAN.md.

## What the runs answered, of the eight open questions

1. **The struct marshalling.** The 144-byte assertion held and `SetInformationJobObject` accepted the layout. Whether the limit is enforced: **yes** (run 44666921454): the read-back equals what was set on every capped leg, three times, and a commit above the limit is refused.
2. **That Chrome's children stay inside the job.** Yes, in both runs: `job_escapes` 0 in all nine legs, in 1,748 membership samples (second dispatch) and 2,193 (third); the second dispatch's job listed pwsh, node, the sampler and eight Chrome processes, and the third's membership log shows at most 8 to 10 Chrome processes at once per leg, all in the job.
3. **How the runner nests its own job.** `AssignProcessToJobObject` succeeded on all nine legs: the runner's step allows nesting, no `assignError` was written, and the flags and the limit read back unchanged after the process was in the job.
4. **The sampler's real interval.** A median of 537 to 561 ms per run in the second dispatch and 540 to 559 ms per leg in the third (`sampler_median_interval_ms`), against the 500 ms it sleeps.
5. **The commit figures.** In the second dispatch the Chrome-only sum and `PeakJobMemoryUsed` agreed to within the pwsh, node and sampler share (418 to 587 MiB) where the sampler caught the highest runs. In the third, the leg with no limit reads a whole-tree peak of 5,800 MiB against a Chrome-only maximum of 5,334 MiB (466 MiB for pwsh, node and the sampler); on a capped leg
   the whole-tree figure is the probe's (not measured) or, on the 5 GiB leg, includes refused commits (above).
6. **The cap at which an answer fails.** **Still open, now bounded:** the 5 GiB leg finishes with commits refused during the benchmark and the 2 GiB control does not complete; the cap between them, at which answers start to fail or the run stops completing, was not searched.
7. **Windows PowerShell 5.1 and encoding.** The sampler worked on every benchmark leg of both runs. The label is ASCII, so a non-ASCII command line was not exercised.
8. **Chrome with its sandbox on.** Chrome started and ran inside the job on every leg with the harness's emulated-run launch (`chromiumSandbox: true`); the log does not print the flags.
