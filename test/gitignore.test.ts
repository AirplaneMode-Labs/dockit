import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const ignored = (p: string) =>
  spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', p]).status;

describe('gitignore: nothing assembled or generated is ever committed', () => {
  it.each([
    'src/generated/trust-root.ts',
    'vendor/runtime/index.js',
    'vendor/PROVENANCE.json',
    'public/models/manifest.json',
    'public/models/qwen3-0.6b/onnx/model_quantized.onnx',
    'public/app/ort/ort-wasm-simd-threaded.wasm',
    '.cache/models/x.onnx',
    'dist/index.html',
    'node_modules/x/index.js',
    // pages.yml checks the sibling repositories out at the repo root (only there)
    'deps/x',
    'deps/runtime/package.json',
  ])('git check-ignore returns 0 for %s', (p) => {
    expect(ignored(p)).toBe(0);
  });

  it('source files are not ignored', () => {
    for (const p of [
      'src/App.tsx',
      'scripts/assemble-deps.mjs',
      'deps.lock.json',
      'public/sw.js',
      'public/manifest.webmanifest',
      // BUG-T1-S5-01: an unanchored `deps/` rule once swallowed src/deps, so a fresh clone could not build
      'src/deps/runtime.ts',
      'src/deps/localdata.ts',
      'src/deps/worker-support.ts',
      'src/deps/pdfjs.d.ts',
      'src/deps/virtual.d.ts',
      'src/deps/stub/trust-root.ts',
      'src/deps/stub/localdata/index.ts',
      'src/deps/stub/runtime/index.ts',
      'src/deps/stub/runtime/worker-support.ts',
      'src/deps/stub/runtime/backends/index.ts',
      'src/deps/stub/runtime/worker/engine-worker.ts',
    ]) {
      expect(ignored(p), p).toBe(1);
    }
  });

  it('the deps/ rule is anchored to the repo root, so it cannot swallow src/deps', () => {
    const lines = readFileSync(join(root, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    expect(lines).toContain('/deps/');
    expect(lines).not.toContain('deps/');
    expect(lines).not.toContain('deps');
  });

  it('.prettierignore anchors deps/ too, so src/deps is formatted and checked like the rest of the source', () => {
    const lines = readFileSync(join(root, '.prettierignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    expect(lines).toContain('/deps/');
    expect(lines).not.toContain('deps/');
  });

  it('every file under src/deps is committed source (none is ignored, none is generated)', () => {
    const r = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', 'src/deps']);
    const listed = r.stdout.toString().split('\n').filter(Boolean);
    // 6 loose files and 5 under stub/ (TD-58: the zero-key trust-root stub is committed)
    expect(listed.length).toBeGreaterThanOrEqual(11);
    for (const p of [
      'src/deps/runtime.ts',
      'src/deps/localdata.ts',
      'src/deps/worker-support.ts',
      'src/deps/pdfjs.d.ts',
      'src/deps/virtual.d.ts',
      'src/deps/stub/trust-root.ts',
    ]) {
      expect(listed).toContain(p);
    }
  });
});

describe('TD-58: the committed trust-root stub carries no real key', () => {
  it('its keyId is 64 zeros, so a real public key can never be pasted into it', async () => {
    const mod = await import('../src/deps/stub/trust-root.ts');
    expect(mod.TRUST_ROOT.keyId).toBe('0'.repeat(64));
    expect(mod.TRUST_ROOT.keyId).toMatch(/^0{64}$/);
    // the placeholder public key is 32 zero bytes in canonical base64, not a key anyone holds
    expect(Buffer.from(mod.TRUST_ROOT.publicKeyB64, 'base64')).toEqual(Buffer.alloc(32));
  });

  it('the stub file holds no private key material', () => {
    // the markers are built from parts so that this file does not contain them itself (the evidence and tree greps look for them)
    const pem = ['PRIVATE', 'KEY'].join(' ');
    const pkcs8Ed25519Prefix = ['302e020100300506', '032b657004220420'].join('');
    const text = readFileSync(join(root, 'src/deps/stub/trust-root.ts'), 'utf8');
    expect(text).not.toContain(pem);
    expect(text).not.toContain(pkcs8Ed25519Prefix);
    expect(text).not.toMatch(/allowTestKeys/);
  });

  it('a generated trust root and the sibling checkout folder stay ignored', () => {
    expect(ignored('src/generated/trust-root.ts')).toBe(0);
    expect(ignored('deps/x')).toBe(0);
  });
});
