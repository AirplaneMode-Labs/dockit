# dockit

Offline document intelligence kit: an installable web app that answers a question about a PDF with a small local model, entirely
in the browser tab. Built from the Airplane Mode Labs libraries (pagetriage, glyphsift, localdata, runtime).

## Status

Sprint 6 (19 Nov 2026): Working: ask a question about a PDF and read an answer from a small local model (Qwen3-0.6B, WebAssembly) with the source pages shown, as before, now with one model in memory at a time: the Chrome process tree peaked at a median of 5,441 MiB, down from 6,307 MiB, short of the 5,120 MiB target (each median is of 5 in-session runs), with the fixed question set unchanged at 24 of 36 and every answer about 2.6 seconds slower (not measured on 8 GB); the capability card states the memory line read from the signed model list, a device that reports less is refused before any model byte is read, and an out-of-memory failure in the engine is a plain refusal; a PDF with a font, image or other part that unpacks to more than a limit, or whose structure cannot be checked, is refused before pdf.js opens it; a Stop is logged as aborted; after the one-time model download no request leaves the page (proved on a local build in installed Chrome on an Apple M5 Pro 48 GB, not measured on 8 GB; live since the owner's push of 18 Nov 2026). Not yet: OCR, a Windows or 8 GB figure, the pilot model (Qwen3-1.7B), a real signing key, WebLLM (cut), multi-document chat.

Done-when: build done on Apple M5 Pro 48 GB; 8 GB Windows done-when NOT met (owner runbook step 5). Sprint 6 changes no part of that: its figures are from the same
Apple M5 Pro with 48 GB, and nothing has been measured on an 8 GB Windows laptop. The memory target of Sprint 6 (a median Chrome process-tree peak of at most
5,120 MiB) was missed on this machine (see Benchmarks), so Sprint 6's own done-when is NOT met either. Version 0.3.0-dev (private, not published, not tagged;
the package name `@airplanemode/dockit` is a placeholder and the registry names are not reserved).

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

Requirements: Node 22 or newer, npm, Google Chrome (Playwright uses the installed Chrome; no browser is downloaded), and the Rust 1.98 toolchain with
the `wasm32-unknown-unknown` target for the sibling WebAssembly builds.

```sh
git clone https://github.com/AirplaneMode-Labs/dockit
cd dockit
npm ci --ignore-scripts
```

`.npmrc` disables install scripts, so nothing runs during `npm ci`. dockit is a private application (`@airplanemode/dockit`, `private: true`),
deployed to GitHub Pages and built from a clone; it is not installed from npm, PyPI or crates.io. The npm scope `@airplanemode` and the registry names
are not reserved and the name in `package.json` is a placeholder. Nothing is published.

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

This is runbook step 5 of the Airplane Mode Labs plan (an 8 GB Windows laptop with Wi-Fi off). **`bench:e2e` has never run on Windows; this run is the
first.** In Windows PowerShell, in a clone of dockit with the sibling repositories next to it:

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
itself also adds the child processes that carry no such flag). **This sampler has never run on Windows**; the owner's run is the first.

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
Sprint 5 added the engines and the analysis worker because they lived together). The after-run's commit column reads `-dirty` because it was taken on the working tree; the architect
re-runs it on the committed build at the wrap-up.

Process-tree peaks are comparable only between runs on a quiet host: a run taken while the machine is busy (a high load average, recorded in the host_load_1m_start and host_load_1m_end columns of newer CSVs) can read lower or higher than the same build on a quiet host. The stated figure is the quiet-host one.

**Requests after offline = 0 counts application requests:** the ones made by the page, its workers and its service worker (a Chrome DevTools
Protocol counter over every target). The browser itself may still check `/dockit/sw.js` for an update and fetch the favicon; this count does not include
those two requests, and dockit's code makes neither of them.

<!-- prettier-ignore-start -->
<!-- bench:start -->
**Memory hardening, before and after** (Sprint 6, TD-66 and TD-77; one model at a time, and the analysis and PDF workers ended as soon as their stage ends). Both sets were measured on the same machine with the same command; each row is the median and the worst of the five runs of one Chrome session, with none left out. The 8 GB column reads not measured on 8 GB in every row.

