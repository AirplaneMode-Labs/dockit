# dockit

Offline document intelligence kit: an installable web app that answers a question about a PDF with a small local model, entirely
in the browser tab. Built from the Airplane Mode Labs libraries (pagetriage, glyphsift, localdata, runtime).

Live demo: https://airplanemode-labs.github.io/dockit/

The package name `@airplanemode/dockit` is a placeholder until the registry handles are reserved; dockit is never published to a registry; the Pages deploy is the release.

## Status

Sprint 7 (20 Nov 2026): Working: the same app as Sprint 6 (ask a question about a PDF and read an answer from a small local model, Qwen3-0.6B in WebAssembly, with the source pages shown, one model in memory at a time; nothing about the page changed in Sprint 7); its memory figure was re-measured on a quiet machine on the committed Sprint 6 build: the Chrome process tree peaked at a median of 5,436 MiB, down from 6,307 MiB before the Sprint 6 memory work, still short of the 5,120 MiB target (each median is of 5 in-session runs), with the fixed question set at 24 of 36 and a median answer time of 11,304 ms (Apple M5 Pro 48 GB, not measured on 8 GB); a Windows benchmark under an emulated memory cap (a GitHub-hosted virtual machine with 4 vCPU and 16 GB RAM, never a laptop) has run: the commit limit of its 8 GiB, 6 GiB and 5 GiB legs is proven in force (the system reports the limit that was set and a commit above it was refused), all 4 legs finished, commits were refused while the benchmark ran on the 5 GiB leg and it still finished, and the 2 GiB control leg, which must not finish, did not finish; it limits committed memory on one virtual machine, so it is not a laptop figure and fills no 8 GB cell; after the one-time model download no request leaves the page (proved on a local build in installed Chrome on an Apple M5 Pro 48 GB, not measured on 8 GB; live since the owner's push of 18 Nov 2026). Not yet: OCR, a Windows or 8 GB laptop figure (the emulated Windows run is not one), the pilot model (Qwen3-1.7B), a real signing key, WebLLM (cut), multi-document chat.

Done-when: build done on Apple M5 Pro 48 GB; 8 GB Windows done-when NOT met (owner runbook step 5). Sprint 7 changes no part of that: its figures are the Sprint 6 build
re-measured on the same Apple M5 Pro with 48 GB (TD-101), nothing has been measured on an 8 GB Windows laptop, and the emulated Windows run (see Benchmarks) is not a laptop figure either: a GitHub-hosted virtual machine with 16 GB RAM, its job commit limits proven in force, with no 8 GB cell filled.
The memory target of Sprint 6 (a median Chrome process-tree peak of at most 5,120 MiB) was missed on this machine (see Benchmarks), so Sprint 6's own done-when is NOT met either.
Version 0.4.0-dev (private, never published to a registry; the Pages deploy is the release; not tagged; the package name `@airplanemode/dockit` is a placeholder and the registry names are
not reserved). Gate 1 (two paid pilots, 300 stars, five qualified conversations) reads 0, 0 and 0; nothing in this repository moves it.

## What it does

1. **Choose or drop a PDF.** The file stays in the tab; nothing is uploaded. A file over 20 MiB is refused before it is read.
2. **Count the streams, then triage** (pagetriage, WebAssembly, in the analysis worker). First `account_pdf_streams` counts the decoded bytes of every stream of
   the file (fonts, images, page content and everything else, unreferenced objects and earlier revisions included) through a fixed scratch buffer, with its
   compiled-in limits only (dockit passes no options). A font, image or other part that unpacks to more than its limit refuses the file as `stream_limit`, in plain
   words: "This PDF holds a font that unpacks to more than 32 MiB, so it was refused before it was opened." A file whose structure the accounting cannot vouch for
   (a damaged file that other readers would repair, a parser failure) is refused as `corrupt`: "This PDF's structure could not be checked safely, so it was refused
   before it was opened." An encrypted file keeps its own refusal. pdf.js never starts for any of these. Only then is each page triaged: encrypted files and files over
   300 pages are refused, and each page is routed by its text-layer state (text, an OCR layer under an image, or an image only). A page that pagetriage had to cut short
   at one of its own limits refuses the whole file as `too_large` ("A part of this PDF is larger than dockit will unpack, so it was not read.") and is never reported as
   a scanned file. The bytes that were read are handed to the analysis worker by transfer and come back, and the extract stage checks their length and SHA-256 against the
   read stage, so the bytes that were judged are the bytes pdf.js opens; the file is never read twice.
3. **Extract** the text layer with pdf.js (`pdfjs-dist`, in a fresh worker per document, hardened: no eval, no XFA, no fonts, no range or stream, only
   `getTextContent`, never render, annotations or scripts; a 60 second timeout terminates the worker). The analysis worker and the pdf worker are ended as soon as their
   stage ends, which is what returns their WebAssembly memory to the system.
4. **Chunk** deterministically (the text is first made well-formed: an unpaired surrogate, which pdf.js can emit from a broken ToUnicode map, becomes
   U+FFFD, because the gate, the embedder and the store all refuse an ill-formed string; target 700, at most 1,000 UTF-16 units, overlap 100, at most two pages per chunk, split at a blank line, a danda, a
   sentence end or a newline; a chunk of at least 200 units closes at a page boundary so a citation names the page the text is on).
5. **Gate** each chunk with glyphsift's `gate()` (analysis worker). A chunk it holds is not indexed, and the reason (`held_low_score`, with its score
   and the threshold in parts per million) is shown. Text the gate has nothing to say about (Latin text, no letters) passes marked `not_scored`.
