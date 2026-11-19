import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRUST_ROOT } from '../src/deps/stub/trust-root.ts';
import * as stubRuntime from '../src/deps/stub/runtime/index.ts';
import { WEAK_KEY_REFUSED_MESSAGE } from '../src/contracts/manifest.ts';

// Manifest 0.1.3 (S1-113, TD-68, TD-82): a trusted key must be the canonical encoding of a prime-order point other than the identity, or the
// trust set is refused with weak_key_refused before anything is parsed. dockit's stub build (CI, three OSes, no siblings) compiles in an
// all-zero key under the key id '0' x 64. That key is a small-order point, so a runtime at 0.1.3 refuses it, and the stub keeps it on purpose
// (TD-58): a stub build has no model bundle and can never verify anything. This file proves both halves without the runtime: the key IS weak
// (RFC 8032 arithmetic in BigInt, independent of any library) and the stub runtime cannot verify.

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a: bigint): bigint => ((a % P) + P) % P;
const pow = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  let x = mod(b);
  for (let n = e; n > 0n; n >>= 1n, x = mod(x * x)) if (n & 1n) r = mod(r * x);
  return r;
};
const inv = (a: bigint): bigint => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
type Pt = readonly [bigint, bigint];
const ID: Pt = [0n, 1n];
const add = ([x1, y1]: Pt, [x2, y2]: Pt): Pt => {
  const t = mod(D * x1 * x2 * y1 * y2);
  return [mod((x1 * y2 + y1 * x2) * inv(1n + t)), mod((y1 * y2 + x1 * x2) * inv(1n - t))];
};
const mul = (p: Pt, k: bigint): Pt => {
  let r = ID;
  let q = p;
  for (let n = k; n > 0n; n >>= 1n, q = add(q, q)) if (n & 1n) r = add(r, q);
  return r;
};
const eq = (a: Pt, b: Pt): boolean => a[0] === b[0] && a[1] === b[1];
const leInt = (b: Uint8Array): bigint => b.reduceRight((acc, v) => (acc << 8n) | BigInt(v), 0n);

/** RFC 8032 section 5.1.3 decoding; undefined when the bytes are not a canonical encoding of a curve point. */
function decode(bytes: Uint8Array): Pt | undefined {
  if (bytes.length !== 32) return undefined;
  const raw = leInt(bytes);
  const sign = raw >> 255n;
  const y = raw & ((1n << 255n) - 1n);
  if (y >= P) return undefined; // not canonical
  const x2 = mod((y * y - 1n) * inv(D * y * y + 1n));
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x) !== x2) x = mod(x * pow(2n, (P - 1n) / 4n));
  if (mod(x * x) !== x2) return undefined; // not on the curve
  if (x === 0n && sign === 1n) return undefined;
  if ((x & 1n) !== sign) x = mod(-x);
  return [x, y];
}
const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'));
const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));
const isWeak = (key: Uint8Array): boolean => {
  const p = decode(key);
  if (p === undefined || eq(p, ID)) return true;
  return !eq(mul(p, 8n), ID) ? !eq(mul(p, L), ID) : true; // small order, or not torsion-free
};

describe('the stub trust root against the weak-key rule (manifest 0.1.3)', () => {
  it('the predicate is sound: it accepts the RFC 8032 test key 1 and the base point, and refuses the identity and an order-8 point', () => {
    expect(isWeak(hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'))).toBe(
      false,
    );
    expect(isWeak(hex('5866666666666666666666666666666666666666666666666666666666666666'))).toBe(
      false,
    ); // the base point
    expect(isWeak(hex('0100000000000000000000000000000000000000000000000000000000000000'))).toBe(
      true,
    ); // the identity
    expect(isWeak(hex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'))).toBe(
      true,
    ); // a point of order 8
  });

  it("the stub's all-zero key under the key id of 64 zeros is a small-order point: a 0.1.3 verifier refuses it before parsing", () => {
    expect(TRUST_ROOT.keyId).toBe('0'.repeat(64));
    const key = b64(TRUST_ROOT.publicKeyB64);
    expect([...key]).toEqual(new Array(32).fill(0));
    const p = decode(key);
    expect(p, 'y = 0 decodes to a curve point').toBeDefined();
    expect(eq(p!, ID)).toBe(false); // not the identity ...
    expect(eq(mul(p!, 4n), ID)).toBe(true); // ... but of order 4: a small-order point, so [8]P is the identity
    expect(isWeak(key)).toBe(true);
  });

  it('the refusal the vendored contract names is weak_key_refused, with the shared message, and it has no opt-out', () => {
    expect(WEAK_KEY_REFUSED_MESSAGE).toBe(
      'trust set contains a weak Ed25519 public key (not the canonical encoding of a prime-order point other than the identity)',
    );
    const src = readFileSync(
      join(import.meta.dirname, '..', 'src', 'contracts', 'manifest.ts'),
      'utf8',
    );
    expect(src).toContain("'weak_key_refused'");
    expect(src).toMatch(/no opt-out/);
  });

  it('the stub runtime can never verify anything: every entry point throws, so no manifest is accepted under the stub key', () => {
    for (const name of ['AssetManager', 'detectCapabilities', 'startModuleWorker'] as const) {
      expect(() => (stubRuntime[name] as () => unknown)(), name).toThrow(/dockit stub build/);
    }
    // constructing it fails too (it is not even a constructor): there is no verifier to hand the stub key to
    expect(() => new (stubRuntime.AssetManager as unknown as new () => unknown)()).toThrow();
  });
});
