import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from '../src/trusted-types.ts';

describe('service worker registration (D5-07)', () => {
  it("registers ./sw.js with scope exactly '/dockit/' when served from https://airplanemode-labs.github.io/dockit/", async () => {
    const register = vi.fn(async () => ({}));
    await registerServiceWorker(
      { register } as never,
      undefined,
      'https://airplanemode-labs.github.io/dockit/',
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('https://airplanemode-labs.github.io/dockit/sw.js', {
      scope: '/dockit/',
    });
  });

  it('the scope follows the document base (root for a root-served build) and is never wider than the base directory', async () => {
    const register = vi.fn(async () => ({}));
    await registerServiceWorker({ register } as never, undefined, 'http://127.0.0.1:4173/');
    expect(register).toHaveBeenCalledWith('http://127.0.0.1:4173/sw.js', { scope: '/' });
  });

  it('goes through the dockit-sw Trusted Types policy where the browser has one', async () => {
    const calls: string[] = [];
    const tt = {
      createPolicy: (name: string, rules: { createScriptURL: (s: string) => string }) => (
        calls.push(name),
        { createScriptURL: (s: string) => rules.createScriptURL(s) }
      ),
    };
    const register = vi.fn(async (_u: string, _o?: { scope?: string }) => ({}));
    await registerServiceWorker(
      { register } as never,
      tt as never,
      'https://airplanemode-labs.github.io/dockit/',
    );
    expect(calls).toEqual(['dockit-sw']);
    expect(register.mock.calls[0]![1]).toEqual({ scope: '/dockit/' });
  });
});