6. **Embed** `passage: <text>` in batches of 8 (Sprint 6, M4; it was 32) through the runtime worker host (multilingual-e5-small, 8-bit, 384 dimensions), store chunks and vectors
   with localdata in a namespace of their own (`dockit.d<docId>`, in memory unless you choose to keep the document), and **retrieve** the four nearest
   chunks to `query: <question>`. If the embedder or the store refuses a single passage on its own, that passage is set aside (it is shown as not
   indexed, reason `not_analysed`, with its page) and the rest of the document goes on. A failure that is not about one passage (an integrity failure,
   an unsupported profile) still stops the document with its own message, and so does a document in which no passage could be embedded or stored.
   **One model at a time (Sprint 6).** The embedder is loaded for the ingest and unloaded when it is done (its worker is ended, so its WebAssembly memory is
   returned); a question loads the embedder to embed the question and unloads it, then loads the answer model and unloads it before the next question. Every load is
   a first load: the stored manifest is re-verified, the files are acquired from the device only (a miss is a refusal, never a fetch) and re-hashed in the worker; no
   "already verified" flag skips any of that.
7. **Answer** with Qwen3-0.6B (8-bit, single-threaded WebAssembly) from a fixed system message and the retrieved chunks wrapped as
   `<source id="S1" page="2">...</source>`. Retrieved text is untrusted: special tokens, tag characters, bidi controls, `<source` and `[S<n>]` are
   removed before it reaches the model. The answer is rendered as one text node; citations `[S1]` to `[S4]` map to the retrieved chunks' own page
   metadata, and a citation the model invents (`[S9]`) is dropped and counted. **Stop** ends the answer: a Stop before the first token shows
   "Stopped." with no answer text, a Stop after it keeps the words written so far, and the next question first loads the model again from this
   device (see Limitations).

A capability card shows the runtime's profile (gpu, ramGb, storageFreeGb, cores, backendTier, with the note that `ramGb` is the rounded memory the browser reports through
`navigator.deviceMemory`, not free memory) and the **memory line** (Sprint 6, TD-67): the answer model's signed `minProfile.ramGb`, read from the verified manifest and never from a
constant in the page (it is 4 GB in this bundle). At or above the line the card says "Memory line: the answer model needs a device that reports at least 4 GB to the browser. This
device reports N GB (navigator.deviceMemory, rounded, at most 8). A web page cannot read free memory." Below it, a load is refused before any model byte is read (`unsupported_profile`):
"This device reports N GB of memory to the browser; the answer model needs at least 4 GB. Nothing was loaded." A browser that does not report its memory (`ramGb` 0) is not below the
line (TD-84): the card says "This browser does not report its memory; the answer model may not fit.", the model loads, and the plain out-of-memory refusal is the backstop: "The browser
ran out of memory while running the model, so the answer was stopped. Close other tabs and try again; this device may not have enough memory for the demo model." Every refusal has a
plain-language message (a scanned PDF reads "This PDF has no text layer (it looks scanned). OCR is not yet supported.").

## Install

Requirements: Node 22.12 or newer, npm, Google Chrome (Playwright uses the installed Chrome; no browser is downloaded), and the Rust 1.98 toolchain with
the `wasm32-unknown-unknown` target for the sibling WebAssembly builds.

```sh
git clone https://github.com/AirplaneMode-Labs/dockit
cd dockit
npm ci --ignore-scripts
```

`.npmrc` disables install scripts, so nothing runs during `npm ci`. dockit is a private application (`@airplanemode/dockit`, `private: true`),
deployed to GitHub Pages and built from a clone; it is not installed from npm, PyPI or crates.io. The npm scope `@airplanemode` and the registry names
are not reserved and the name in `package.json` is a placeholder. Nothing is published, and dockit is never published to a registry; the Pages deploy is the release (`docs/release.md`).

The page is built from four sibling repositories at the exact commits in `deps.lock.json` (runtime, localdata, pagetriage, glyphsift); their builds
are never committed (`vendor/`, `public/models/`, `public/app/ort/` and `src/generated/` are git-ignored).

## Usage

```sh
node scripts/assemble-deps.mjs --siblings .. --allow-dirty   # builds the four siblings, the signed model bundle, vendor/ and public/models/
npm run build                                                # vite build, service-worker logic, precache injection; refuses without vendor/
npm run preview                                              # http://127.0.0.1:4173/
npm run ci                                                   # fmt, typecheck, tests and a stub build: no siblings needed
npm run test:e2e                                             # the offline end-to-end proof in installed Chrome (local only)
npm run test:gate                                            # the Devanagari gate in Chrome (local only)
npm run test:browser                                         # the PWA and /dockit/ sub-path specs on the real build (local only)
npm run bench:e2e                                            # the benchmark (local only)
npm run test:failfast                                        # a real chrome://crash is recorded as renderer_crash within 10 seconds (local only)
```

`assemble-deps` re-checks `git rev-parse HEAD` of each sibling against the lock (exit 2 on a mismatch) and refuses a tree with uncommitted changes
unless `--allow-dirty` (the commit is then recorded as `<sha>-dirty`). `--checkouts <dir>` takes clean checkouts at the locked commits instead, which
is what `pages.yml` does. It writes `vendor/PROVENANCE.json` with the hash of every file taken from a sibling.

`npm run build:check` (used by `npm run ci`) builds in stub mode (`DOCKIT_DEPS=stub`): the sibling builds are replaced by stand-ins, the page says
"stub build" and the result is never deployed. `npm run build` fails without `vendor/PROVENANCE.json`.

The model bundle (about 754 MiB, at most 900 MiB) is built by runtime's `scripts/bundle-models.mjs`: every file the engine reads is an entry of a
manifest signed with a key generated in memory for that build and never exported; the public half is compiled into the page. The signature proves that
the manifest and the bundle came from the same build, not who published them. There is no `expiresAt`, so the page keeps working offline.

### Run the end-to-end benchmark

