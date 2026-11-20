import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';

// bench-windows.yml restores the model cache restore-only and must re-hash every restored file against runtime's committed pins (test/tools/models.json
// of the locked runtime checkout) before the assembler runs, and fail on any mismatch. A file that is absent is a cold cache and is left to runtime's
// own pinned fetcher; a file that is present and wrong is a poisoned or damaged cache and stops the job.
const root = join(import.meta.dirname, '..');
vi.setConfig({ testTimeout: SPAWN_TEST_TIMEOUT_MS });
const script = join(root, 'scripts', 'verify-model-cache.mjs');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function fixture(files: Record<string, string>, pinned = files) {
  const dir = mkdtempSync(join(os.tmpdir(), 'dockit-vmc-'));
  const rt = join(dir, 'runtime');
  const models = {
    schema: 1,
    models: {
      'qwen3-0.6b-wasm-q8': {
        files: Object.entries(pinned).map(([path, body]) => ({
          path,
          size: Buffer.byteLength(body),
          sha256: sha(body),
        })),
      },
      'multilingual-e5-small-wasm-q8': { files: [] },
    },
  };
  mkdirSync(join(rt, 'test', 'tools'), { recursive: true });
  writeFileSync(join(rt, 'test', 'tools', 'models.json'), JSON.stringify(models));
  for (const [path, body] of Object.entries(files)) {
    const f = join(rt, '.cache', 'models', 'qwen3-0.6b-wasm-q8', ...path.split('/'));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
  return dir;
}
const run = (dir: string, extra: string[] = []) =>
  spawnSync(process.execPath, [script, '--checkouts', dir, ...extra], {
    encoding: 'utf8',
    timeout: 30_000,
  });

describe('verify-model-cache.mjs', () => {
  it('passes when every cached file matches its pinned size and sha256, and says how many it verified', () => {
    const r = run(fixture({ 'config.json': '{"a":1}', 'onnx/model.onnx': 'x'.repeat(5000) }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/verified 2 files/u);
  });

  it('fails (exit 1) on a file whose bytes differ, naming the file and both digests, and never prints file contents', () => {
    const dir = fixture({ 'config.json': 'good' }, { 'config.json': 'bad!' });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('qwen3-0.6b-wasm-q8/config.json');
    expect(r.stderr).toMatch(/size|sha256/u);
    expect(r.stderr).not.toContain('good');
  });

  it('fails on a file of the right size and the wrong bytes (a size-only check would pass it)', () => {
    const r = run(fixture({ 'a.bin': 'aaaa' }, { 'a.bin': 'bbbb' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/sha256/u);
  });

  it('a file that is absent is a cold cache: exit 0, reported as absent, left to the pinned fetcher', () => {
    const dir = fixture({ 'present.json': 'p' }, { 'present.json': 'p', 'absent.onnx': 'zzz' });
    const r = run(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/absent: qwen3-0\.6b-wasm-q8\/absent\.onnx/u);
    expect(r.stdout).toMatch(/verified 1 file\b/u);
  });

  it('an entirely absent cache directory is a cold cache too', () => {
    const dir = fixture({});
    const r = run(dir);
    expect(r.status, r.stderr).toBe(0);
  });

  it('refuses (exit 2) a pinned path that leaves the cache directory, and a pin file with a missing model', () => {
    const dir = fixture({}, { '../escape.txt': 'x' });
    expect(run(dir).status).toBe(2);
    const empty = mkdtempSync(join(os.tmpdir(), 'dockit-vmc-'));
    mkdirSync(join(empty, 'runtime', 'test', 'tools'), { recursive: true });
    writeFileSync(
      join(empty, 'runtime', 'test', 'tools', 'models.json'),
      '{"schema":1,"models":{}}',
    );
    expect(run(empty).status).toBe(2);
    expect(run(join(empty, 'nowhere')).status).toBe(2);
  });

  it('takes no network action and reads only the checkouts directory', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).not.toMatch(/https?:\/\/|fetch\(|node:https?|node:net|child_process/u);
    expect(src).toMatch(/node:crypto/u);
  });

  it('the usage error (no --checkouts) is exit 2', () => {
    expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).toBe(2);
  });
});
