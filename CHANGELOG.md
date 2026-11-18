# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Security

- Output sinks: the answer is one text node (`white-space: pre-wrap; unicode-bidi: plaintext`), tag characters and bidi controls are dropped, there is no
  markdown, no auto-linking and no href from model or PDF text; a test forbids the DOM sinks listed in the README.
- A framed copy of the page shows only a link to open dockit directly (reason `framed`).

### Fixed

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
