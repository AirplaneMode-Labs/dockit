import { describe, expect, it } from 'vitest';
import { SW_POLICY_NAME, swScriptUrl, type TrustedTypesLike } from '../src/trusted-types.ts';

const BASE = 'https://airplanemode-labs.github.io/dockit/';
const SW = `${BASE}sw.js`;

function fakeTT(): { tt: TrustedTypesLike; created: string[]; defaultCalled: () => boolean } {
  const created: string[] = [];
  const tt: TrustedTypesLike = {
    createPolicy(name, rules) {
      if (created.includes(name)) throw new TypeError('duplicate policy');
      created.push(name);
      return {
        createScriptURL: (input: string) => {
          const out = rules.createScriptURL(input);
          return { __trusted: out } as unknown as string;
        },
      };
    },
  };
  return { tt, created, defaultCalled: () => created.includes('default') };
}

describe('dockit-sw Trusted Types policy (D5-02)', () => {
  it("is named 'dockit-sw'", () => {
    expect(SW_POLICY_NAME).toBe('dockit-sw');
  });

  it('returns a plain string when Trusted Types is unsupported', () => {
    expect(swScriptUrl(undefined, BASE)).toBe(SW);
  });

  it('wraps exactly new URL(./sw.js, baseURI).href in the policy and creates one policy only', () => {
    const { tt, created } = fakeTT();
    const out = swScriptUrl(tt, BASE) as unknown as { __trusted: string };
    expect(out.__trusted).toBe(SW);
    expect(created).toEqual(['dockit-sw']);
  });

  it('never creates a default policy', () => {
    const f = fakeTT();
    swScriptUrl(f.tt, BASE);
    expect(f.defaultCalled()).toBe(false);
  });

  it('the policy throws for any value other than the exact service worker URL', () => {
    let captured: ((s: string) => string) | undefined;
    const tt: TrustedTypesLike = {
      createPolicy(_n, rules) {
        captured = rules.createScriptURL;
        return { createScriptURL: (s: string) => rules.createScriptURL(s) };
      },
    };
    swScriptUrl(tt, BASE);
    expect(captured).toBeDefined();
    expect(captured!(SW)).toBe(SW);
    for (const bad of [
      `${SW}?x=1`,
      `${SW}#a`,
      `${BASE}other.js`,
      'https://example.invalid/sw.js',
      'javascript:alert(1)',
      'data:text/javascript,1',
      '',
      './sw.js',
    ]) {
      expect(() => captured!(bad), bad).toThrow(TypeError);
    }
  });

  it('reuses one policy when called twice (a second createPolicy would throw)', () => {
    const f = fakeTT();
    swScriptUrl(f.tt, BASE);
    expect(() => swScriptUrl(f.tt, BASE)).not.toThrow();
    expect(f.created).toEqual(['dockit-sw']);
  });
});
