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
  it('is exactly the Sprint 1 policy with that one token changed', () => {
    expect(csp).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; media-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });
});
