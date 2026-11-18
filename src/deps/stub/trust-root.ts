// STUB trust root: a stub build has no model bundle, so nothing can verify. The real file is written by runtime
// scripts/bundle-models.mjs into src/generated/trust-root.ts (git-ignored) with the public half of the build's key.
export const TRUST_ROOT = { keyId: '0'.repeat(64), publicKeyB64: 'A'.repeat(43) + '=' } as const;
