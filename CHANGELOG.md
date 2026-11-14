# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Sprint 4 (14 Nov 2026, committed, not pushed): re-vendored the runtime contracts at spec release 0.4.0
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
