# dockit

Offline document intelligence kit: an installable web app that will answer questions about
PDF documents entirely on the device, built from the Airplane Mode Labs libraries
(pagetriage, glyphsift, localdata, runtime).

## Status

Skeleton (Sprint 4, 14 Nov 2026; committed, not pushed, so the live demo shows Sprint 2 until the owner
pushes). There is no document processing in this build: every pipeline stage returns a labelled
placeholder and the UI says so in a banner. What exists is the installable PWA shell (web app manifest,
strict content security policy with Trusted Types for scripts, hash-verified service-worker precache,
offline page), the pipeline stage interfaces typed against the runtime contracts re-vendored at spec
release 0.4.0 (manifest 0.1.1, which is manifest spec v0.1 published in runtime/spec (committed; public
after the owner's push); the other contracts are draft), an Answer card that shows the planned model and
backend chain as a plan only, and the tests that pin the service worker's behaviour and the CSP. No model
is loaded, no inference runs and no vector index is wired in. The first working demo (page triage,
extraction, glyph gate, local store, local model) is Sprint 5. A WebLLM rung is not yet (cut from
Sprint 4).

## Install

Requirements: Node 22 or newer, npm, and Google Chrome for the browser tests.

```sh
git clone https://github.com/AirplaneMode-Labs/dockit
cd dockit
npm ci
```

`.npmrc` disables install scripts (`ignore-scripts=true`), so nothing runs during `npm ci`.
`npm run deps:scripts` lists the packages that declare install scripts; they are not
executed.

Not a registry package (the "Not published yet" sentence in the conventions does not apply here):
dockit is a private application (`@airplanemode/dockit`, `private: true`) that is deployed to GitHub
Pages and built from a clone, not installed from npm, PyPI or crates.io. The npm scope `@airplanemode`
and the registry names are not reserved, and the name in `package.json` is a placeholder.

## Quick start

```sh
npm run build      # vite build, service-worker logic build, precache injection
npm run preview    # serves dist/ on http://127.0.0.1:4173/
```

Open the preview URL in Chrome. The app registers its service worker, precaches the shell
after verifying every file's SHA-256, and can then be reloaded with the network off. Use the
browser's install button (or the in-app one, once Chrome offers the prompt) to install it.
"Run placeholder pipeline" runs the six stage stubs on synthetic bytes generated in the page
and shows the resulting Event 0.1 events.

For development, `npm run dev` serves the source on http://127.0.0.1:5173/ without the
service worker; the dev server strips the CSP meta because React fast refresh needs an
inline preamble. Production builds keep the CSP verbatim.

## How it works

- `index.html` carries the content security policy as a meta tag (see Security and privacy).
- `public/sw.js` is the hand-written service worker. Its routing rules are the pure module
  `src/sw-logic.ts`, unit-tested in Node and bundled into the worker by the build.
  `scripts/inject-precache.mjs` lists every file of the built shell with its SHA-256 and a
  build hash derived from `dist/.vite/manifest.json`. On install the worker fetches each
  entry, hashes it with WebCrypto, refuses to cache anything that does not match, and only
  then fills the cache `dockit-precache-<buildHash>`. On activate it deletes only stale
  `dockit-precache-*` caches (the Pages origin is shared with the other demos, whose caches are
  left alone). The fetch handler passes through (does not answer) any request that is not GET, is
  cross-origin, carries a Range header, has a path under `/assets/`, or ends with
  `/manifest.json`; navigations are network-first with the cached shell or `offline.html` as
  fallback; precached files are cache-first; nothing else is cached. If a precached file misses
  the cache and its re-fetch fails the SHA-256 check, the worker answers with the offline page
  (navigations) or a synthetic 503 and never the unverified body.
- Vite's bundle directory is `app/` instead of the default `assets/`, so `/assets/*` stays
  reserved for large model and data files that the runtime asset manager downloads with
  Range requests and verifies itself.
- `src/pipeline/` holds the stage stubs (`pdf`, `triage`, `extract`, `glyphGate`, `store`,
  `answer`) as pure async functions with injected dependencies, composed by `run.ts`.
  `pdf.ts` always returns `pageCount: 'unknown'`; `extract.ts` returns source `none`;
  `glyphGate.ts` passes with `cleanFraction: null`; `store.ts` writes one count record
  through an in-memory `StorageApi`; `answer.ts` asks a local `MockAdapter` and prefixes the
  text with `placeholder:`.
- `src/pipeline/events.ts` is a local copy of the runtime's Event 0.1 rules: attrs keys are
  validated, keys that could carry text or identifiers are refused, strings are truncated to
  1024 characters and query strings are stripped. Events go to an in-memory ring buffer shown
  in the UI.
- `src/pipeline/model-plan.ts` holds the planned production model, its sizes and source, and the
  backend fallback chain (WebGPU, then WebAssembly, then the opt-in Chrome built-in model, then
  refuse), shown on the Answer card. It also holds a feature-detection prediction: the result of
  `navigator.gpu?.requestAdapter()` is reduced to a boolean (adapter info is never read,
  displayed or stored), `typeof WebAssembly`, and `'LanguageModel' in globalThis` only
  (`availability()` and `create()` are never called). Display only; no inference engine is
  imported and no request is made. `answer.ts` stays a stub.
- `src/trust.ts` exports an empty, frozen `TRUSTED_KEYS` map. Real keys are compiled in
  before any pilot; dockit has no other trust-set code.

## Contracts

`src/contracts/` vendors the six runtime contract files as published in spec release 0.4.0
(2026-11-14, untagged), each with its own version in its header: `manifest.ts` 0.1.1 (status published:
this is manifest spec v0.1, published in runtime/spec (committed; public after the owner's push)),
`capability-profile.ts` 0.1.0, `event.ts` 0.1.3, `storage-api.ts` 0.2.0, `backend-adapter.ts` 0.3.1 and
`model-descriptor.ts` 0.2.1 (all draft). The source of truth is `runtime/spec`. `npm run sync-contracts`
copies them from a sibling checkout, but only after every source file's sha256 equals its line in
runtime's SPEC-LANDED.txt; on any mismatch or missing line it fails and copies nothing. It reads
SPEC-LANDED.txt from env `SPEC_LANDED`, else the highest-numbered
`<workspace>/evidence/sprint-<n>/D1/SPEC-LANDED.txt` that exists (compared as a number, so sprint-10
beats sprint-9); no scratch path is read, and a `SPEC_LANDED` that names a missing file is an error
rather than a fall-through. Until the architect copies D1's SPEC-LANDED.txt to `evidence/sprint-4/D1/` at
wrap-up, a run without `SPEC_LANDED` finds the Sprint 3 copy and reports `sha-mismatch` for the 0.4.0 files,
which is the fail-closed behaviour, not a bug. `--check` reports in-sync or drift per file and writes nothing.
`test/contracts-sync.test.ts` fails on drift (it is skipped when the sibling is absent). dockit only
uses these as types; nothing in this build calls the runtime. Storage API 0.2.0 adds `putVectors()`,
`indexInfo()` and a working `query()`; dockit's in-memory store implements the interface's key-value half
only: `query()` and `putVectors()` reject `not_implemented` naming Sprint 5 and `indexInfo()` resolves
`undefined`, because index wiring is Sprint 5.

## Demo

Live demo: <https://airplanemode-labs.github.io/dockit/>. Built from `main` by
`.github/workflows/pages.yml` on every push; it shows only what works today and has a box titled
"What this demo does not do yet". It runs entirely in the browser: no upload, no analytics, no
third-party scripts or fonts.

Installing from the Pages URL gives the app the scope `/dockit/`, and all Airplane Mode Labs
demos share the `airplanemode-labs.github.io` origin, so the service worker deletes only its own
stale `dockit-precache-*` caches and never another demo's storage. The home screen says that
document processing is not built yet, lists the six pipeline stages with their status and the
sprint each lands in, shows live browser-requirement checks and the service worker's scope, and
keeps the Install button. Sprint 2 added an Answer card with the planned model, the backend fallback
chain and a feature-detection prediction (no inference, no request); Sprint 3 worded that card from
runtime's LANDED.json (the runtime engine runs in a worker) and turned on Trusted Types for scripts.
Sprint 4 (14 Nov 2026) re-vendors the contracts at spec release 0.4.0, words the chain sentence "runtime
0.2.0-alpha.1 runs the engine in a worker", and says WebLLM only as "a WebLLM rung (cut from Sprint 4)" in
the not-yet box; the CSP is byte-identical to Sprint 3, pinned by `test/csp.test.ts`. `test/subpath.spec.ts`
proves the same build under `/dockit/` on a server that answers 404 for everything else. Until the owner
pushes, the live demo shows Sprint 2; the refresh is proven on a local build served under `/dockit/`.

## Benchmarks

Not measured. Nothing in this build processes a document, so there is nothing honest to
time. The 8 GB Windows no-GPU laptop figures arrive with the Sprint 5 demo.

## Limitations

- The Answer card names the runtime chain as a plan only. runtime's LANDED.json marks the worker
  engine green and WebLLM cut, so the card says runtime 0.2.0-alpha.1 runs its engine in a worker, lists
  the Transformers.js rungs only, and mentions WebLLM only as "a WebLLM rung (cut from Sprint 4)" in the
  not-yet box (team decision TD-08: revisited after the Sprint 5 8 GB measurement, Sprint 6 at the
  earliest). The card describes runtime, not dockit: dockit imports no engine and loads nothing.
  `RUNTIME_LANDED` is a hand-copied constant, checked against LANDED.json by a test only when that file
  is reachable (env `LANDED_JSON`, or the workspace `evidence/sprint-<n>/D1/LANDED.json` files merged in
  sprint order, because Sprint 4's file does not repeat the worker that landed in Sprint 3).
- No vector index and no retrieval: the in-memory store's `query()` and `putVectors()` report
  `not_implemented`. localdata's index is wired into dockit in Sprint 5. Not measured on 8 GB: nothing
  here has been measured on an 8 GB laptop.
- The vendored contracts are only as current as the last `npm run sync-contracts`, which needs the
  sibling `runtime` checkout and SPEC-LANDED.txt; a clone without them keeps the committed copies
  and the drift test is skipped.
- No inference until Sprint 5. The Answer card shows the planned model
  (Qwen3-1.7B, Apache-2.0, provisional until the Sprint 5 measurement on an 8 GB laptop,
  contingency Qwen3-0.6B; loaded once in a browser in a local, unscored WebGPU smoke run of five synthetic Hindi prompts on an Apple-silicon Mac, which needed ONNX Runtime graph optimisation turned off) and a prediction from feature detection.
  Nothing is downloaded or loaded, and the prediction is not a promise that the model will run.
- The pipeline emits placeholder results only: no page count, no triage, no extraction, no
  glyph scoring, no retrieval, no model answer.
- No model is downloaded and no manifest is loaded; the trust set is empty.
- Tested in Chrome only (Playwright channel `chrome`). Firefox and Safari are untested.
- The CSP is delivered by a meta tag, which cannot set `frame-ancestors`; hosting must add
  the headers listed below.
- The icons are generated placeholders.
- `npm run dev` runs without the service worker and without the CSP.

## Security and privacy

<!-- prettier-ignore -->
This library makes no network requests other than the asset and manifest URLs you pass it, and sends no telemetry.

Content security policy in `index.html`:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self';
frame-src 'none'; media-src 'self'; manifest-src 'self'; object-src 'none';
base-uri 'none'; form-action 'none'; require-trusted-types-for 'script';
trusted-types dockit-sw
```

Trusted Types (Sprint 3): `require-trusted-types-for 'script'` makes every DOM script sink (for
example `innerHTML` or `serviceWorker.register`) require a Trusted Types value. The CSP names
exactly one policy, `dockit-sw`, with no `allow-duplicates` and no default policy. `src/main.tsx`
creates it once through `src/trusted-types.ts`; its `createScriptURL` returns only a value
exactly equal to `new URL('./sw.js', document.baseURI).href` and throws a `TypeError` for anything
else, and the result is passed to `navigator.serviceWorker.register` (a plain string where
Trusted Types is unsupported). `form-action` is `'none'` (it was `'none'` already in Sprint 2).
React renders with DOM text and element APIs, so no broader policy was needed, and the source
hygiene test forbids `dangerouslySetInnerHTML`. `test/pwa.spec.ts` proves 0 Trusted Types or CSP
violations in normal use, that the service worker registers, that the offline reload works and
that an injected `el.innerHTML = '<b>x</b>'` throws `TypeError`. `public/offline.html` keeps
`script-src 'none'`, and `sw.js` has no `importScripts` and no `import` (tested).

`'wasm-unsafe-eval'` is present because the pagetriage and glyphsift WebAssembly modules
will be compiled from same-origin bytes; it permits `WebAssembly.compile` only, not
JavaScript `eval`. `worker-src` is `'self'`; `blob:` is added only in the sprint that
introduces a blob-URL worker, with a CHANGELOG justification. No `unsafe-inline`, no
`unsafe-eval`, no remote origin.

Headers that hosting must add (a meta tag cannot set them):

- `Content-Security-Policy` with `frame-ancestors 'none'` (and the directives above)
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`

What is stored where: the service worker's Cache Storage holds the hash-verified app shell
under `dockit-precache-<buildHash>`; the pipeline's in-memory store holds nothing beyond
the page lifetime. No cookies, no localStorage, no IndexedDB in this build.

See SECURITY.md for the disclosure policy.

## Develop

```sh
npm ci
npm run ci             # fmt:check, typecheck, vitest, build
npm run test:browser   # builds, serves dist/ on 127.0.0.1:4173, runs test/pwa.spec.ts in Chrome
npm run icons          # regenerate public/icons/*.png (zero dependencies)
npm run sync-contracts # copy ../runtime/spec/*.ts into src/contracts/ (sha256-checked, see Contracts)
```

Vitest is pinned at 4.1.12. With npm 10.9.8, adding or upgrading a package reports a
peer-dependency conflict, so run `npm install --legacy-peer-deps` for that one command. `npm ci`
from the committed lockfile needs no flag. We revisit this when vitest's peer range is updated.

On Linux CI the browser step is preceded by `npx playwright install --with-deps chrome`;
locally the installed Chrome is used and nothing is downloaded.

## Licence

Apache-2.0. See LICENSE and NOTICE.