This is runbook step 5 of the Airplane Mode Labs plan (an 8 GB Windows laptop with Wi-Fi off). **`bench:e2e` has run on Windows only as the emulated, GitHub-hosted virtual machine of the `bench-windows` workflow (Benchmarks below), never on a
Windows laptop; your run is the first on one.** In Windows PowerShell, in a clone of dockit with the sibling repositories next to it:

```powershell
npm ci --ignore-scripts
node scripts/assemble-deps.mjs --siblings ..
npm run build
$env:DOCKIT_BENCH_CSV="$PWD\e2e-8gb.csv"; $env:DOCKIT_BENCH_Q_CSV="$PWD\e2e-questions-8gb.csv"; npm run bench:e2e
```

Turn Wi-Fi off when the script prints `cache phase done` (it also blocks the network itself, and counts requests with the Chrome DevTools Protocol
over the page, its workers and its service worker). Process memory is sampled by the script through one long-running Windows PowerShell 5.1 child
every 500 ms, summing `WorkingSetSize` over the Chrome processes of the test profile (the folder named on the first line of the script's output,
`profile <folder>`, always called `chrome-profile-...`). To watch the same figures by hand, in a second PowerShell window while `bench:e2e` runs
(the loop is handed to the child in single quotes, so the outer shell does not expand `$true`; `''` is a single quote inside it; it lists the
processes whose command line carries the test profile's `--user-data-dir`, so add up `WorkingSetSize` over the lines of one sample; the benchmark
itself also adds the child processes that carry no such flag; since Sprint 7 it also reads `PrivatePageCount`, the commit size, next to the working set, and says how many ticks it got and how long they were apart). **This sampler has run on a Windows Server virtual machine** (the three dispatches of the `bench-windows` workflow, below), **never on a Windows laptop**; the owner's run is the first there.

```powershell
powershell.exe -NoProfile -Command 'while ($true) { Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ''*--user-data-dir=*chrome-profile-*'' } | Select ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress; Start-Sleep -Milliseconds 500 }'
```

Task Manager (Details, `chrome.exe`, the memory columns) is the cross-check. If anything fails, send back: the full console log, both CSVs even if
partial, the Chrome version, and the Task Manager reading.

## Demo

Live demo: <https://airplanemode-labs.github.io/dockit/> (built from `main` by `.github/workflows/pages.yml`). The page is live since the owner's push of 18 Nov 2026: `pages.yml` deployed the roughly 800 MB
bundle twice (at `f8abddc` and `840ec8b`), so the GitHub Pages size and deploy-timeout limits are proven for the Sprint 5 bundle. A later sprint's page
reaches the live URL only when the owner pushes it, so until then the live page shows the previous sprint; each sprint's page is proven on a local build
served under `/dockit/` by a server that answers 404 for every other path.

The page has a box titled "What this demo does not do yet". It shows a build id: `Built from main at <sha12>` from CI, or `Local build <sha12>[-dirty]`.

## Benchmarks

Every row names its machine, the command and the commit. The commit column is the code commit that was measured, built from a fresh clone as
`pages.yml` builds it; the commit that adds the CSVs and regenerates this table follows it and changes no code (as for localdata's
vector-index CSV). Peak memory is the peak summed resident size of the test Chrome's process tree; the JS heap
and the workers' WebAssembly memory are different figures under their own names. **Not measured on 8 GB**: the last column says so in every row, and so does the `laptop_8gb` column of both CSVs.

Sprint 6 added a second pair of CSVs, taken before the memory measures with the same command on the same machine (`docs/benchmarks/e2e-s6-baseline.csv` and
`e2e-questions-s6-baseline.csv`, TD-77); `e2e.csv` and `e2e-questions.csv` are the after. The first table below compares the two, and the outcome of the target that TD-66 stated before
anything was measured is computed from them, not typed. The worker WebAssembly figure is the most memory the workers held at once (with one model at a time that is the answer model alone;
Sprint 5 added the engines and the analysis worker because they lived together). The after pair was re-measured in Sprint 7 (TD-101) on the committed Sprint 6 build, measured on dockit commit `4e6654f9e4ed`: built from fresh clones at the commits in
`deps.lock.json` exactly as `pages.yml` builds it (no `--allow-dirty`), on a quiet host (the `host_load_1m_start` and `host_load_1m_end` columns give the load of every run), the same command and the same
Apple M5 Pro 48 GB as the baseline. No commit cell ends in `-dirty`.

Process-tree peaks are comparable only between runs on a quiet host: a run taken while the machine is busy (a high load average, recorded in the host_load_1m_start and host_load_1m_end columns of newer CSVs) can read lower or higher than the same build on a quiet host. The stated figure is the quiet-host one.

**Requests after offline = 0 counts application requests:** the ones made by the page, its workers and its service worker (a Chrome DevTools
Protocol counter over every target). The browser itself may still check `/dockit/sw.js` for an update and fetch the favicon; this count does not include
those two requests, and dockit's code makes neither of them.

### The Windows benchmark under an emulated memory cap (not a laptop)

