import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static check of the source index.html so the CSP is covered by `npm test`, not only by the browser suite. BUG-S1-D-02: form-action is 'none'.
const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1] ?? '';

/**
 * The Sprint 5 policy, exactly as S1 reviewed it (D5-07). Changes against Sprint 4, each with its reason:
 *  - default-src 'none': nothing is allowed unless a directive below says so.
 *  - worker-src 'self' blob:: blob: is the ONE scheme source, and only here. runtime's startModuleWorker starts every worker
 *    (engine, pdf, analysis) from a blob: bootstrap whose whole source is one static import of an exact same-origin URL; the
 *    worker inherits this CSP, so script-src 'self' still decides what that import may load.
 *  - manifest-src 'self': the PWA manifest (manifest.webmanifest), which default-src 'none' would otherwise block.
 *  - img-src 'self' (no blob: or data:), font-src 'none', media-src 'none', style-src 'self': the page needs only its own icons and css.
 *  - trusted-types dockit-sw airplanemode-worker dockit-workers: dockit-sw registers the service worker, airplanemode-worker is the
 *    runtime engine worker's policy, dockit-workers is the policy of dockit's pdf and analysis workers. No 'default' policy, no
 *    'allow-duplicates'.
 */
const SPRINT5_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self'; style-src 'self'; font-src 'none'; manifest-src 'self'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types dockit-sw airplanemode-worker dockit-workers";

describe('index.html CSP', () => {
  it('is exactly the pinned Sprint 5 string, in one meta element, with no second policy elsewhere in the page', () => {
    expect(csp).toBe(SPRINT5_CSP);
    expect(html.match(/http-equiv="Content-Security-Policy"/gu)).toHaveLength(1);
  });

  it("has no 'unsafe-eval', no 'unsafe-inline', no http(s) source and no wildcard (wasm-unsafe-eval is the one eval-like source: WebAssembly only)", () => {
    expect(csp).not.toMatch(/(?<!wasm-)unsafe-eval|unsafe-inline|https?:|\*/u);
    expect(csp).toContain("'wasm-unsafe-eval'");
  });

  it('allows no scheme source other than blob: in worker-src, and blob: nowhere else', () => {
    const directives = new Map(
      csp
        .split(';')
        .map((d) => d.trim().split(/\s+/u))
        .map(([name, ...v]) => [name!, v]),
    );
    for (const [name, sources] of directives) {
      for (const s of sources) {
        if (/^[a-z]+:$/u.test(s))
          expect([name, s], `${name} has the scheme source ${s}`).toEqual(['worker-src', 'blob:']);
      }
    }
    expect(directives.get('worker-src')).toEqual(["'self'", 'blob:']);
  });

  it("names exactly three Trusted Types policies, no 'allow-duplicates' and no default policy", () => {
    const tt = /trusted-types ([^;]*)/u.exec(csp)?.[1]?.trim().split(/\s+/u) ?? [];
    expect(tt).toEqual(['dockit-sw', 'airplanemode-worker', 'dockit-workers']);
    expect(csp).not.toContain('allow-duplicates');
    expect(tt).not.toContain('default');
    expect(csp).toContain("require-trusted-types-for 'script'");
  });

  it("form-action is 'none' (BUG-S1-D-02), base-uri, frame-src and object-src are 'none'", () => {
    for (const d of [
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "default-src 'none'",
    ])
      expect(csp).toContain(d);
    expect(csp).not.toContain("form-action 'self'");
  });

  it("connect-src is 'self' only: the page itself can reach nothing else", () => {
    expect(/connect-src ([^;]*)/u.exec(csp)?.[1]).toBe("'self'");
  });

  it("public/offline.html keeps script-src 'none'", () => {
    const offline = readFileSync(join(import.meta.dirname, '..', 'public', 'offline.html'), 'utf8');
    expect(offline).toContain("script-src 'none'");
  });

  it('the page has no inline script or inline style and loads its own files only', () => {
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/u);
    expect(html).not.toMatch(/<style\b|\sstyle=/u);
    expect(html).not.toMatch(/(?:src|href)="https?:/u);
  });
});
