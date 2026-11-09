/**
 * Trust roots for manifest verification.
 *
 * The trust set is application configuration compiled into the app. It is never fetched
 * from the same origin or URL as a manifest, and a manifest's embedded publicKey is never
 * added to it. This constant is intentionally empty: real keys are compiled in before any
 * pilot, and dockit contains no other trust-set loading code this sprint.
 */
export const TRUSTED_KEYS: ReadonlyMap<string, Uint8Array> = Object.freeze(
  new Map<string, Uint8Array>(),
);