The manual `bench-windows` workflow (`.github/workflows/bench-windows.yml`, `workflow_dispatch` only, no input) is the Windows run of `bench:e2e`. An ubuntu job builds `dist` as `pages.yml`
does and hands it over as a one-day artefact (with a `dist-SHA256SUMS` list that the Windows job checks before serving anything); a `windows-latest` job then runs the benchmark once per leg of a
fixed matrix, **no limit, 8, 6 and 5 GiB, and a 2 GiB control leg that must fail**, with the pwsh, node and Chrome process tree inside a Windows Job Object whose committed-memory limit is the cap (`scripts/win/run-capped.ps1`, a few lines of C#
through `Add-Type`, documented Win32 calls only, no new dependency; `scripts/win/README.md` lists what it does, what each run showed and what it did not). The runner is a GitHub-hosted Windows Server VM
with 4 vCPU and 16 GB RAM, **not a laptop**, and a commit limit is not a physical-memory limit: with the memory behind it a capped job never pages, so a leg either fits or an allocation fails. The job limit
covers the pwsh, node and Chrome process tree, not Chrome alone. Each row says so in an `environment` column, for example `emulated: GitHub-hosted Windows Server 2025 VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree under a job commit limit of 6442450944 bytes; not a laptop` (the first leg, with no cap, reads `... process tree with no job limit; not a laptop`; the limit is written in bytes, 8589934592, 6442450944, 5368709120 and, for the control, 2147483648, because the label is built from the machine's own facts);
the results go in separate files (`docs/benchmarks/e2e-emulated-win-vm.csv` and `e2e-emulated-win-vm-questions.csv`, never `e2e.csv`), `laptop_8gb` still reads `not measured on 8 GB` on every row, and the 8 GB Windows done-when stays NOT met.
A crash or an out-of-memory in a leg ends it within seconds with a recorded reason (`renderer_crash`, `browser_disconnected`, `worker_crash` or `out_of_memory`) instead of waiting out the ten-minute answer timeout.

**The workflow has run three times on 20 Nov 2026, and the third run is the one whose rows are committed.** The first dispatch (run 44651054609) stopped at the checksum step, before any benchmark. The second (run 44656249868 on `5705baab8cdf`) finished all four legs but had no way to show that its limit bound anything: its 5 GiB leg reported a whole-tree peak above its own limit and nothing said whether the limit was in force. The third (run 44666921454 on `f6a71cab4ab1`) is the first that reads the limit back from the system, probes it from inside the job before the benchmark and has a control leg, and all five legs ended as designed. The second run's rows are kept unchanged in `docs/benchmarks/history/` and are in none of the figures below; `scripts/win/README.md` records that run, the anomaly it left and how the third run settled it, and the per-leg `job-summary.json` and `env.txt` of the third run are in `docs/benchmarks/emulated-win-vm-run-44666921454/`.

**What run 44666921454 shows.** On the 8, 6 and 5 GiB legs and on the 2 GiB control the system reported back the limit that was set (`LimitFlags` `0x2200` and the same `JobMemoryLimit`, after the job was created and again after the process was put in it), and a commit of the limit plus 256 MiB made from inside the job before the benchmark started was refused (`ERROR_COMMITMENT_LIMIT`) while a 64 MiB commit succeeded: the limit is **proven in force** on each of those legs, and the table below says so only because both halves hold. The refused commit is itself counted in the job's `PeakJobMemoryUsed` (after the probe it read the limit plus 256 MiB plus what the job then held), so **a whole-tree peak above a limit does not mean the limit was exceeded**: that settles the second run's anomaly in favour of the explanation that the peak counts commits the limit refused. On the 5 GiB leg the job's completion port received two memory-limit messages while the benchmark ran (besides the probe's one), so commits were refused during the benchmark, and the leg still finished all six runs with the same 24 of 36 answers as the leg with no limit and the Mac (the same two questions wrong in every run of every leg, the question with no answer refused every time). On the 8 and 6 GiB legs the only message was the probe's, so no commit was refused during the benchmark. The 2 GiB control, whose limit is below what the benchmark needs, did not complete in its 12 minutes and its limit is proven in force, so it passed as a control. No leg failed for want of memory, a Chrome process was never seen outside the job, and no request left the page after the model was cached.

**What it does not show.** It is one run on a GitHub-hosted Windows Server 2025 VM with 4 vCPU and 16 GB RAM, **not a laptop**. It limits committed memory on the pwsh, node and Chrome process tree and nothing else: it does not limit physical RAM, and it does not model an 8 GB machine's operating system and other apps, its integrated GPU, its thermal limits or its disk. It is not an 8 GB figure and fills no 8 GB cell, and **Sprint 5's 8 GB done-when stays NOT met**. It makes no claim that a cap changes speed: each leg ran on its own VM with a CPU of its own, and the median first-token time follows the processor (7.2 s on the EPYC 9V45 of the 5 GiB leg, 9.9 s on the 9V74 of the leg with no limit, 11.5 s on the 7763 of the 6 GiB leg, 12.4 s on the Xeon 8370C of the 8 GiB leg), not the cap: the tightest cap ran fastest, and the same three EPYC processors gave the same medians in the second dispatch under other caps (7.1 s on the 9V45, 9.9 s on the 9V74, 11.5 s on the 7763). The whole-tree peak of the 8 GiB, 6 GiB and 2 GiB legs is **not measured**, because the job's high-water mark was already as high after the probe as at the end of the run. The 2 vCPU, 8 GB
runner of a private repository would be a closer stand-in for an 8 GB laptop but costs private-repository minutes; that route is **not built** and is the owner's option. The subsection below is generated from the CSVs and describes a capped leg as "limit proven in force (probe refused, read-back equal)" only when both hold; a control leg is reported as a control and is in none of the figures. (The dated Status paragraph at the top is the Sprint 7 snapshot, regenerated from the same rows.)

Local runs launch Chrome through Playwright's default, which turns Chrome's own sandbox off; the Windows run keeps it on. The committed macOS figures are all taken the first way, so they are comparable with each other and not with a sandboxed run.

<!-- prettier-ignore-start -->
<!-- bench:start -->
**Memory hardening, before and after** (Sprint 6, TD-66 and TD-77; one model at a time, and the analysis and PDF workers ended as soon as their stage ends). Both sets were measured on the same machine with the same command; each row is the median and the worst of the five runs of one Chrome session, with none left out. The 8 GB column reads not measured on 8 GB in every row.

