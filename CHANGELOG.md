# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The first dispatch of the manual Windows benchmark (`bench-windows`, run 44651054609 on `f886506`) failed on all four legs, at its first Windows step: the check of `dist-SHA256SUMS` ran
  `sha256sum --binary --check`, and GNU `sha256sum` (the one in Git for Windows' bash, and in ubuntu) refuses `--binary` and `--text` together with `--check`
  ("meaningless when verifying checksums"). The macOS `sha256sum` accepts them, so the workflow's own test pinned the string. The check is now `sha256sum --check --strict --quiet` (each line's
  `*` marker, written by the build job, sets the binary mode) plus a test that no line lacks the `*`; a new test runs that line on the machine's real `sha256sum` (GNU on the ubuntu and windows
  legs of CI) against a tampered file. Nothing after that step had run, so `run-capped.ps1`, the Job Object and the benchmark are still unproven on Windows. (D5-03)
- `scripts/win/run-capped.ps1`, before its first run: every path is absolute (a .NET call resolved a relative one against another directory than PowerShell's), reading the log is never fatal, a
  benchmark that outlives 80 minutes (the workflow's job limit is 90) is stopped with its children and leaves `job-summary.json` (exit 124, `timedOut`), and an unexpected error is recorded in
  the summary, the log and the exit code (5, `scriptError`) instead of ending the step without either. PowerShell's own parser now reads the script and the workflow's two pwsh steps in the tests
  (skipped without pwsh). (D5-03)
- The harness: a `DevToolsActivePort` with CRLF line endings no longer leaves a carriage return in the debugging URL, and Chrome gets 120 s, not Playwright's 30 s, for its first start on a cold
  VM (no figure depends on it). (D5-02)

## [0.4.0-dev] - 2026-11-20 (untagged)

Sprint 7 (an addition the owner asked for on 19 Nov 2026; theme: release readiness, TD-102; version 0.4.0-dev, TD-107; private, never published to a registry, not tagged). Every figure is from the
Apple M5 Pro 48 GB and is not measured on 8 GB. Nothing about what the page does changed in this sprint; the work is the benchmark, its CI and its documents.

### Added

- The manual Windows benchmark, written and **not yet run** (B6, TD-113): `.github/workflows/bench-windows.yml` (`workflow_dispatch` only, no input, a fixed matrix of no limit, 8, 6 and 5 GiB; an ubuntu job builds `dist`
  and hands it over for one day with a `dist-SHA256SUMS` list that the Windows job checks; results uploaded with `if: always()` for seven days), `scripts/win/run-capped.ps1` (a Windows Job Object with a committed-memory
  limit around the pwsh, node and Chrome process tree, a few lines of C# through `Add-Type`, documented kernel32 calls only, the 144-byte struct size asserted before any call, Chrome's membership of the job checked every
  2 seconds) and `scripts/win/README.md` (what only the first run can prove). `test/win-jobobject-text.test.ts` is a static check of the script's text. (D5-03)
- `--environment "emulated: <what was run>; not a laptop"` for `bench:e2e`: the machine of every row is that label (never the word laptop outside its suffix, never an 8 GB figure), a CI runner without one is refused, the emulated
  columns (`environment`, `job_commit_limit_bytes`, `job_commit_peak_bytes`, `process_commit_peak_bytes`, `job_escapes`, `sampler_median_interval_ms`, `failure_reason`) go in separate files
  (`e2e-emulated-win-vm.csv`, `e2e-emulated-win-vm-questions.csv`), `e2e.csv` is never written in that mode, and `laptop_8gb` still reads `not measured on 8 GB`. `scripts/bench-emulated-merge.mjs` fills the job columns
  from `job-summary.json`; the README gains an "Emulated Windows (not a laptop)" subsection only when the emulated CSV exists. (D5-02)
- A crash or an out-of-memory fails a run within seconds with a reason (`scripts/lib/fail-fast.mjs`: `renderer_crash`, `browser_disconnected`, `worker_crash`, `out_of_memory`), races with every long wait of the harness, keeps the
  rows written so far and exits 1; proved with simulated crashes in unit tests and a real `chrome://crash` in installed Chrome (`npm run test:failfast`, under 10 seconds). (D5-02)
- The Windows sampler records the commit size (`PrivatePageCount`) next to the working set, writes UTF-8 without a byte-order mark, skips a null command line as a match, and reports its tick count and median interval. (D5-02)
- `scripts/verify-model-cache.mjs`: a restored model cache is re-hashed against runtime's committed pins before anything uses it, and a mismatch stops the job. (D5-03)
- `--dist <dir>` for `bench:e2e`; `launchOptions({ sandbox })` in the harness (the emulated run keeps Chrome's sandbox on). (D5-02)
- Tests: the Playwright launch arguments hold none of the sandbox-weakening flags, the static server binds 127.0.0.1 only, no release key is in the application trust set (R4, S1-127), the workflow rules of `bench-windows.yml`,
  the issue forms and the README's first screen. (D5-02, D5-03, D5-06)
- Issue forms (a required "no real document" checkbox, a link to `SECURITY.md`, blank issues disabled), `docs/release.md` ("never published to a registry; the Pages deploy is the release", TD-117, TD-120), the
  `Live demo:` line in the first screen of the README (TD-116). (D5-06)

### Changed

- `docs/benchmarks/e2e.csv` and `e2e-questions.csv` are the Sprint 6 build re-measured on a quiet machine (TD-101): dockit commit `4e6654f9e4ed`, built from fresh clones at the locked sibling commits, no `-dirty`. The median
  Chrome process-tree peak is 5,436 MiB (Sprint 6's committed run: 5,441 MiB); the 5,120 MiB target is still **missed**; the question set is 24 of 36; the median per-question total is 11,304 ms. (D5-00)
- Re-vendored spec release 0.6.1 (manifest 0.1.4, event 0.1.6, storage API 0.4.1; the other three contracts unchanged) from the digests of `LANDED.json`; `sync-contracts` reads them when `SPEC-LANDED.txt` is prose, and a
  header that names an older contract version is drift. (D5-07)
- The Sprint 7 status line and the "does not do yet" box: the emulated Windows figure is pending its first run. (D5-06)
- Build tools (Dependabot #4 and #3, TD-112): vite 7.3.7 to 8.3.8 and @vitejs/plugin-react 5.2.0 to 6.3.0, applied together (plugin-react 6 needs vite 8): the lock moves 70 packages out (rollup and its platform packages, babel) and 35 in
  (rolldown, lightningcss and their platform packages), nothing else; the dist CSP is byte-identical to `4e6654f` and the precache list is the same 205 entries in kind. The Node floor is 22.12 (`engines`, README), as the new tools require. (D5-05)
- `scripts/check-lock-optionals.mjs` (with `scripts/lock-install-scripts.allow.json`): the lock stays hash-pinned, every native optional family has linux-x64-gnu, darwin-arm64 and win32-x64-msvc, and a new install-script package needs a named acceptance. (D5-05)

### Fixed

- The host-load columns are empty on Windows (`os.loadavg()` is always 0 there). (D5-02)

### Security

- Playwright adds Chrome's sandbox-off switch to every launch unless told not to: the emulated Windows run asks for the sandbox, the local default is unchanged and the README says so. (D5-02)
- The bench-windows workflow has `contents: read` only, no secret, no input, a restore-only cache, a one-day artefact and every action pinned to a 40-hex SHA from the conventions table. (D5-03)

### Deferred

- `vitest` 5.1.0 (npm 10.9.8 crashes resolving its peers: `Cannot read properties of null (reading 'edgesOut')`), `typescript` 7.0.2 and `@types/node` 26.6.6 (TD-112); the reasons are in `dependabot.md` of the sprint evidence.
- The private-repository 2 vCPU, 8 GB Windows runner (an owner option, not built), and importing the first emulated results (a follow-up after the dispatch).

## [0.3.0-dev] - 2026-11-19 (untagged)

Sprint 6, build work started early on 19 Nov 2026 (version 0.3.0-dev, TD-69; private, not published, not tagged). Every figure is from the Apple M5 Pro 48 GB and is not measured on 8 GB.

### Added

- One model at a time (B1 M1, TD-66): `src/model/model-pool.ts` loads the embedder for the ingest, then per question the embedder and then the answer model, and unloads each (its worker
  is ended, backend adapter R16) before the next loads. Every load is a first load (R19): the stored manifest is re-verified, the files are acquired from the device only and re-hashed
  in the worker, with no "already verified" flag. Unit tests: at most one engine over an ingest and seven questions, the fixed order, a failed unload still releases, the verify counter
  (8 embedder and 7 generator verifies for 7 questions, `cacheOnly` on every acquire). `test:e2e` samples the worker targets every 100 ms (never more than one) and checks the order of
  `model.load` and `model.unload`. (D5-03)
- The memory line (B1 M6, TD-67, TD-84): the threshold is read from the verified manifest's answer entry (`minProfile.ramGb`), never from a constant in the page (the UI constant in
  `wiring.ts` is gone). The capability card states the line and the reported value; below the line a load is refused with `unsupported_profile` after the manifest is verified and before
  any model byte is read; a browser that reports no memory is not below it. A usability guard, not a security control. The out-of-memory failure of the engine is its own plain refusal
  (`out_of_memory`); what the engine said never reaches an event or the screen. (D5-03)
- Stream accounting before pdf.js (S1-107, TD-70, TD-85): `account_pdf_streams` (pagetriage) runs in the analysis worker right after the read stage, with no options; a limit refusal is
  `stream_limit` with a plain sentence per kind, anything the accounting cannot vouch for is `corrupt` with "This PDF's structure could not be checked safely, so it was refused before it was
  opened." (an encrypted file keeps its own refusal). Bombs generated at test time (font, image, a broken cross-reference table) are refused with no pdf worker and no extract event; the
  measured peaks are in the README. (D5-06)
- The bytes that triage judged are the bytes pdf.js opens (B1 M3): the one buffer goes to the analysis worker by transfer and comes back; the read stage records its length and SHA-256 and the
  extract stage refuses (`corrupt`) on a mismatch; the file is read once. The analysis worker and the pdf worker are ended as soon as their stage ends. (D5-03)
- `docs/benchmarks/e2e-s6-baseline.csv` and `e2e-questions-s6-baseline.csv` (the pair taken before the measures, TD-77), a before and after table in the README built from both pairs by
  `scripts/bench-readme.mjs`, and `B1-result.md`'s outcome in the README: the median peak went from 6,307 MiB to 5,441 MiB; the 5,120 MiB target was **missed**; the question set stayed at 24 of 36
  and 4 of 6; the median per-question total rose from 9,391 ms to 11,950 ms (guard 12,500 ms). (D5-02, D5-04)
- `wasmMemoryPeak` in the benchmark harness is the most WebAssembly memory the workers held at once; with one model at a time a sum over every load would count loads that never coexisted. (D5-04)
- Re-vendored spec release 0.6.0 (manifest 0.1.3 with `weak_key_refused`, capability profile 0.1.1, event 0.1.5, storage API 0.4.0, backend adapter 0.5.0). The stub trust root (an all-zero key)
  is a small-order point that a 0.1.3 verifier refuses; the stub keeps it, and a test proves with independent Ed25519 arithmetic that it is weak and that the stub runtime can never verify anything. (D5-07)

- `bench:e2e` writes the 1-minute load average at the start and end of every run (`host_load_1m_start`, `host_load_1m_end`, two trailing columns of `e2e.csv`; `e2e-questions.csv` is unchanged), and the README, `B1-result.md`
  and the site page say that process-tree peaks are comparable only between runs on a quiet host. The baseline CSV is not rewritten and every reader accepts a CSV without the two columns. No product code changed. (BUG-T1-S6-05)

### Changed

- The embedding batch is 8 passages, not 32 (B1 M4): kept because the fixed question set and the top-ranked-passage column did not change. (D5-03)
- `pipeline.answer` has the outcome `aborted` for the user's Stop, with no reason (S1-119, event 0.1.5). A Stop after the first token logs it with the first-token time next to the runtime's one
  `model.generate` with finishReason `abort`; a Stop before the first token logs it too, with no `model.generate` and no first-token time, and never `skipped` or `error` (BUG-T1-S6-03). (D5-05)
- One rounding rule for every memory figure: the README table, the status line and the tests all take the exact median and round once, through `scripts/memory-figures.mjs`
  (used by `scripts/status-line.mjs` and `scripts/bench-readme.mjs`), so a printed fall can differ by 1 MiB from subtracting two rounded figures (BUG-T1-S6-04).
- The not-yet box and the Limitations say what the memory line and the stream accounting are not, what a question now costs in time, and the measured outcome of the font bomb. (D5-10)
- `deps.lock.json` and `NOTICE` name the pushed pagetriage head `eb28e49` (a test-only fix of 18 Nov); the wrap-up writes the Sprint 6 sibling commits. (D5-02)

### Fixed

- Part A (D5-01): the status line, the not-yet box and the README no longer say that the live page changes only after the owner pushes; the page has been live since the owner's push of 18 Nov 2026
  (`pages.yml` deployed the roughly 800 MB bundle twice), and a later sprint's page reaches it only when the owner pushes it. The README no longer calls the first Pages deploy unproven.
- An engine load on a browser that does not report its memory was refused by the runtime's own `minProfile` check (it reads `ramGb` 0 as below every line), against TD-84. dockit first handed the
  adapter a profile whose unknown memory was the line itself (`profileForAdapter`); once `satisfies()` in the runtime was fixed so that an unknown value is not below a line, that workaround was
  removed and dockit passes the reported profile unchanged. A reported value below the line is still refused. (D5-03, BUG-T1-S6-02)

### Security

- S1-107 is closed for the font and image cases and the structure cases above (a font bomb peaked at 3,056 MiB against 8,121 MiB in Sprint 5). pdf.js's own inline-image and Type 3 decoding stay
  documented residuals. (D5-06)
- The memory line is a usability guard, not a security control; it can be overridden by a user. (D5-03)

## [0.2.0-dev] - 2026-11-18 (untagged)

Sprint 5 and the earlier sprints (pushed on 18 Nov 2026), as they were written.

### Added

- Sprint 5 (18 Nov 2026, committed, not pushed; version 0.2.0-dev): the real pipeline. A PDF goes through pagetriage (WebAssembly, analysis worker), text-layer
  extraction with pdfjs-dist 6.5.438 (hardened, a fresh worker per document, 60 s timeout), chunking, the glyphsift gate (`gate()`, default threshold
  975000 ppm, the reason shown when a chunk is held), embeddings through the runtime worker host (multilingual-e5-small), localdata documents (namespace
  `dockit.d<docId>`, memory by default, an opt-in to keep a document with Delete removing it physically), retrieval (k = 4) and an answer from Qwen3-0.6B
  (8-bit, single-threaded WebAssembly) with the retrieved chunks and their page numbers as sources. Retrieved text is untrusted: a sanitiser removes
  special tokens, tag characters, bidi controls, `<source` and `[S<n>]`; citations map to chunk metadata and an invented `[S9]` is dropped. Refusals in
  plain words: not a PDF, over 20 MiB (before the file is read), too many pages, encrypted, corrupt, no text layer ("OCR is not yet supported"),
  timeout, model not cached, manifest refused (with its reason), integrity, framed. (D5-05, D5-06)
- Capability card wired to the runtime profile (`detectCapabilities()`, the 8 GB note and the verdict against the model's minimum). (D5-06)
- `scripts/assemble-deps.mjs` and `deps.lock.json` (TD-40): the four sibling builds from pinned commits, `vendor/PROVENANCE.json`, a stub mode for CI
  (`DOCKIT_DEPS=stub`, `npm run build:check`), and a `pages.yml` that checks the siblings out at the locked commits, builds the signed model bundle and refuses
  a `dist/` over 1 GB (1,000,000,000 bytes). `npm ci --ignore-scripts` everywhere; per-job permissions; no secrets. (D5-04)
- The model bundle (about 754 MiB) is verified against a manifest signed by an ephemeral in-memory key whose public half is compiled in
  (`dev.airplanemode.dockit-models`, pinned with `expectManifestId`, every entry under `models/`); the verified manifest is stored (IndexedDB) and
  re-verified on every load, so the offline restart works. (D5-06)
- The exact CSP (default-src 'none', `worker-src 'self' blob:`, three Trusted Types policies), pinned by `test/csp.test.ts`; the service worker is
  registered with the scope of the document base, serves navigations from the verified precache, and passes `models/`, `blob:` and `data:` through. (D5-07)
- `scripts/make-fixture-pdfs.mjs` (deterministic, `--check`) and `test/fixtures/pdf/`: `policy-3p.pdf`, `injection.pdf`, `scanned.pdf`, `corrupt.pdf`,
  `encrypted.pdf`, `deva-clean.pdf`, `deva-noised.pdf`; `test/fixtures/questions.json` (seven fixed questions). The oversize file, the 301-page file and the
  decompression bomb are generated at test time. (D5-08, D5-10)
- `npm run test:e2e` (the offline proof in installed Chrome with a CDP request counter over every target), `npm run test:gate` (the Devanagari gate with real
  pdf.js and the real glyphsift WebAssembly) and `npm run bench:e2e` (at least 5 runs and a restart run, with process RSS, JS heap and WebAssembly memory under
  their own names). Local only. (D5-08, D5-10)
- `NOTICE` and `public/THIRD-PARTY-NOTICES.txt` list pdfjs-dist, transformers.js, ONNX Runtime Web, Qwen3-0.6B and multilingual-e5-small with source repository and
  pinned revision. (D5-09)
- Fix round 1 (18 Nov 2026): an end-to-end test of data at rest (`test/e2e.spec.ts`): with "Keep on this device", Delete followed by a reload leaves 0 files under
  `__ld_doc.dockit.d<docId>`, no `dockit.kept` row and an empty kept list (also when deleted from the kept list after a reload); by default OPFS and IndexedDB hold
  no document namespace and the IndexedDB database `dockit` holds only the manifest store. Run against a build with `clear(ns)` stubbed out it fails. (D5-FIX1-16)
- `laptop_8gb` column in `docs/benchmarks/e2e.csv` and `e2e-questions.csv`: every row reads `not measured on 8 GB`; `scripts/lib/bench-columns.mjs` refuses to write a row
  without it and `bench-readme.mjs` refuses to build the README table from one. (D5-FIX1-06)
- `test/helpers/tamper.ts`: aimed tampering with the manifest (a whitespace-tolerant lookup of a sha256 value, one hex digit changed) with `assertWellAimed`, which fails a
  tamper test whose flipped byte is not a hex digit inside a hash or leaves the file unparseable. (D5-FIX1-02)

### Changed

- Re-vendored the runtime contracts at spec release 0.5.0 (manifest 0.1.2, event 0.1.4, storage API 0.3.0, backend adapter 0.4.0; capability profile 0.1.0
  and model descriptor 0.2.1 unchanged). The in-memory store of the earlier skeleton is gone: localdata's memory driver replaces it.
- The skeleton's stage stubs, `MockAdapter` and the planned-model card are removed.
- A chunk of at least 200 units closes at a page boundary and no overlap crosses a page boundary, so a citation names the page the text is on.
- `index.html` CSP: from the Sprint 3 policy to the Sprint 5 one (see Added).
- The capability card note no longer says that browsers cap the reported memory at 8 GB (Chrome 157 reports 32 on a 48 GB Mac): it says that `ramGb` is the
  rounded memory the browser reports through `navigator.deviceMemory`, not free memory. The contract wording is reconciled in the next spec patch (TD-57). (D5-FIX1-05)
- `pages.yml` refuses a `dist/` over 1,000,000,000 bytes (GitHub's documented 1 GB limit for a Pages site), not 1 GiB. (D5-FIX1-17)
- The "Keep on this device" warning now also says what a kept document holds (chunk text, embeddings, page numbers and the SHA-256 of the file, all unencrypted) and that the
  hash can confirm whether a known document was processed. (D5-FIX1-17)
- A passage that the embedder or the store refuses on its own is set aside (reason `not_analysed`, shown with its page and a plain message) and the rest of the document is
  indexed; a document in which no passage could be embedded or stored still fails with the first error. Systemic failures (integrity, profile, abort) still stop the document. (D5-FIX1-09)
- The README and the benchmark page say what "requests after offline = 0" counts (application requests from the page, its workers and its service worker; the browser's own
  check of `/dockit/sw.js` and the favicon fetch are not in it), and the by-hand PowerShell memory sampler hands its loop to the child in single quotes. (D5-FIX1-07, D5-FIX1-10)
- `docs/benchmarks/e2e.csv` and `e2e-questions.csv` re-measured with `npm run bench:e2e` on commit `0282d19da192`, built from a fresh clone at the locked sibling
  commits as `pages.yml` builds it, so the commit column is a clean SHA (it read `4bc19e9ae858-dirty`); the README table is regenerated from them. The commit that
  adds them changes no code. Apple M5 Pro 48 GB, not measured on 8 GB.

### Security

- Output sinks: the answer is one text node (`white-space: pre-wrap; unicode-bidi: plaintext`), tag characters and bidi controls are dropped, there is no
  markdown, no auto-linking and no href from model or PDF text; a test forbids the DOM sinks listed in the README.
- A framed copy of the page shows only a link to open dockit directly (reason `framed`).

### Fixed

- Post-push CI fix (18 Nov 2026): `npm run ci` failed on windows-latest only, on two tests. (1) `assemble-deps.test.ts` expected `depDir('siblings', '/w', 'runtime')` to
  equal `join('/w', 'runtime')`, but `depDir` makes the folder absolute and on Windows that adds the drive (`D:\w\runtime`); the expectation now resolves the same way, and
  `depDir` takes the path module as an optional fourth argument so `path.win32` and `path.posix` cases (drive-less, own drive, forward slashes, UNC, relative `..`) run on any
  host. (2) the pdf.js fixture tests timed out at the 5 000 ms default on a cold runner (5 673 ms there, 115 ms locally); they, and the scratch-git assembler tests that
  sat at 36 % of the default, now carry explicit 30 s timeouts with the measurements in `test/helpers/timeouts.ts`, and the 3 s guard on opening a document is 20 s.
- A model load that failed with the engine code `backend` right after the download finished is retried once after 1.5 s (Chrome 157 does not always let the engine read a file written less than a second earlier; the cause is open). `download()` and `load()` turn a failed manifest fetch into the documented refusals (`model_not_cached`, or the stored manifest's own `manifest_refused`) instead of an unexplained error. (D5-06)
- The pdf and analysis workers are really terminated: `startModuleWorker`'s `terminate()` is called through a wrapper, not through an override of the Worker's own `terminate`, which had made the native terminate unreachable. (D5-05)

- `.gitignore` (and `.prettierignore`): the unanchored `deps/` rule swallowed `src/deps/`, so a fresh clone could not typecheck or build and `pages.yml` was red. The rule is
  now `/deps/` (the folder `pages.yml` checks the siblings out into); `src/deps/**` is committed, including the zero-key `src/deps/stub/trust-root.ts` (TD-58; a test pins its
  keyId to 64 zeros). Proved in a copy made from `git ls-files -co --exclude-standard`: `npm ci --ignore-scripts && npm run ci` exits 0. (D5-FIX1-01)
- The tamper cases of `test/e2e.spec.ts` now flip a hex digit of a sha256 value (they used `indexOf('"sha256":"') + 12` on a pretty-printed manifest, flipped a byte of
  `"spec"` and so tested the JSON parser): the refusal asserted is `no_valid_signature`, for the stored manifest (S-OFF-1) and for the server copy, and the parse failure is a case of its own. (D5-FIX1-02)
- A page that pagetriage cut short at a stream or content limit (a decompression bomb) refuses the document as `too_large` with "A part of this PDF is larger than dockit will
  unpack, so it was not read.", not as `no_text_layer` ("it looks scanned"). The README Limitations now say that a hostile PDF that hides a very large compressed font or image
  can still exhaust the tab's memory (stream accounting is planned for Sprint 6, S1-107) and record what S1's font-bomb fixture did in Chrome. (D5-FIX1-08)
- A lone surrogate in extracted text (pdf.js can emit one from a broken ToUnicode map) no longer reaches the gate, `embed()` and `putDocument()`: `normaliseText` applies
  `toWellFormed()` after NFC, and one refused passage no longer ends the whole document as a generic error. (D5-FIX1-09)
- `package-lock.json` root version is 0.2.0-dev, like `package.json`. (D5-FIX1-11)
- `src/trusted-types.ts` header names the three Trusted Types policies of the CSP, not one. (D5-FIX1-17)

- Fix round 2 (18 Nov 2026), Stop then Ask (BUG-T1-S5-R2-01): Stop ends the engine worker (backend adapter R8), and the next question used to be refused as `model_not_cached`
  ("The model is not downloaded...") although every file was on the device, until the page was reloaded. The controller now tracks whether the adapters are loaded: after an
  abort, or when a generate (or an embed) rejects `not_loaded`, the next use goes through the same load path again (`models.load()`: the stored manifest is re-verified, S-OFF-1,
  the signature and `expectManifestId` are checked, the files are read from the cache and hashed in the worker, R15), once. The model card reads `Loading the model again from this
device...` while it does, and Ask is disabled until it settles. A re-load that fails shows its own reason (`manifest_refused`, `integrity`), and `model_not_cached` only when the
  load says a file is really missing (`not_cached`, or no stored manifest). `not_loaded` is no longer mapped to `model_not_cached` by `mapAdapterError`. Tests: unit cases with
  fakes that end the engine on an abort, and two Chrome cases (Stop while streaming, Stop within 1 s) that then ask the grace-period question offline: 45, page 2, 0 requests,
  no download. (D5-FIX2-01)
- Stop before the first token is shown as `Stopped.` (BUG-T1-S5-R2-02): no answer text, no refusal, never `data-reason="corrupt"`. `pipeline.stage` generate and `pipeline.answer`
  carry outcome `skipped`; no new `PIPELINE_REASONS` value. The runtime's `AdapterError` is a different class from the vendored one, so errors are recognised by name and code
  (`isAdapterError`); `ADAPTER_OUTCOMES` maps every `AdapterErrorCode` to its intended refusal, stop or plain failure (a table test; a plain failure is `The answer failed.` with the reason
  `failed`, not `corrupt`). (D5-FIX2-02)
- `docs/benchmarks/e2e-questions.csv` has a new column `top_retrieved_page_ok` (BUG-T1-S5-R2-05, TD-59): `correct_source_page` is now true only when a CITED source shown to the user
  names the expected page, so a refused answer (which cites nothing) is no longer credited with a correct source page; retrieval quality is its own column. The headline
  figure keeps its definition (the answer holds the expected text AND `correct_source_page`). Both CSVs were regenerated by a fresh `npm run bench:e2e` (every row kept, none selected).
  The README table, the benchmark script and the site import changed with it. (D5-FIX2-04)
- The Sprint 4 history lines are dated: as of 14 Nov 2026, before the owner's push on 15 Nov. (T3-R1-05, D5-FIX2-05)

### Removed

- The Sprint 1 to 4 placeholder pipeline and its "Run placeholder pipeline" button.

### Added (earlier sprints)

- As of 14 Nov 2026, before the owner's push on 15 Nov: Sprint 4 (14 Nov 2026, committed, not pushed): re-vendored the runtime contracts at spec release 0.4.0
  (manifest 0.1.1, which is manifest spec v0.1 published in runtime/spec (committed; public after the owner's
  push); capability profile 0.1.0, event 0.1.3, storage API 0.2.0, backend adapter 0.3.1 and model descriptor
  0.2.1 are draft). `sync-contracts` checked every source file against SPEC-LANDED.txt first. (D5-01)
- `sync-contracts` finds SPEC-LANDED.txt in this order: env `SPEC_LANDED`, then the highest-numbered
  `<workspace>/evidence/sprint-<n>/D1/SPEC-LANDED.txt` that exists (compared as a number); no scratch path.
  Tests first: sprint-10 beats sprint-9 and sprint-4, a newer folder without the file is skipped, and the
  script names no scratch directory. (D5-01)
- `test/csp.test.ts` pins the `index.html` CSP byte for byte to the Sprint 3 value, with its sha256
  (`0ca84a34...`, from commit 5a4208b). (D5-01)
- The in-memory store implements the Storage API 0.2.0 interface: `query()` and `putVectors()` reject
  `not_implemented` naming Sprint 5 and `indexInfo()` resolves `undefined`; no index wiring. (D5-01)

- Re-vendored the runtime contracts at spec release 0.3.0 (draft, 2026-11-14): `event.ts` 0.1.2,
  `backend-adapter.ts` 0.3.0 and `model-descriptor.ts` 0.2.0; `manifest.ts`, `capability-profile.ts`
  and `storage-api.ts` stay 0.1.0 and byte-identical. `sync-contracts` checked every source file
  against SPEC-LANDED.txt first (log: `sync-after-spec.log`). (D5-07)
- `sync-contracts` finds SPEC-LANDED.txt in this order: env `SPEC_LANDED`, then
  `<workspace>/evidence/sprint-3/D1/SPEC-LANDED.txt`, then the local scratch fallback; an env value
  naming a missing file is an error, and any sha256 mismatch still fails with nothing copied. The
  tampered-hash tests stay; new tests cover the lookup order and the script's exit code. (D5-07)
- Answer card shows the Sprint 3 backend chain as a plan only, worded by runtime's LANDED.json:
  the worker engine is green, so the card says runtime runs its engine in a worker; WebLLM did not
  land, so it appears only as "no WebLLM rung yet (carried to Sprint 4)" in the not-yet box. dockit
  itself loads no model. A Trusted Types line in the not-yet box. (D5-03, D5-04, D5-07)
- `sync-contracts` verifies every source file against runtime's SPEC-LANDED.txt (sha256) and
  fails closed. (D5-01)
- Answer card showing the planned production model (Qwen3-1.7B, Apache-2.0; provisional until
  the Sprint 5 measurement; contingency Qwen3-0.6B), its sizes, source revision and the backend
  fallback chain, plus a feature-detection prediction labelled as such. No inference, no
  request, no `availability()` call; typed constants in `src/pipeline/model-plan.ts`. (D5-03)
- `test/csp.test.ts` pins the exact CSP string in `index.html`. (D5-02)
- Source hygiene test: no inference-engine import, no HTML injection API in `src/`. (D5-03)
- Vite + React + TypeScript installable PWA skeleton: web app manifest, generated maskable
  icons, offline page, strict content security policy delivered by a meta tag.
- Hand-written service worker (`public/sw.js`) with its routing rules in `src/sw-logic.ts`.
  Install precaches the list injected by `scripts/inject-precache.mjs`, verifying the
  SHA-256 of every entry before it is cached; activate deletes every other cache; fetch
  passes through non-GET, cross-origin, Range, `/assets/*` and `*/manifest.json` requests.
- Pipeline stubs typed against the vendored runtime contracts (`src/contracts/`): pdf,
  triage, extract, glyph gate, store and answer. Every stage returns a labelled placeholder;
  no document processing happens yet.
- In-memory event sink following the Event 0.1 schema, with the attrs privacy rules
  enforced in code (`src/pipeline/events.ts`).
- Vitest suites for the service-worker routing rules, the contracts sync and the pipeline;
  Playwright spec for the installed PWA (offline shell, offline page, cache bypass rules,
  cache rotation on a new build hash, same-origin requests only, CSP contents).
- CI on Linux, macOS and Windows with per-job permissions; Playwright on Linux only.
- Playwright cases proving that a tampered precache entry is refused at install (no worker,
  no controller, no cache) and that a precached file altered on the server after install is
  answered with a 503, not the altered body.
- `scripts/sync-contracts.mjs --check` reports in-sync or drift per vendored contract, writes
  nothing and exits 1 on drift, matching localdata's script; Vitest cases cover check mode,
  write mode and a missing source against a temporary directory.
- Public demo deployment: `.github/workflows/pages.yml` builds `dist/` with `npm run build` and
  deploys it to https://airplanemode-labs.github.io/dockit/ (`pages: write` and `id-token: write`
  on the deploy job only). The home screen now states that document processing is not built
  yet, renders the pipeline as a Stage / Status / Lands in table, adds live browser-requirement
  checks with the shared-origin note, a "What this demo does not do yet" box, the service
  worker's scope and controller state, the resolved base URL and a "Built from main at <sha>"
  line (`VITE_BUILD_SHA`, `local` for developer builds).
- Sub-path test `test/subpath.spec.ts`: dist/ copied under `<tmp>/dockit/` and served on port
  4191 by the shared `test/static-server.ts` (extracted from `pwa.spec.ts`); asserts the
  registration scope ends with `/dockit/`, every request and precache key stays under
  `/dockit/`, the manifest keeps relative `start_url` and `scope`, offline navigation and reload
  work, and the requirements box reacts to feature detection.
- `isStaleOwnCache()` in `src/sw-logic.ts` with Vitest cases: foreign caches such as
  `runtime-test` and `airplanemode-localdata` survive activation, `dockit-precache-old` is
  deleted, the current build cache is kept.
- `persist-credentials: false` on every `actions/checkout` step.

### Changed

- The chain sentence reads "runtime 0.2.0-alpha.1 runs the engine in a worker"; there is no WebLLM label in
  the chain, and the not-yet box says "a WebLLM rung (cut from Sprint 4)" (team decision TD-08). The
  `SPRINT3_LANDED` constant and its WebLLM branches are replaced by `RUNTIME_LANDED` (worker only) and
  `WEBLLM_NOT_YET`; the LANDED.json cross-check reads `LANDED_JSON` or the merged
  `evidence/sprint-<n>/D1/LANDED.json` files. (D5-01)
- The not-yet box no longer says localdata's OPFS driver is Sprint 4: the vector index is localdata's
  Sprint 4 work and dockit wires it in Sprint 5; the store stage is labelled Sprint 5. (D5-01)

- `test/pipeline.test.ts` no longer hard-codes the sprint scratch path: the LANDED.json
  comparison looks in env `LANDED_JSON`, then `<workspace>/evidence/sprint-3/D1/LANDED.json`,
  then the scratch copy, and still asserts the shipped constant when none is reachable, so a
  hosted CI run does not depend on a sibling checkout. (D5-07)
- `SPRINT3_LANDED` is `{ worker: true, webllm: false }`, copied from runtime's LANDED.json
  (worker green, WebLLM not landed). (D5-07)
- README: a Status section after the title (it had been folded into Demo), an Install note saying
  dockit is an application on GitHub Pages, not a registry package, and Contracts and Limitations
  updated for spec release 0.3.0. (T3-S3-015)
- `ci.yml`: the preinstalled-Chrome check first ran on GitHub on 9 Nov 2026; the comment no longer calls it
  "configured, not yet executed".
- Model card status is now the exact smoke-run sentence (`MODEL_LOADED_IN_BROWSER = true`); the
  card still never calls `availability()` and downloads nothing. README sections reordered to
  the conventions order, Status folded into Demo. (T1-S2-04, T3-S2-004)
- Re-vendored the runtime contracts at spec release 0.2.0 (draft) with a per-file version map in
  `scripts/sync-contracts.mjs`; `model-descriptor.ts` added, so six files are vendored. The local
  `MockAdapter` gains `device: 'wasm'` and `available()` returning true. (D5-01)
- The service worker's activate handler deletes only caches named `dockit-precache-*` from
  other builds instead of every cache on the origin, because all Airplane Mode Labs demos share
  the `airplanemode-labs.github.io` origin on GitHub Pages.
- `offline.html` says that dockit has no document processing yet and that the shell it links
  back to is a skeleton.
- `@vitejs/plugin-react` 5.2.0 instead of the pin-table 6.2.1 because 6.2.1 requires vite ^8;
  revisit with the vite 8 move.

### Fixed

- The built app shipped React and ReactDOM with no licence notice. `public/THIRD-PARTY-NOTICES.txt` now
  carries the verbatim MIT texts of react, react-dom and scheduler (each headed with name and version),
  is copied to `dist/`, is precached, is linked from the footer, and opens offline (a navigation to a
  precached non-shell file falls back to its own cache entry, not `offline.html`). (T3-S3-028)
- No committed script or test names a scratch directory any more: `sync-contracts.mjs` and the tests read
  `$SPEC_LANDED` and `$LANDED_JSON` (a missing file is an error), then `<workspace>/evidence/sprint-3/D1/`;
  a portability test guards it. (T3-S3-027, BUG-T2-S3-21)
- Model card loaded-once sentence now ends with the evidence citation, as in runtime/README.md. (T3-S2-R1-02)
- `offline.html` served for an uncached deep navigation (for example `/dockit/reports/42`)
  rendered unstyled because its relative `./offline.css` link resolved to
  `/dockit/reports/offline.css`. `decideRoute` now answers any `<scope>**/offline.css` GET
  cache-first from the precached `<scope>offline.css`; paths outside the scope and cross-origin
  requests still pass through. The page also carries `<link rel="icon" href="data:,">` and
  `img-src 'self' data:` so Chrome no longer probes `/favicon.ico` at the shared origin root.

### Security

- CSP gains `require-trusted-types-for 'script'; trusted-types dockit-sw`: one named policy, no
  `allow-duplicates`, no default policy; the service worker is registered with a TrustedScriptURL
  that only accepts the exact `./sw.js` URL. `form-action` stays `'none'`. Tests: `csp.test.ts`,
  `trusted-types.test.ts`, `sw-logic.test.ts` (webllm caches survive activation; `sw.js` has no
  `importScripts` or `import`) and `pwa.spec.ts` (0 violations, `innerHTML` throws). (D5-02)
- CI no longer runs `npx playwright install --with-deps chrome`; it checks the preinstalled Google Chrome with `google-chrome --version` and fails if missing, as in runtime. Configured, not yet executed. (S1-064)
- CSP `form-action 'self'` changed to `form-action 'none'`; the app has no forms. The diff is
  that one token. (BUG-S1-D-02, D5-02)
- The service worker's cache-first path fails closed: when a precached URL misses the cache
  and its re-fetch does not match the recorded SHA-256 (or is not a basic 200 response), the
  worker answers a navigation with the precached offline page and anything else with a
  synthetic 503. The unverified network body is never served (S1-023; rule in
  `src/sw-logic.ts` `onVerifyFailure`, covered by `test/sw-logic.test.ts`).
- `.npmrc` sets `ignore-scripts=true` and `engine-strict=true`. The only package in the
  dependency tree that declares an install script is `esbuild` (via `vite`); it is not
  executed. `playwright` 1.65.0 declares none and its browser install is an explicit CLI
  step. `npm run deps:scripts` lists the packages with install scripts.
- `worker-src` is `'self'` only. `blob:` will be added only in the sprint that introduces a
  blob-URL worker, with a justification in this file.
- `'wasm-unsafe-eval'` is in `script-src` because the pagetriage and glyphsift WebAssembly
  modules will be compiled from same-origin bytes; `'unsafe-eval'` is never used.
- The build moves Vite's bundle directory from `assets/` to `app/` so that `/assets/*` is
  reserved for large model and data files that must never be cached by the service worker.
