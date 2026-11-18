// How the app resolves its four sibling builds (TD-40). Shared by vite.config.ts and the tests.
//   vendor  vendor/<dep>/ exists (written by scripts/assemble-deps.mjs): the real build, the only one deployed.
//   stub    DOCKIT_DEPS=stub: type-correct stand-ins under src/deps/stub/, used by `npm run build:check` and CI
//           on three OSes. A stub build carries a banner and is never deployed.
export function resolveDepsMode({ env, hasProvenance }) {
  const v = env.DOCKIT_DEPS;
  if (v !== undefined && v !== '' && v !== 'stub' && v !== 'vendor') {
    throw new Error(`DOCKIT_DEPS must be 'stub' or 'vendor' (got '${v}')`);
  }
  if (v === 'stub') return 'stub';
  if (hasProvenance) return 'vendor';
  throw new Error(
    'vendor/PROVENANCE.json is missing: run `node scripts/assemble-deps.mjs --siblings ..` (or --checkouts <dir>) first, ' +
      'or use `npm run build:check` for a stub build that is never deployed.',
  );
}
