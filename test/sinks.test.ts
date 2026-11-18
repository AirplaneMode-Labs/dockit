import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
const src = walk('src').filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'));
const code = (f: string) =>
  readFileSync(join(root, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const FORBIDDEN: [RegExp, string][] = [
  [/\binnerHTML\b/, 'innerHTML'],
  [/\bouterHTML\b/, 'outerHTML'],
  [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
  [/\bdangerouslySetInnerHTML\b/, 'dangerouslySetInnerHTML'],
  [/\bdocument\.write\b/, 'document.write'],
  [/\bsrcdoc\b/, 'srcdoc'],
  [/\bcreateContextualFragment\b/, 'createContextualFragment'],
  [/setAttribute\(\s*['"`](href|src|style)['"`]/, "setAttribute('href'|'src'|'style')"],
  [/\bwindow\.open\b/, 'window.open'],
  [/\blocation\s*=[^=]/, 'location ='],
  [/\blocation\.assign\b/, 'location.assign'],
  [/(^|[^.\w])eval\s*\(/, 'eval('],
  [/\bnew\s+Function\b/, 'new Function'],
];

describe('output sinks (D5-05 DOM rule): model and PDF text reach the DOM only as text nodes', () => {
  it('src has files to scan', () => {
    expect(src.length).toBeGreaterThan(20);
  });

  it.each(FORBIDDEN.map(([re, name]) => [name, re] as const))(
    'no source file uses %s',
    (name, re) => {
      for (const f of src) expect(code(f), `${f} uses ${name}`).not.toMatch(re);
    },
  );

  it('src/ui uses an href only with a literal value, never href={...}', () => {
    for (const f of src.filter((x) => x.startsWith('src/ui/')))
      expect(code(f), f).not.toMatch(/\bhref=\{/);
    // every href in src/ui is a quoted literal
    for (const f of src.filter((x) => x.startsWith('src/ui/')))
      for (const m of code(f).matchAll(/\bhref=("[^"]*"|'[^']*')/g))
        expect(m[1]).toMatch(/^["'](\.\/|https:\/\/)/);
  });

  it('no <a>, <img>, <iframe> or <svg> element is built from model or PDF text: AskCard has no anchor at all', () => {
    const ask = code('src/ui/AskCard.tsx');
    expect(ask).not.toMatch(/<a\b|<img\b|<iframe\b|<svg\b|<object\b|<embed\b/);
  });

  it('allowTestKeys appears nowhere in dockit/src outside the vendored contracts (a test key can never be trusted by this app)', () => {
    // src/contracts/ is vendored from runtime/spec and never edited here: manifest.ts only documents the option.
    for (const f of walk('src').filter((x) => !x.startsWith('src/contracts/')))
      expect(readFileSync(join(root, f), 'utf8'), f).not.toContain('allowTestKeys');
  });

  it('the answer element is styled by a class, not an inline style attribute', () => {
    for (const f of src.filter((x) => x.endsWith('.tsx')))
      expect(code(f), f).not.toMatch(/\bstyle=\{/);
    const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.answer-text\s*\{[^}]*white-space:\s*pre-wrap/);
    expect(css).toMatch(/\.answer-text\s*\{[^}]*unicode-bidi:\s*plaintext/);
  });
});
