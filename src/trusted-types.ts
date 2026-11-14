/**
 * Trusted Types for the one script sink dockit has: navigator.serviceWorker.register().
 * The CSP (index.html) says `require-trusted-types-for 'script'; trusted-types dockit-sw`: exactly
 * one named policy, no 'allow-duplicates', no default policy. The policy accepts a single value,
 * the absolute URL of ./sw.js resolved against the document base, and throws on anything else.
 * Where Trusted Types is unsupported the plain string is used (the CSP directive is then ignored).
 */

export const SW_POLICY_NAME = 'dockit-sw';

export interface TrustedTypesLike {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
  ): { createScriptURL(input: string): string };
}

// One policy per TrustedTypes object: createPolicy with an already used name throws, and the CSP
// forbids duplicates.
const policies = new WeakMap<object, { createScriptURL(input: string): string }>();

/** The value to pass to serviceWorker.register: a TrustedScriptURL where supported, else a string. */
export function swScriptUrl(tt: TrustedTypesLike | undefined, baseURI: string): string {
  const expected = new URL('./sw.js', baseURI).href;
  if (tt === undefined) return expected;
  let policy = policies.get(tt);
  if (policy === undefined) {
    policy = tt.createPolicy(SW_POLICY_NAME, {
      createScriptURL(input: string): string {
        if (input !== expected)
          throw new TypeError('dockit-sw: refusing a script URL it did not expect');
        return input;
      },
    });
    policies.set(tt, policy);
  }
  return policy.createScriptURL(expected);
}
