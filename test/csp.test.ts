import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static check of the source index.html so the CSP is covered by `npm test`, not only by the
// browser suite. BUG-S1-D-02: form-action is 'none'.
const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1] ?? '';

describe('index.html CSP', () => {
  it("form-action is 'none' (BUG-S1-D-02)", () => {
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("form-action 'self'");
  });
  it("is exactly the Sprint 2 policy plus Trusted Types for scripts, one policy 'dockit-sw' (D5-02)", () => {
    expect(csp).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; media-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types dockit-sw",
    );
  });
  it("names exactly one Trusted Types policy, no 'allow-duplicates' and no default policy", () => {
    const tt = /trusted-types ([^;]*)/u.exec(csp)?.[1]?.trim().split(/\s+/u) ?? [];
    expect(tt).toEqual(['dockit-sw']);
    expect(csp).not.toContain('allow-duplicates');
    expect(tt).not.toContain('default');
    expect(csp).toContain("require-trusted-types-for 'script'");
  });
  it("public/offline.html keeps script-src 'none'", () => {
    const offline = readFileSync(join(import.meta.dirname, '..', 'public', 'offline.html'), 'utf8');
    expect(offline).toContain("script-src 'none'");
  });
});
