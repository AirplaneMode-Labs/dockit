/**
 * Trust roots for manifest verification.
 *
 * The trust set is application configuration compiled into the app: the public half of the key that signed THIS build's
 * model manifest, written by runtime scripts/bundle-models.mjs into src/generated/trust-root.ts (git-ignored). It is
 * never fetched from the same origin or URL as a manifest, and a manifest's embedded publicKey is never added to it.
 * One key, generated in memory per build and never exported: the signature proves the manifest and the bundle came from
 * the same build, not who published them (TD-35).
 */
import * as generated from 'virtual:dockit-trust-root';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const entries = Object.values(
  generated as unknown as Record<string, { keyId: string; publicKeyB64: string }>,
).filter(
  (v) =>
    v !== null &&
    typeof v === 'object' &&
    typeof v.keyId === 'string' &&
    typeof v.publicKeyB64 === 'string',
);

/** Exactly one trusted key; anything else is a build error. */
export const TRUSTED_KEYS: ReadonlyMap<string, Uint8Array> = (() => {
  if (entries.length !== 1)
    throw new Error(`dockit: trust-root must export exactly one key (found ${entries.length})`);
  const [k] = entries;
  return Object.freeze(new Map<string, Uint8Array>([[k!.keyId, base64ToBytes(k!.publicKeyB64)]]));
})();
