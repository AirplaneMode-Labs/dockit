# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- `@vitejs/plugin-react` 5.2.0 instead of the pin-table 6.2.1 because 6.2.1 requires vite ^8;
  revisit with the vite 8 move.

### Security

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
