/**
 * Trusted Types in dockit. The CSP (index.html) says `require-trusted-types-for 'script'; trusted-types dockit-sw
 * airplanemode-worker dockit-workers`: three named policies, no 'allow-duplicates', no default policy.
 *  - dockit-sw (this file): the one policy for navigator.serviceWorker.register(). It accepts a single value, the
 *    absolute URL of ./sw.js resolved against the document base, and throws on anything else.
 *  - airplanemode-worker: runtime's startModuleWorker policy for the blob bootstrap of the engine worker (runtime owns it).
 *  - dockit-workers: the policy of dockit's own pdf and analysis workers (src/workers/start.ts, through the same
 *    startModuleWorker).
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

/** What navigator.serviceWorker offers that dockit uses. */
export interface ServiceWorkerContainerLike {
  register(scriptURL: string, options?: { scope?: string }): Promise<unknown>;
}

/**
 * Registers ./sw.js with the scope of the document base directory: '/dockit/' on GitHub Pages, never wider. The registration
 * itself is the one use of the 'dockit-sw' Trusted Types policy.
 */
export function registerServiceWorker(
  container: ServiceWorkerContainerLike,
  tt: TrustedTypesLike | undefined,
  baseURI: string,
): Promise<unknown> {
  return container.register(swScriptUrl(tt, baseURI), { scope: new URL('./', baseURI).pathname });
}
