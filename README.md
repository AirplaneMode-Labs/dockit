# dockit

Offline document intelligence kit: an installable web app that answers a question about a PDF with a small local model, entirely
in the browser tab. Built from the Airplane Mode Labs libraries (pagetriage, glyphsift, localdata, runtime).

## Status

Sprint 5 (18 Nov 2026): Working: ask a question about a PDF and read an answer from a small local model (Qwen3-0.6B, WebAssembly) with the source
pages shown; page triage (pagetriage), text-layer extraction (pdf.js in its own worker), a glyph gate for Devanagari text (glyphsift) with the reason
shown when a passage is held back, chunks and vectors in localdata, and a capability card; scanned, oversize, corrupt and encrypted files and a missing
or tampered model are refused in plain words; after the one-time model download no request leaves the page (proved on a local build in installed
Chrome on an Apple M5 Pro 48 GB, not measured on 8 GB; the live page changes only after the owner pushes). Not yet: OCR, a Windows or 8 GB figure, the
pilot model (Qwen3-1.7B), a real signing key, WebLLM (cut), multi-document chat.

Done-when: build done on Apple M5 Pro 48 GB; 8 GB Windows done-when NOT met (owner runbook step 5). The one machine used for every figure in this
repository is an Apple M5 Pro with 48 GB; nothing has been measured on an 8 GB Windows laptop.

## What it does

1. **Choose or drop a PDF.** The file stays in the tab; nothing is uploaded. A file over 20 MiB is refused before it is read.
2. **Triage** each page with pagetriage (WebAssembly, in the analysis worker): encrypted files and files over 300 pages are refused, and each page is
   routed by its text-layer state (text, an OCR layer under an image, or an image only). A page that pagetriage had to cut short at one of its stream
   or content limits (a decompression bomb) refuses the whole file as `too_large`: "A part of this PDF is larger than dockit will unpack, so it was
   not read." It is never reported as a scanned file.
3. **Extract** the text layer with pdf.js (`pdfjs-dist`, in a fresh worker per document, hardened: no eval, no XFA, no fonts, no range or stream, only
   `getTextContent`, never render, annotations or scripts; a 60 second timeout terminates the worker).
4. **Chunk** deterministically (the text is first made well-formed: an unpaired surrogate, which pdf.js can emit from a broken ToUnicode map, becomes
   U+FFFD, because the gate, the embedder and the store all refuse an ill-formed string; target 700, at most 1,000 UTF-16 units, overlap 100, at most two pages per chunk, split at a blank line, a danda, a
   sentence end or a newline; a chunk of at least 200 units closes at a page boundary so a citation names the page the text is on).
5. **Gate** each chunk with glyphsift's `gate()` (analysis worker). A chunk it holds is not indexed, and the reason (`held_low_score`, with its score
   and the threshold in parts per million) is shown. Text the gate has nothing to say about (Latin text, no letters) passes marked `not_scored`.
6. **Embed** `passage: <text>` in batches of 32 through the runtime worker host (multilingual-e5-small, 8-bit, 384 dimensions), store chunks and vectors
   with localdata in a namespace of their own (`dockit.d<docId>`, in memory unless you choose to keep the document), and **retrieve** the four nearest
   chunks to `query: <question>`. If the embedder or the store refuses a single passage on its own, that passage is set aside (it is shown as not
   indexed, reason `not_analysed`, with its page) and the rest of the document goes on. A failure that is not about one passage (an integrity failure,
   an unsupported profile) still stops the document with its own message, and so does a document in which no passage could be embedded or stored.
7. **Answer** with Qwen3-0.6B (8-bit, single-threaded WebAssembly) from a fixed system message and the retrieved chunks wrapped as
   `<source id="S1" page="2">...</source>`. Retrieved text is untrusted: special tokens, tag characters, bidi controls, `<source` and `[S<n>]` are
   removed before it reaches the model. The answer is rendered as one text node; citations `[S1]` to `[S4]` map to the retrieved chunks' own page
   metadata, and a citation the model invents (`[S9]`) is dropped and counted. **Stop** ends the answer: a Stop before the first token shows
   "Stopped." with no answer text, a Stop after it keeps the words written so far, and the next question first loads the model again from this
   device (see Limitations).

A capability card shows the runtime's profile (gpu, ramGb, storageFreeGb, cores, backendTier, with the note that `ramGb` is the rounded memory the browser reports through `navigator.deviceMemory`, not free memory) and the
verdict against the model's minimum. Every refusal has a plain-language message (a scanned PDF reads "This PDF has no text layer (it looks scanned).
OCR is not yet supported.").

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

Live demo: <https://airplanemode-labs.github.io/dockit/> (built from `main` by `.github/workflows/pages.yml`). **The live page changes only after the
owner pushes**, and it works only after the first run of `pages.yml` is green: that first deploy is the only real check of the GitHub Pages size and
deploy-timeout limits for a 754 MiB bundle. Until then the live page shows an earlier sprint; this sprint's page is proven on a local build served
under `/dockit/` by a server that answers 404 for every other path.

The page has a box titled "What this demo does not do yet". It shows a build id: `Built from main at <sha12>` from CI, or `Local build <sha12>[-dirty]`.

## Benchmarks

Every row names its machine, the command and the commit. Peak memory is the peak summed resident size of the test Chrome's process tree; the JS heap
and the workers' WebAssembly memory are different figures under their own names. **Not measured on 8 GB**: the last column says so in every row, and so does the `laptop_8gb` column of both CSVs.