| Run | Runs | Peak memory: Chrome process tree (median / worst) | Time to first token, ms (median / worst) | Total, first question, ms (median / worst) | Per-question total, every question of every run, ms (median / worst) | Question set | Requests after offline | Command | Commit | 8 GB laptop |
|---|---|---|---|---|---|---|---|---|---|---|
| Before: both models loaded together | 5 | 6,307 MiB / 6,336 MiB | 7,857 / 7,927 | 9,500 / 9,544 | 9,391 / 10,878 | 4 of 6 first run, 24 of 36 over all runs | 0 | `npm run bench:e2e` | `840ec8b0eba4` | not measured on 8 GB |
| After: one model at a time | 5 | 5,436 MiB / 5,446 MiB | 7,882 / 7,899 | 11,494 / 11,507 | 11,304 / 11,645 | 4 of 6 first run, 24 of 36 over all runs | 0 | `npm run bench:e2e` | `4e6654f9e4ed` | not measured on 8 GB |

The target stated before measuring (TD-66) was a median peak of at most 5,120 MiB, the question set no worse than 24 of 36 over all runs and 4 of 6 on the first run, and a median per-question total of at most 12,500 ms. The median peak went from 6,307 MiB to 5,436 MiB, a fall of 871 MiB (13.8 percent). Each median is the median of the 5 in-session runs; the run after a Chrome restart is a separate row and is not in it. Differences and percentages are computed from the exact medians (the exact fall is 871.0 MiB, shown as 871 MiB) and then rounded, so a difference can differ by 1 MiB from the subtraction of the two rounded medians. The target was missed for memory; the question set was not worse than the floor; the time guard was reached (median per-question total 11,304 ms, against 9,391 ms before). Not measured on 8 GB.

| Machine | Run kind | Runs | Time to first token, ms (median / worst) | Total, ms (median / worst) | Peak memory: Chrome process tree (median / worst) | JS heap peak (median / worst) | Worker WebAssembly memory peak (median / worst) | Requests after offline | Command | Commit | 8 GB laptop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Apple M5 Pro 48 GB | one session | 5 | 7,882 / 7,899 | 11,494 / 11,507 | 5,436 MiB / 5,446 MiB | 36 MiB / 50 MiB | 2,241 MiB / 2,241 MiB | 0 | `npm run bench:e2e` | `4e6654f9e4ed` | not measured on 8 GB |
| Apple M5 Pro 48 GB | after a Chrome restart | 1 | 7,885 / 7,885 | 11,447 / 11,447 | 5,268 MiB / 5,268 MiB | 36 MiB / 36 MiB | 2,241 MiB / 2,241 MiB | 0 | `npm run bench:e2e` | `4e6654f9e4ed` | not measured on 8 GB |

Question set (seven fixed questions over a synthetic three-page policy, results not selected): 4 of 6 correct with the correct source page on the first run; 24 of 36 over all 6 runs; the question with no answer was refused in 6 of 6 runs.

Cited source page correct in 24 of 36 answerable rows (a refused answer cites nothing, so it never counts). Top-ranked retrieved passage on the right page in 36 of 36 (retrieval quality, reported on its own).
<!-- bench:end -->
<!-- bench-emulated:start -->
### Emulated Windows (not a laptop)

Generated from `docs/benchmarks/e2e-emulated-win-vm.csv`, the result of the manual `bench-windows` workflow: the same `bench:e2e` on a GitHub-hosted Windows Server VM, with the pwsh, node and Chrome process tree inside a Windows Job Object whose commit limit is the cap of the leg (none, 8, 6 and 5 GiB). The job limit covers the pwsh, node and Chrome process tree, so the whole-tree peak counts pwsh and node as well as Chrome. A commit limit is not a physical-memory limit: the VM has more RAM than a laptop, nothing is paged under pressure, and a leg either fits or an allocation fails, and it does not model an 8 GB machine's operating system and other apps, an integrated GPU, thermal limits or its disk. These rows are never laptop rows and fill no 8 GB cell. The Sprint 5 done-when stays NOT met (owner runbook step 5). A further control leg, whose limit is far below what the benchmark needs, must not complete; it is reported below as a control and is in none of the figures.

