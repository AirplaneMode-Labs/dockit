import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static check of the source index.html so the CSP is covered by `npm test`, not only by the
// browser suite. BUG-S1-D-02: form-action is 'none'.
const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1] ?? '';

// The CSP meta is pinned byte for byte to the value shipped in Sprint 3 (commit 5a4208b, "Trusted Types policy"): the Sprint 4
// refresh adds no origin, no 'unsafe-eval', no 'unsafe-inline' and no directive. The sha256 below was computed from that commit's
// index.html with `git show 5a4208b:index.html`.
const SPRINT3_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; media-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types dockit-sw";
const SPRINT3_CSP_SHA256 = '0ca84a34cf0765a2cbcfa7946bb2f4851b5cb386b02421ad4eec87bcd4eb726f';

describe('index.html CSP', () => {
  it('is byte-identical to the Sprint 3 value (D5-01): exact string and sha256, nothing added', () => {
    expect(csp).toBe(SPRINT3_CSP);
    expect(createHash('sha256').update(csp).digest('hex')).toBe(SPRINT3_CSP_SHA256);
    expect(createHash('sha256').update(SPRINT3_CSP).digest('hex')).toBe(SPRINT3_CSP_SHA256);
    expect(csp).not.toMatch(/(?<!wasm-)unsafe-eval|unsafe-inline|https?:|\*/u);
    // Exactly one CSP meta element, and no second policy hiding elsewhere in the page.
    expect(html.match(/http-equiv="Content-Security-Policy"/gu)).toHaveLength(1);
  });
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
