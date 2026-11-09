# dockit

Offline document intelligence kit: an installable web app that will answer questions about
PDF documents entirely on the device, built from the Airplane Mode Labs libraries
(pagetriage, glyphsift, localdata, runtime).

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

Package names use the placeholder scope `@airplanemode` / crate names `<repo>` until the
handles are reserved; nothing is published yet. dockit is a private application package
(`@airplanemode/dockit`, `private: true`), not a library.

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

`src/contracts/` vendors the six runtime contract files as published in spec release 0.2.0
(draft), each with its own version in its header: `manifest.ts` 0.1.0, `capability-profile.ts`
0.1.0, `event.ts` 0.1.1, `storage-api.ts` 0.1.0, `backend-adapter.ts` 0.2.0 and
`model-descriptor.ts` 0.1.0. The source of truth is `runtime/spec`; `npm run sync-contracts`
refreshes the copies from a sibling checkout (`--check` reports in-sync or drift per file and
writes nothing) and `test/contracts-sync.test.ts` fails on drift (it is skipped when the sibling
is absent).

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
keeps the Install button. Sprint 2 adds an Answer card with the planned model, the backend fallback chain and a feature-detection prediction (no inference, no request). `test/subpath.spec.ts` proves the same build under `/dockit/` on a
server that answers 404 for everything else.

### Status

Skeleton. There is no document processing in this build: every pipeline stage returns a
labelled placeholder and the UI says so in a banner. What exists is the installable PWA
shell (web app manifest, strict content security policy, hash-verified service-worker
precache, offline page), the pipeline stage interfaces typed against the vendored runtime
contracts, and the tests that pin the service worker's behaviour. The first working demo
(page triage, extraction, glyph gate, local store, local model) is Sprint 5.

## Benchmarks

Not measured. Nothing in this build processes a document, so there is nothing honest to
time. The 8 GB Windows no-GPU laptop figures arrive with the Sprint 5 demo.

## Limitations

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
base-uri 'none'; form-action 'none'
```

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
npm run sync-contracts # copy ../runtime/spec/*.ts into src/contracts/
```

Vitest is pinned at 4.1.12. With npm 10.9.8, adding or upgrading a package reports a
peer-dependency conflict, so run `npm install --legacy-peer-deps` for that one command. `npm ci`
from the committed lockfile needs no flag. We revisit this when vitest's peer range is updated.

On Linux CI the browser step is preceded by `npx playwright install --with-deps chrome`;
locally the installed Chrome is used and nothing is downloaded.

## Licence

Apache-2.0. See LICENSE and NOTICE.