| Environment (verbatim) | Runs | Job commit limit | Limit in force | Commits refused while the benchmark ran | Peak commit, whole tree: pwsh, node and Chrome | Peak commit, Chrome only (median / worst) | Chrome processes outside the job | Time to first token, ms (median / worst) | Total, ms (median / worst) | Question set (cited page correct, all runs) | Result | Commit, Chrome | 8 GB laptop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| emulated: GitHub-hosted Windows Server 2025 Datacenter VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree with no job limit; not a laptop | 6 | no limit | no limit set (read-back: JobMemoryLimit 0) | not applicable (no limit) | 5,800 MiB | 4,148 MiB / 5,334 MiB | 0 | 9,920 / 9,945 | 19,592 / 19,790 | 24 of 36 | pass | `f6a71cab4ab1`, Chrome/156.0.8078.80 | not measured on 8 GB |
| emulated: GitHub-hosted Windows Server 2025 Datacenter VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree under a job commit limit of 8589934592 bytes; not a laptop | 6 | 8 GiB | limit proven in force (probe refused, read-back equal) | none (the probe's 1 not counted) | not measured | 3,847 MiB / 5,473 MiB | 0 | 12,413 / 12,586 | 27,113 / 28,655 | 24 of 36 | pass | `f6a71cab4ab1`, Chrome/156.0.8078.80 | not measured on 8 GB |
| emulated: GitHub-hosted Windows Server 2025 Datacenter VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree under a job commit limit of 6442450944 bytes; not a laptop | 6 | 6 GiB | limit proven in force (probe refused, read-back equal) | none (the probe's 1 not counted) | not measured | 3,864 MiB / 5,321 MiB | 0 | 11,516 / 11,607 | 24,017 / 25,101 | 24 of 36 | pass | `f6a71cab4ab1`, Chrome/156.0.8078.80 | not measured on 8 GB |
| emulated: GitHub-hosted Windows Server 2025 Datacenter VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree under a job commit limit of 5368709120 bytes; not a laptop | 6 | 5 GiB | limit proven in force (probe refused, read-back equal) | yes: 2 messages while the benchmark ran (the probe's 1 not counted) | 5,811 MiB | 3,774 MiB / 4,501 MiB | 0 | 7,216 / 7,341 | 15,079 / 15,941 | 24 of 36 | pass (whole-tree peak above a limit that is proven in force: the peak counts commits the limit refused) | `f6a71cab4ab1`, Chrome/157.0.8103.79 | not measured on 8 GB |

| Limit evidence (leg) | Read-back: LimitFlags, JobMemoryLimit | Commit of the limit + 256 MiB from inside the job | Refused commit counted in PeakJobMemoryUsed? | PeakJobMemoryUsed right after the probe | JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages, whole run | of which caused by the probe | posted while the benchmark ran |
|---|---|---|---|---|---|---|---|
| no limit | 0x2000, 0 bytes (equal to what was set) | none: no limit is set | not known | not measured | 0 | no probe | 0 |
| 8 GiB | 0x2200, 8,589,934,592 bytes (equal to what was set) | refused | yes: 8,550 MiB is above the limit of 8,192 MiB | 8,550 MiB | 1 | 1 | 0 |
| 6 GiB | 0x2200, 6,442,450,944 bytes (equal to what was set) | refused | yes: 6,496 MiB is above the limit of 6,144 MiB | 6,496 MiB | 1 | 1 | 0 |
| 5 GiB | 0x2200, 5,368,709,120 bytes (equal to what was set) | refused | yes: 5,470 MiB is above the limit of 5,120 MiB | 5,470 MiB | 3 | 1 | 2 |
| 2 GiB (control) | 0x2200, 2,147,483,648 bytes (equal to what was set) | refused | yes: 2,391 MiB is above the limit of 2,048 MiB | 2,391 MiB | 2 | 1 | 1 |

**The 5 GiB leg had commits refused while the benchmark ran, and the leg still finished.** The job's completion port received 2 JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages while the benchmark ran, besides the 1 the probe caused: each is the system's notice that a process in the job asked for a commit past the limit and was refused (the system does not guarantee delivery of these notices, so the count is a floor, not an exact number of refusals). The limit was proven in force before the benchmark started (probe refused, read-back equal), so these are refusals by a limit that was in force, not a limit that did nothing. All 6 runs of the leg finished with no failure reason, and its question set reads 24 of 36 answers with the cited page correct (the same as the no-limit leg's).

**No commit was refused while the benchmark ran on the 8 GiB and 6 GiB legs.** The only memory-limit message the completion port received on each was the one the probe caused, so the port saw no refusal during the benchmark (the system does not guarantee delivery of these notices, so this is what the port saw, not a proof).

**The 5 GiB leg's whole-tree peak is above its limit, and the limit is proven in force.** Its whole-tree peak is 5,811 MiB, 691 MiB above its job commit limit of 5,120 MiB, so the job's `PeakJobMemoryUsed` counts a commit that the limit refused: the peak is not memory the tree held.

**The whole-tree peak of the 8 GiB leg is not measured.** The job's `PeakJobMemoryUsed` read 8,550 MiB right after the commit probe and the benchmark never took it higher, so the high-water mark is the probe's and not the benchmark's.

**The whole-tree peak of the 6 GiB leg is not measured.** The job's `PeakJobMemoryUsed` read 6,496 MiB right after the commit probe and the benchmark never took it higher, so the high-water mark is the probe's and not the benchmark's.

The limit of every capped leg is proven in force: the system reports the limit that was set, and a commit of the limit plus 256 MiB made from inside the job before the benchmark started was refused. A capped leg whose Result reads pass therefore ran to the end with its commit limit in force. The limit is the job-wide commit limit of a GitHub-hosted Windows VM, not a physical-memory limit, and the VM is not a laptop.

Each leg ran on its own runner VM, and the runner's CPU model and Chrome build can differ from leg to leg, so a difference in time between two legs is not an effect of the cap. The machine facts of each run, leg by leg, are in `scripts/win/README.md`.

**Control leg, 2 GiB: not a benchmark figure.** The benchmark must not complete here: its limit is below the lowest Chrome-only commit peak of any run of the other legs (3,708 MiB), so a limit that is in force must stop the benchmark. It did not complete: no run finished (its row is a marker, run 0) and no failure reason was recorded, so it was stopped by the time limit or a crash; the limit is proven in force (probe refused, read-back equal), so the control passed. It saw 1 memory-limit message while it ran, besides the probe's 1. Label: `emulated: GitHub-hosted Windows Server 2025 Datacenter VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree under a job commit limit of 2147483648 bytes (control leg, expected to fail); not a laptop`.

Column notes. Peak commit is the Windows commit size (PrivatePageCount, in bytes), which is what a Job Object limit adds up; the whole-tree figure is the job's PeakJobMemoryUsed for the whole run (it includes the model download that comes before the first run, which the Chrome-only sampler does not cover) and is the same in every row of a leg, the Chrome-only figure is the sum over the Chrome process tree of this run. It is left empty (not measured) when the high-water mark was already as high after the commit probe as at the end of the run, because then it is the probe's. Limit in force is computed from the evidence columns: the read-back (QueryInformationJobObject, after the process was put in the job) must equal what was set and the commit above the limit must have been refused. Commits refused while the benchmark ran is the job completion port's count of JOB_OBJECT_MSG_JOB_MEMORY_LIMIT messages over the whole run minus the count when the probe ended (the probe's own refused commit posts one); the system does not guarantee delivery of these messages, so it is a floor, and a leg with no limit has nothing to refuse. The question set is the number of answers that hold the expected text and cite the right page over every answerable row of every run of the leg (36 rows for six runs of the six answerable questions). The Windows sampler enumerates every process on each tick, so its median interval (the sampler_median_interval_ms column) is longer than the 500 ms it sleeps, and a peak shorter than that can fall between two ticks. A leg that is incomplete or failed says so in the Result column and keeps every row it wrote.
<!-- bench-emulated:end -->
<!-- prettier-ignore-end -->

The CSVs (`docs/benchmarks/e2e.csv`, `e2e-questions.csv` and the two `-s6-baseline` files) hold every run; none was left out. `e2e-questions.csv` keeps two page columns apart: `correct_source_page` is
true only when a source the answer **cites** names the page that holds the answer (a refused answer cites nothing, so it is false), and `top_retrieved_page_ok` says
whether the top-ranked retrieved passage is on that page (retrieval quality). The "N of M correct with the correct source page" figure is the answer holding the expected
text AND `correct_source_page`.

## Limitations

- **Text-layer PDFs only. OCR is not yet supported:** a scanned PDF is refused, and image-only pages are skipped (`ocr_not_yet`).
- **Qwen3-0.6B is a demo model, not the pilot model** (Qwen3-1.7B, hosted by the customer: its 4-bit graph alone is 1,426,069,098 bytes, over the 1 GB
  GitHub Pages limit, so no demo loads it). Answers from a model this small can be wrong: check the source pages.
- **Single-threaded WebAssembly:** GitHub Pages cannot send cross-origin-isolation headers, so the engine runs on one thread and a question takes seconds.
- **Shared origin:** the demos live on `airplanemode-labs.github.io`, so storage and quota are shared. The models are held in the shared
  `airplanemode-runtime` OPFS store, and any page of the origin can read what you choose to keep: "Keep on this device" stores a document unencrypted in
  this browser profile (the warning is shown next to the option). By default documents stay in memory, and Delete removes them physically.
- **What "Keep on this device" stores:** a kept document holds its chunk text, embeddings, page numbers and the file's SHA-256, all unencrypted. The
  hash can confirm whether a known document was processed. The warning next to the option says the same.
- **Not measured on 8 GB.** Every laptop figure here is from an Apple M5 Pro with 48 GB. No Windows laptop figure exists: the emulated Windows run (a GitHub-hosted VM with 4 vCPU and 16 GB RAM, not a laptop; Benchmarks above) ran on 20 Nov 2026 and fills no 8 GB cell. Its 8, 6 and 5 GiB job commit limits are proven in force (a commit above each was refused, and the system read back the limit that was set), and the 5 GiB leg finished although commits were refused while it ran; but a limit on committed memory on a 16 GB virtual machine does not model an 8 GB laptop's operating system and other apps, integrated graphics, thermal limits or disk, so it is not an 8 GB result and Sprint 5's 8 GB done-when stays NOT met. Sprint 6 cut the Chrome process-tree peak during a question <!--fig:cut-->from a median of 6,307 MiB to 5,436 MiB (worst 5,446 MiB; median of the 5 in-session runs)<!--/fig--> by holding one model at a time, but the target of at most 5,120 MiB was **missed**, so there is still a reason to expect trouble on
  8 GB: the answer model alone holds about 2,241 MiB of WebAssembly memory while it answers. The sum counts a page shared between processes in each of them, so it overstates the memory
  used; whether the demo fits an 8 GB Windows laptop is exactly what the runbook run above measures.
- **Every question loads the embedder and then the answer model again from this device (Sprint 6).** Holding one model at a time is what lowers the peak, and its price is time: <!--fig:time-->the median per-question total went from 9,391 ms to 11,304 ms (worst 11,645 ms)<!--/fig-->, and the two loads of one question take about 2.3 seconds in all (2,180 and 2,395 ms in the two Stop-then-Ask
  runs of `npm run test:e2e`, which prints each one). Every load is a first load: the stored manifest is re-verified, the files are read from the cache and hashed in the worker, nothing is
  downloaded and the page is not reloaded; the model card reads "Loading the model again from this device..." and Ask stays disabled until the loads are done. **Not measured on 8 GB**: the
  model bundle is 754 MiB, so expect longer there.
- **The memory line is a usability guard, not a security control.** It is the answer model's signed `minProfile.ramGb` (4), checked against `navigator.deviceMemory`, which Chrome rounds to a
  power of two and reports up to 8, which a user can override, and which a page cannot turn into free memory. Below the line a load is refused with the exact words above; a browser that does
  not report its memory is not refused (TD-84) and the out-of-memory refusal is the backstop. The line is 4, not 8, because an 8 GB laptop that reserves memory for its graphics may report 4:
  refusing the device the wedge targets without a measurement would be wrong. The owner's 8 GB figures re-decide the number.
- **Stop ends the engine worker.** The runtime's worker host terminates the worker on an abort (backend adapter R8). A Stop before the first token shows "Stopped."; a Stop after it keeps the
  partial answer and the log says `aborted` (S1-119), not `ok`. Because every use unloads its model (above), the next question loads both models again through the same path as any other.
- **Hindi quality not measured.** The glyph gate is tested on synthetic Devanagari text layers (one clean, one damaged); answers over Hindi documents are
  not evaluated. English synthetic fixtures are the only question set.
- No real signing key: the manifest is signed by a key that exists only inside the build that made the page, so a visitor learns that the manifest and the
  bundle belong together, not who published them (pre-pilot rows 1 and 2 are the owner's).
- No WebLLM (cut, TD-08), no multi-document chat, no encryption at rest. The CSP is delivered by a meta tag, which cannot set `frame-ancestors`; a framed
  copy shows only a link to open dockit directly.
- Tested in Chrome only (Playwright channel `chrome`), launched through Playwright's default, which turns Chrome's sandbox off for the local specs and the macOS benchmark; only the Windows emulated run keeps the sandbox on. Firefox and Safari are untested. CI runs `npm run ci` (formatting, types, unit tests and a stub build) on three operating systems; the browser, end-to-end, gate and benchmark runs need the sibling builds and the 754 MiB model bundle, so they run locally and on the owner's laptop, never in CI.
- Chrome 157: a model file written less than about a second ago can fail its first read by the engine; the load is retried once after 1.5 s (`LOAD_RETRY_PAUSE_MS`). The cause is not understood and is not fixed in dockit.
- pdf.js drops U+200C and U+200D from the text it extracts, so a joiner in a text layer never reaches dockit.
- **A hostile PDF that hides a very large compressed font or image is refused before pdf.js opens it (S1-107, Sprint 6); a damaged file that other readers would repair is refused too.**
  pagetriage's `account_pdf_streams` counts the decoded bytes of every stream of the file through a fixed scratch buffer and never keeps a decoded stream, with limits compiled in
  (32 MiB per font, 256 MiB per image or its raster, 64 MiB per content or other stream, 512 MiB in all); dockit passes it no options. Measured on 19 Nov 2026 in installed Chrome 157 on the
  Apple M5 Pro 48 GB against the local build (`npm run test:e2e`, which prints each line): a font-bomb fixture (a text page whose embedded TrueType font file inflates to 1 GiB + 1, generated at test
  time, not committed) was refused as `stream_limit` in plain words with no pdf.js worker started and no extract event; the peak summed resident size of Chrome's processes during the open was
  3,056 MiB, against 3,051 MiB idle just before it, where Sprint 5 had accepted the same file and measured 8,121 MiB (T1) and 8,275 MiB (an earlier observation) against 6,195 MiB idle; the analysis
  worker's WebAssembly memory peaked at 5 MiB. An image bomb (1 GiB + 1 declared 32768 x 32768) gave 3,052 MiB against 3,053 MiB idle and 5 MiB, and a file with a broken cross-reference table, which
  pdf.js opens and lopdf cannot vouch for, was refused as `corrupt` with "This PDF's structure could not be checked safely, so it was refused before it was opened." at 3,054 MiB against 3,054 MiB and 3 MiB. A damaged
  file that pdf.js could have repaired is now refused (TD-85: safety before availability). What the accounting does not cover is documented in pagetriage's `docs/detectors/streams.md`: pdf.js's own
  decoding of inline images, Type 3 glyph procedures and the CPU time of its font parser. Not measured on 8 GB.
- The Pages size and timeout limits are proven for the Sprint 5 bundle by two real deploys of `pages.yml` (18 Nov 2026, `f8abddc` and `840ec8b`). A later bundle is proven only by its own deploy after the owner's push.

## Security and privacy

<!-- prettier-ignore -->
After the one-time model download this app makes no network requests, and it sends no telemetry. The document never leaves the tab.

Content security policy in `index.html` (pinned byte for byte by `test/csp.test.ts`):

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self';
img-src 'self'; style-src 'self'; font-src 'none'; manifest-src 'self'; media-src 'none'; frame-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script';
trusted-types dockit-sw airplanemode-worker dockit-workers
```

- `blob:` appears only in `worker-src`: runtime's `startModuleWorker` starts every worker (engine, pdf, analysis) from a blob bootstrap whose whole
  source is one static import of an exact same-origin URL, and the worker inherits this CSP, so `script-src 'self'` still decides what it can load.
- Trusted Types: three policies and no default policy, no `allow-duplicates`. Every worker runs the runtime's egress guard as its first statement; the
  pdf worker may fetch only `<base>pdfjs/` and the analysis worker only `<base>vendor/`.
- The service worker is registered with the scope of the document base (`/dockit/` on Pages), precaches the shell, the WebAssembly files and the pdf.js
  assets after verifying every file's SHA-256, serves navigations from that cache, never sees a document or a model file (`models/`, `blob:` and `data:`
  requests pass through), and reads caches only through its own cache name.
- Model and PDF text reach the DOM only as text nodes (a test forbids `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML`,
  `document.write`, `srcdoc`, `createContextualFragment`, `setAttribute('href'|'src'|'style')`, `window.open`, `location =`, `eval(` and `new Function`).
- The verified manifest is stored (IndexedDB database `dockit`) and re-verified on every load; offline, a stored manifest that fails verification
  stops the load (`manifest_refused`) before any model byte reaches the engine.
- Events carry counts, timings and enums only: never a file name, document id, title, text, question or answer. They are exposed to the runtime DevTools
  panel through `window.__airplanemodeDevtools.snapshot()`.

Headers that hosting must add (a meta tag cannot set them): `Content-Security-Policy` with `frame-ancestors 'none'`, `Cross-Origin-Opener-Policy:
same-origin` (and COOP/COEP for threaded WebAssembly), `X-Content-Type-Options: nosniff` and a `Referrer-Policy`. GitHub Pages cannot set any of them;
a dedicated origin is a pre-pilot item for the owner.

See `SECURITY.md` for reporting.

## Licence

Apache-2.0 (`LICENSE`). Third-party notices are in `NOTICE` and `public/THIRD-PARTY-NOTICES.txt`: pdfjs-dist (Apache-2.0), transformers.js
(Apache-2.0), ONNX Runtime Web (MIT), Qwen3-0.6B (Apache-2.0, base model Qwen/Qwen3-0.6B) and multilingual-e5-small (MIT per the intfloat model card),
each with its source repository and pinned revision, and the four sibling builds with their commits.

## Contributing

See `CONTRIBUTING.md`. Tests come before the implementation, and CI must stay green on Linux, macOS and Windows (`npm run ci`). The contracts in
`src/contracts/` are vendored from `runtime/spec` (spec release 0.6.1) and are never edited here: `npm run sync-contracts`. Open an issue with one of the forms under
`.github/ISSUE_TEMPLATE/` (the bug form asks you to confirm that you attached no real, confidential or personal document); report a vulnerability as `SECURITY.md` says, privately.
