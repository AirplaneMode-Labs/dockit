# Contributing to dockit

Thank you for considering a contribution.

## Ground rules

- Tests first. Write or extend the test that shows the behaviour, watch it fail, then make
  it pass. Pull requests that add behaviour without a test are sent back.
- Keep the content security policy strict. Any change to the CSP meta in `index.html`, to
  `public/sw.js` or to `src/sw-logic.ts` needs a CHANGELOG entry that explains why.
- No new runtime dependencies without a one-line justification in CHANGELOG.md. The app
  depends on `react` and `react-dom` only.
- No network egress. dockit talks only to the asset and manifest URLs the user configures.
  Nothing phones home, no analytics, no fonts from a CDN.
- British spelling in prose, no emojis.

## Workflow

```sh
npm ci
npm run ci            # fmt:check, typecheck, vitest, build
npm run test:browser  # Playwright against the built app in Chrome
```

When `runtime/spec` changes, run `npm run sync-contracts` to refresh the vendored copies under
`src/contracts/` (`node scripts/sync-contracts.mjs --check` reports drift without writing);
never edit those files by hand.

By contributing you agree that your contribution is licensed under the Apache License 2.0,
the licence of this repository.