| Run | Runs | Peak memory: Chrome process tree (median / worst) | Time to first token, ms (median / worst) | Total, first question, ms (median / worst) | Per-question total, every question of every run, ms (median / worst) | Question set | Requests after offline | Command | Commit | 8 GB laptop |
|---|---|---|---|---|---|---|---|---|---|---|
| Before: both models loaded together | 5 | 6,307 MiB / 6,336 MiB | 7,857 / 7,927 | 9,500 / 9,544 | 9,391 / 10,878 | 4 of 6 first run, 24 of 36 over all runs | 0 | `npm run bench:e2e` | `840ec8b0eba4` | not measured on 8 GB |
| After: one model at a time | 5 | 5,441 MiB / 5,476 MiB | 8,092 / 8,180 | 11,982 / 12,283 | 11,950 / 13,281 | 4 of 6 first run, 24 of 36 over all runs | 0 | `npm run bench:e2e` | `840ec8b0eba4-dirty` | not measured on 8 GB |

The target stated before measuring (TD-66) was a median peak of at most 5,120 MiB, the question set no worse than 24 of 36 over all runs and 4 of 6 on the first run, and a median per-question total of at most 12,500 ms. The median peak went from 6,307 MiB to 5,441 MiB, a fall of 867 MiB (13.7 percent). Each median is the median of the 5 in-session runs; the run after a Chrome restart is a separate row and is not in it. Differences and percentages are computed from the exact medians (the exact fall is 866.7 MiB, shown as 867 MiB) and then rounded, so a difference can differ by 1 MiB from the subtraction of the two rounded medians. The target was missed for memory; the question set was not worse than the floor; the time guard was reached (median per-question total 11,950 ms, against 9,391 ms before). Not measured on 8 GB.

| Machine | Run kind | Runs | Time to first token, ms (median / worst) | Total, ms (median / worst) | Peak memory: Chrome process tree (median / worst) | JS heap peak (median / worst) | Worker WebAssembly memory peak (median / worst) | Requests after offline | Command | Commit | 8 GB laptop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Apple M5 Pro 48 GB | one session | 5 | 8,092 / 8,180 | 11,982 / 12,283 | 5,441 MiB / 5,476 MiB | 36 MiB / 51 MiB | 2,241 MiB / 2,241 MiB | 0 | `npm run bench:e2e` | `840ec8b0eba4-dirty` | not measured on 8 GB |
| Apple M5 Pro 48 GB | after a Chrome restart | 1 | 8,397 / 8,397 | 12,385 / 12,385 | 5,228 MiB / 5,228 MiB | 33 MiB / 33 MiB | 2,241 MiB / 2,241 MiB | 0 | `npm run bench:e2e` | `840ec8b0eba4-dirty` | not measured on 8 GB |

Question set (seven fixed questions over a synthetic three-page policy, results not selected): 4 of 6 correct with the correct source page on the first run; 24 of 36 over all 6 runs; the question with no answer was refused in 6 of 6 runs.

Cited source page correct in 24 of 36 answerable rows (a refused answer cites nothing, so it never counts). Top-ranked retrieved passage on the right page in 36 of 36 (retrieval quality, reported on its own).
<!-- bench:end -->
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
- **Not measured on 8 GB.** Every figure here is from an Apple M5 Pro with 48 GB. Nothing has run on Windows. Sprint 6 cut the Chrome process-tree peak during a question <!--fig:cut-->from a median of 6,307 MiB to 5,441 MiB (worst 5,476 MiB; median of the 5 in-session runs)<!--/fig--> by holding one model at a time, but the target of at most 5,120 MiB was **missed**, so there is still a reason to expect trouble on
  8 GB: the answer model alone holds about 2,241 MiB of WebAssembly memory while it answers. The sum counts a page shared between processes in each of them, so it overstates the memory
  used; whether the demo fits an 8 GB Windows laptop is exactly what the runbook run above measures.
- **Every question loads the embedder and then the answer model again from this device (Sprint 6).** Holding one model at a time is what lowers the peak, and its price is time: <!--fig:time-->the median per-question total went from 9,391 ms to 11,950 ms (worst 13,281 ms)<!--/fig-->, and the two loads of one question take about 2.3 seconds in all (2,180 and 2,395 ms in the two Stop-then-Ask
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
- Tested in Chrome only (Playwright channel `chrome`). Firefox and Safari are untested. CI runs `npm run ci` (formatting, types, unit tests and a stub build) on three operating systems; the browser, end-to-end, gate and benchmark runs need the sibling builds and the 754 MiB model bundle, so they run locally and on the owner's laptop, never in CI.
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
`src/contracts/` are vendored from `runtime/spec` (spec release 0.5.0) and are never edited here: `npm run sync-contracts`.
