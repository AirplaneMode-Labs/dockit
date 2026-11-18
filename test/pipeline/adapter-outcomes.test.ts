import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterError, type AdapterErrorCode } from '../../src/contracts/backend-adapter.ts';
import {
  ADAPTER_OUTCOMES,
  adapterOutcome,
  isAdapterError,
  mapAdapterError,
} from '../../src/pipeline/pipeline.ts';
import { Refusal } from '../../src/pipeline/reasons.ts';

// BUG-T1-S5-R2-01 and -02: what dockit does with each AdapterErrorCode. Every code has an intended outcome, written down once in
// ADAPTER_OUTCOMES (typed as a Record over the contract's union, so a new code does not compile until it is placed here); a code that is
// not a documented refusal is 'stopped' or 'failed', never a refusal with an unrelated reason.
const EXPECTED: Record<AdapterErrorCode, string> = {
  not_loaded: 'failed', // the controller re-loads once before this can reach the user; model_not_cached only when a file is really missing
  unsupported_profile: 'refusal:unsupported_profile',
  unsupported_operation: 'failed',
  aborted: 'stopped',
  backend: 'failed',
  unavailable: 'refusal:unsupported_profile',
  bad_descriptor: 'failed',
  egress_refused: 'failed',
  integrity: 'refusal:integrity',
  context_overflow: 'refusal:context_overflow',
  not_cached: 'refusal:model_not_cached', // the asset manager says a file is not stored in full
};
const describeOutcome = (code: AdapterErrorCode): string => {
  const o = ADAPTER_OUTCOMES[code];
  return o.kind === 'refusal' ? `refusal:${o.reason}` : o.kind;
};

describe('AdapterErrorCode to outcome table', () => {
  it('covers exactly the codes of the vendored backend adapter contract', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'contracts', 'backend-adapter.ts'),
      'utf8',
    );
    const union = src.slice(
      src.indexOf('export type AdapterErrorCode'),
      src.indexOf('export class AdapterError'),
    );
    const codes = [...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(codes.length).toBeGreaterThanOrEqual(11);
    expect(Object.keys(ADAPTER_OUTCOMES).sort()).toEqual(codes);
    expect(Object.keys(EXPECTED).sort()).toEqual(codes);
  });

  it.each(Object.keys(EXPECTED) as AdapterErrorCode[])('%s has the intended outcome', (code) => {
    expect(describeOutcome(code)).toBe(EXPECTED[code]);
  });

  it.each(Object.keys(EXPECTED) as AdapterErrorCode[])(
    'mapAdapterError(%s) returns a Refusal only for the documented refusals, never one with an unrelated reason',
    (code) => {
      const raw = new AdapterError(code, 'x');
      const m = mapAdapterError(raw);
      if (EXPECTED[code].startsWith('refusal:')) {
        expect(m).toBeInstanceOf(Refusal);
        expect((m as Refusal).reason).toBe(EXPECTED[code].slice('refusal:'.length));
      } else {
        expect(m).toBe(raw);
      }
    },
  );

  it('not_loaded is never model_not_cached: an adapter that was ended is not a model that is missing from the device', () => {
    expect(mapAdapterError(new AdapterError('not_loaded', 'x'))).toBeInstanceOf(AdapterError);
    expect(adapterOutcome(new AdapterError('not_loaded', 'x'))).toEqual({ kind: 'failed' });
  });

  it('an error from another copy of the runtime (same name and code, not the same class) is recognised', () => {
    const crossRealm = Object.assign(new Error('x'), { name: 'AdapterError', code: 'aborted' });
    expect(crossRealm).not.toBeInstanceOf(AdapterError);
    expect(isAdapterError(crossRealm)).toBe(true);
    expect(isAdapterError(crossRealm, 'aborted')).toBe(true);
    expect(isAdapterError(crossRealm, 'not_loaded')).toBe(false);
    expect(adapterOutcome(crossRealm)).toEqual({ kind: 'stopped' });
    expect(isAdapterError(new Error('x'))).toBe(false);
    expect(isAdapterError({ name: 'AdapterError', code: 'aborted' })).toBe(false);
    expect(adapterOutcome(new TypeError('x'))).toBeUndefined();
  });
});
