import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
const srcFiles = walk('src').filter((f) => /\.(ts|tsx)$/.test(f));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('pdfjs usage (grep test, D5-05 stage 3)', () => {
  it('only the extraction module and the pdf worker import pdfjs-dist', () => {
    const importers = srcFiles.filter((f) =>
      /from 'pdfjs-dist|import\('pdfjs-dist|import 'pdfjs-dist/.test(read(f)),
    );
    expect(importers.sort()).toEqual(['src/workers/pdf-loader.ts', 'src/workers/pdf-worker.ts']);
  });

  it('no source file calls render, getAnnotations, getOperatorList, saveDocument or getJavaScript', () => {
    for (const f of srcFiles) {
      const code = strip(read(f));
      // React's root.render() is in src/main.tsx; a page.render() would be in the pdf code (src/workers)
      if (f.startsWith('src/workers/'))
        expect(code, `${f} uses .render(`).not.toContain('.render(');
      for (const banned of [
        'getAnnotations',
        'getOperatorList',
        'saveDocument',
        'getJavaScript',
        'getXfa',
        'getAttachments',
      ]) {
        expect(code, `${f} uses ${banned}`).not.toContain(banned);
      }
    }
  });

  it('pdf-extract.ts hands pdf.js the hardening options and never a url or a password', () => {
    const code = strip(read('src/workers/pdf-extract.ts'));
    for (const opt of [
      'isEvalSupported: false',
      'enableXfa: false',
      'disableFontFace: true',
      'useSystemFonts: false',
      'disableAutoFetch: true',
      'disableStream: true',
      'disableRange: true',
      'isOffscreenCanvasSupported: false',
      'cMapUrl',
      'standardFontDataUrl',
    ]) {
      expect(code).toContain(opt);
    }
    expect(code).not.toMatch(/\burl:/);
    expect(code).not.toMatch(/\bpassword:/);
    expect(code).toContain('PDFWorker.create');
    expect(code).toContain('fromPort');
    expect(code).toContain('getTextContent');
  });

  it('answers onPassword by refusing: updatePassword is never called anywhere in src', () => {
    for (const f of srcFiles) expect(strip(read(f)), f).not.toMatch(/updatePassword\s*\(/);
  });

  it('GlobalWorkerOptions.workerSrc is never set (that would allow a main-thread fake worker) and pdfjsWorker is never assigned', () => {
    for (const f of srcFiles) {
      const code = strip(read(f));
      expect(code, f).not.toMatch(/GlobalWorkerOptions/);
      expect(code, f).not.toMatch(/pdfjsWorker\s*=/);
    }
  });

  it('the pdf worker installs the egress guard before it loads pdf.js, and loads only the worker build', () => {
    const w = strip(read('src/workers/pdf-worker.ts'));
    const guard = w.indexOf("import './egress-first.ts'");
    const lib = w.indexOf("import 'pdfjs-dist/build/pdf.worker.mjs'");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(lib).toBeGreaterThan(guard);
  });

  it('pdfjs-dist is an exact, pinned dependency at or above 4.2.67', () => {
    const pkg = JSON.parse(read('package.json'));
    const v: string = pkg.dependencies['pdfjs-dist'];
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    const [a, b, c] = v.split('.').map(Number) as [number, number, number];
    expect(a * 1e6 + b * 1e3 + c >= 4 * 1e6 + 2 * 1e3 + 67).toBe(true);
    expect(pkg.dependencies['@huggingface/transformers']).toBe('4.3.1');
    expect(pkg.overrides).toEqual({
      'global-agent': '4.1.6',
      semver: '7.8.5',
      tslib: '2.8.1',
      '@huggingface/jinja': '0.5.10',
      'onnxruntime-web': '1.31.1',
    });
  });
});
