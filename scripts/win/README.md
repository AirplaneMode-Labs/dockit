# scripts/win: the Windows benchmark under an emulated memory cap

`run-capped.ps1` is what the manual `bench-windows` workflow (`.github/workflows/bench-windows.yml`) runs on each leg of its fixed matrix. It is the first
Windows run of `npm run bench:e2e`, and it measures an **emulated** environment: a GitHub-hosted Windows Server VM (4 vCPU and 16 GB RAM on a public
repository), not a laptop. Nothing it measures fills a `laptop_8gb` cell; every one of those still reads "not measured on 8 GB", and the Sprint 5 done-when
stays NOT met (owner runbook step 5).

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

No breakaway flag is ever set, so no child can leave the job on its own. Chrome's own sandbox puts its children in nested jobs; Windows 8 and later nest jobs and
charge the outer limit.

## Files it writes (into `bench-out/`, uploaded with `if: always()` for seven days)

- `e2e-emulated-win-vm.csv` and `e2e-emulated-win-vm-questions.csv`: the rows, with an `environment` column and the emulated columns
  (`scripts/lib/bench-columns.mjs`). The job columns are filled in afterwards by `scripts/bench-emulated-merge.mjs` from `job-summary.json`.
- `bench.log`: the benchmark's console output.
- `job-summary.json`: the cap, the limit, `PeakJobMemoryUsed` (the whole tree's peak commit), the number of Chrome processes seen outside the job, the
  benchmark's exit code and `timedOut`. The script itself exits 124 when it had to stop the benchmark after `-TimeoutMinutes` (80, below the job's 90-minute limit; the children
  are stopped with it) and 5 for an error it did not expect, which is written as `scriptError`; both leave the summary, the log and the membership file for the upload.
- `job-membership.jsonl`: one line every 2 seconds: how many `chrome.exe` carrying the benchmark profile were running, how many `IsProcessInJob` put in the job,
  which ones were outside it (escapes) and the process ids the job lists.
- `env.txt` (written by the workflow before this script): the machine's own facts, never an environment variable.

## What only the first run can prove

None of this has run: this repository's developer machine has no Windows. The first dispatch of the workflow (run 44651054609, 20 Nov 2026) did not reach it: every
leg stopped at the check of `dist-SHA256SUMS`, where `sha256sum --binary --check` is a usage error for GNU `sha256sum` (fixed; see the CHANGELOG), so nothing below has been
answered yet. PowerShell's own parser reads the script and the workflow's pwsh steps in the tests, and the script's logic was run on a Mac with the Windows calls stubbed;
neither is a run on Windows. These are the open questions the next dispatch answers. A leg that fails for one of them is a result, not a surprise.

1. **The struct marshalling.** `Marshal.SizeOf(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)` is asserted to be 144 bytes before any call; whether
   `SetInformationJobObject` accepts the layout, and whether the limit is enforced, is shown only by the run.
2. **That Chrome's children stay inside the job.** `job_escapes` counts the processes `IsProcessInJob` reports outside it; the expected value is 0, and
   `job-membership.jsonl` has the evidence. If any process escapes, the whole-tree figure under-counts and the row says so.
3. **How the runner nests its own job.** If the runner already runs the step inside a job that does not allow nesting, `AssignProcessToJobObject` fails and the
   script stops with exit code 4 and an `assignError` in `job-summary.json`.
4. **The sampler's real interval.** The Windows PowerShell sampler enumerates every process on each tick, so the interval is longer than the 500 ms it sleeps;
   `sampler_median_interval_ms` records it, and a short peak between two ticks is missed.
5. **The commit figures.** `process_commit_peak_bytes` (the Chrome-only sum of `PrivatePageCount`) and `job_commit_peak_bytes` (the job's
   `PeakJobMemoryUsed`) are compared with the limit of the leg; whether the two agree to within the node and pwsh share is a first-run fact.
6. **The cap at which an answer fails.** Whether 8, 6 and 5 GiB pass or fail, and with which reason, is exactly what the ladder measures. A failure is recorded
   as `renderer_crash`, `browser_disconnected`, `worker_crash` or `out_of_memory` within seconds, and the leg exits non-zero.
7. **Windows PowerShell 5.1 and encoding.** The sampler runs `powershell.exe` and asks for UTF-8 without a byte-order mark; a non-ASCII command line is the case
   to look at.
8. **Chrome with its sandbox on.** The emulated run keeps Chrome's sandbox (Playwright adds the sandbox-off switch to every launch unless told not to);
   whether the runner's account lets Chrome start that way is shown by the first run.

The private-repository route (a 2 vCPU, 8 GB runner) is **not built**: it costs minutes and the owner decides; it is recorded as an option in PLAN.md.
