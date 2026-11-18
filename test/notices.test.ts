import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const notices = join(root, 'public', 'THIRD-PARTY-NOTICES.txt');
import { PACKAGES, ORT_MIT } from '../scripts/make-notices.mjs';
const pkgs = PACKAGES;

describe('third-party notices (T3-S3-028)', () => {
  it('public/THIRD-PARTY-NOTICES.txt exists and holds each licence verbatim under a name and version heading', () => {
    expect(existsSync(notices)).toBe(true);
    const text = readFileSync(notices, 'utf8');
    for (const name of pkgs) {
      const dir = join(root, 'node_modules', name);
      const version = (
        JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }
      ).version;
      expect(text).toContain(`${name} ${version}`);
      const licenceFile = join(dir, 'LICENSE');
      expect(text).toContain(
        existsSync(licenceFile) ? readFileSync(licenceFile, 'utf8').trim() : ORT_MIT,
      );
    }
  });

  it('lists every bundled third party: the npm packages, the pdf.js, transformers.js and ONNX Runtime Web chain, and both models with repo and revision', () => {
    expect(pkgs).toEqual(
      expect.arrayContaining([
        'react',
        'react-dom',
        'pdfjs-dist',
        '@huggingface/transformers',
        'onnxruntime-web',
      ]),
    );
    const text = readFileSync(notices, 'utf8');
    expect(text).toContain('Qwen3-0.6B, Apache-2.0');
    expect(text).toContain('Qwen/Qwen3-0.6B');
    expect(text).toContain(
      'onnx-community/Qwen3-0.6B-ONNX at revision 79346d370dfae34801d26993fda9ae2372900fd0',
    );
    expect(text).toContain(
      'multilingual-e5-small, MIT per the intfloat/multilingual-e5-small model card',
    );
    expect(text).toContain(
      'Xenova/multilingual-e5-small at revision 761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    );
    const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
    for (const t of [
      'pdfjs-dist',
      'Apache-2.0',
      '@huggingface/transformers',
      'onnxruntime-web',
      'Qwen3-0.6B',
      'Qwen/Qwen3-0.6B',
      '79346d370dfae34801d26993fda9ae2372900fd0',
      'multilingual-e5-small',
      '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
      'intfloat',
    ])
      expect(notice, t).toContain(t);
    for (const dep of ['runtime', 'localdata', 'pagetriage', 'glyphsift'])
      expect(notice, dep).toContain(dep);
    const lock = JSON.parse(readFileSync(join(root, 'deps.lock.json'), 'utf8')) as {
      deps: Record<string, { commit: string }>;
    };
    for (const dep of Object.keys(lock.deps))
      expect(notice, `${dep} commit`).toContain(lock.deps[dep]!.commit);
  });

  it('public/THIRD-PARTY-NOTICES.txt is the output of scripts/make-notices.mjs (the --check mode)', async () => {
    const { build } = await import('../scripts/make-notices.mjs');
    expect(readFileSync(notices, 'utf8')).toBe(build());
  });

  it('the app links the notices file without innerHTML', () => {
    const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8');
    expect(app).toContain('THIRD-PARTY-NOTICES.txt');
    expect(app).not.toMatch(/innerHTML|dangerouslySetInnerHTML/u);
  });
});