**Requests after offline = 0 counts application requests:** the ones made by the page, its workers and its service worker (a Chrome DevTools
Protocol counter over every target). The browser itself may still check `/dockit/sw.js` for an update and fetch the favicon; this count does not include
those two requests, and dockit's code makes neither of them.

<!-- prettier-ignore-start -->
<!-- bench:start -->
| Machine | Run kind | Runs | Time to first token, ms (median / worst) | Total, ms (median / worst) | Peak memory: Chrome process tree (median / worst) | JS heap peak (median / worst) | Worker WebAssembly memory peak (median / worst) | Requests after offline | Command | Commit | 8 GB laptop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Apple M5 Pro 48 GB | one session | 5 | 7,763 / 7,898 | 9,337 / 9,497 | 6,535 MiB / 6,628 MiB | 11 MiB / 37 MiB | 2,574 MiB / 2,574 MiB | 0 | `npm run bench:e2e` | `4bc19e9ae858-dirty` | not measured on 8 GB |
| Apple M5 Pro 48 GB | after a Chrome restart | 1 | 7,892 / 7,892 | 9,490 / 9,490 | 6,410 MiB / 6,410 MiB | 34 MiB / 34 MiB | 2,574 MiB / 2,574 MiB | 0 | `npm run bench:e2e` | `4bc19e9ae858-dirty` | not measured on 8 GB |

Question set (seven fixed questions over a synthetic three-page policy, results not selected): 4 of 6 correct with the correct source page on the first run; 24 of 36 over all 6 runs; the question with no answer was refused in 6 of 6 runs.

Cited source page correct in 24 of 36 answerable rows (a refused answer cites nothing, so it never counts). Top-ranked retrieved passage on the right page in 36 of 36 (retrieval quality, reported on its own).
<!-- bench:end -->
<!-- prettier-ignore-end -->

The CSVs (`docs/benchmarks/e2e.csv`, `e2e-questions.csv`) hold every run; none was left out. `e2e-questions.csv` keeps two page columns apart: `correct_source_page` is
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
- **Not measured on 8 GB.** Every figure here is from an Apple M5 Pro with 48 GB. Nothing has run on Windows. The figures give a reason to expect trouble on 8 GB: during a question the summed resident size of Chrome's processes peaked near 7 GB and the two engine workers held about 2.5 GiB of WebAssembly memory (the answer model and the embedding model are both loaded). The sum counts a page shared between processes in each of them, so it overstates the memory used; whether the demo fits an 8 GB Windows laptop is exactly what the runbook run above measures.
- **Stop ends the engine worker, so the next answer first loads the model again from this device.** The runtime's worker host terminates the worker on an abort
  (backend adapter R8). dockit then loads the models again through the same path as the first load (the stored manifest is re-verified, the files are read from
  the cache and hashed in the worker; nothing is downloaded and the page is not reloaded), the model card reads "Loading the model again from this device..." and
  Ask stays disabled until it is done. A Stop before the first token shows "Stopped."; a Stop after it keeps the partial answer. Measured on the Apple M5 Pro
  with 48 GB in Chrome 157 (the model card's time in "loading" in five Stop-then-Ask runs of `npm run test:e2e`, which prints each one): 1,683 to 1,936 ms, about 1.8 seconds. **Not measured on 8 GB**: the
  model bundle is 754 MiB, so expect longer there.
- **Hindi quality not measured.** The glyph gate is tested on synthetic Devanagari text layers (one clean, one damaged); answers over Hindi documents are
  not evaluated. English synthetic fixtures are the only question set.
- No real signing key: the manifest is signed by a key that exists only inside the build that made the page, so a visitor learns that the manifest and the
  bundle belong together, not who published them (pre-pilot rows 1 and 2 are the owner's).
- No WebLLM (cut, TD-08), no multi-document chat, no encryption at rest. The CSP is delivered by a meta tag, which cannot set `frame-ancestors`; a framed
  copy shows only a link to open dockit directly.
- Tested in Chrome only (Playwright channel `chrome`). Firefox and Safari are untested. CI runs `npm run ci` (formatting, types, unit tests and a stub build) on three operating systems; the browser, end-to-end, gate and benchmark runs need the sibling builds and the 754 MiB model bundle, so they run locally and on the owner's laptop, never in CI.
- Chrome 157: a model file written less than about a second ago can fail its first read by the engine; the load is retried once after 1.5 s (`LOAD_RETRY_PAUSE_MS`). The cause is not understood and is not fixed in dockit.
- pdf.js drops U+200C and U+200D from the text it extracts, so a joiner in a text layer never reaches dockit.
- **A hostile PDF that hides a very large compressed font or image can still exhaust the tab's memory; stream accounting across fonts and images is planned (Sprint 6).**
  pagetriage's own limits stop a content stream that inflates past its cap (refused as `too_large`, above), but a compressed font file or image is
  not counted by dockit. Observed on 18 Nov 2026 with a font-bomb fixture (a text page whose embedded TrueType font file inflates to 1 GiB + 1, generated at test time, not committed), opened once in
  installed Chrome 157 on the Apple M5 Pro 48 GB against the local build: it was accepted, not refused (pdf.js warned that the font has no `loca` table and
  read the page's text; 1 page, 1 passage indexed), the page stayed usable and answered a question afterwards, and the peak summed resident size of
  Chrome's processes during the 0.8 second open was 8,275 MiB, against 6,195 MiB idle before it (model loaded) and 7,221 MiB idle after it (one run,
  two samples while it ran: an observation, not a measurement of the worst case). Not measured on 8 GB.
- The first deploy of `pages.yml` is unproven: the Pages size and timeout limits for a 754 MiB artifact are checked only by the first real run.

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
