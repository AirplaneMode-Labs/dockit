import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_FILES,
  CONTRACT_VERSIONS,
  header,
  parseLanded,
  resolveSpecLandedPath,
  sync,
  vendoredBody,
} from '../scripts/sync-contracts.mjs';

const root = join(import.meta.dirname, '..');
const specDir = join(root, '..', 'runtime', 'spec');
const contractsDir = join(root, 'src', 'contracts');
const siblingPresent = existsSync(specDir);

describe('vendored contracts', () => {
  it('uses the per-file version map for spec release 0.4.0 and vendors six files', () => {
    // Release 0.4.0 (2026-11-14, untagged): manifest 0.1.1 is "manifest spec v0.1" (published); the others are draft.
    expect(CONTRACT_VERSIONS).toEqual({
      'manifest.ts': '0.1.1',
      'capability-profile.ts': '0.1.0',
      'event.ts': '0.1.3',
      'storage-api.ts': '0.2.0',
      'backend-adapter.ts': '0.3.1',
      'model-descriptor.ts': '0.2.1',
    });
    expect(CONTRACT_FILES).toHaveLength(6);
    expect(header('event.ts')).toBe(
      '// Vendored from AirplaneMode-Labs/runtime spec/event.ts @ 0.1.3; source of truth is runtime/spec; do not edit here\n',
    );
    expect(header('manifest.ts')).toContain('@ 0.1.1;');
    expect(header('storage-api.ts')).toContain('@ 0.2.0;');
    expect(header('backend-adapter.ts')).toContain('@ 0.3.1;');
    expect(header('model-descriptor.ts')).toContain('@ 0.2.1;');
    expect(() => header('unknown.ts')).toThrow(/no version/);
  });

  it('every vendored file starts with the vendoring header', () => {
    for (const file of CONTRACT_FILES) {
      const text = readFileSync(join(contractsDir, file), 'utf8');
      expect(text.startsWith(header(file)), `${file} header`).toBe(true);
    }
  });

  it.skipIf(!siblingPresent)('match ../runtime/spec byte for byte after the header', () => {
    for (const file of CONTRACT_FILES) {
      const src = join(specDir, file);
      if (!existsSync(src)) continue;
      const expected = readFileSync(src, 'utf8');
      const actual = readFileSync(join(contractsDir, file), 'utf8').slice(header(file).length);
      expect(actual, `${file} drifted from runtime/spec; run npm run sync-contracts`).toBe(
        expected,
      );
    }
  });
});

describe('sync-contracts script', () => {
  // A throwaway spec/ and contracts/ pair so the test never touches the real working tree.
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'dockit-sync-'));
    const spec = join(dir, 'spec');
    const out = join(dir, 'contracts');
    for (const d of [spec, out]) mkdirSync(d, { recursive: true });
    for (const file of CONTRACT_FILES) {
      writeFileSync(join(spec, file), `export type ${file.replace(/\W/g, '_')} = 'v2';\n`);
      writeFileSync(join(out, file), header(file) + `export type stale = 'v1';\n`);
    }
    return { spec, out };
  }

  it('vendoredBody strips exactly the one-line vendoring header', () => {
    expect(vendoredBody(header('manifest.ts') + 'body\n')).toBe('body\n');
    expect(vendoredBody('body\n')).toBe('body\n');
  });

  it('--check mode reports drift per file and writes nothing', () => {
    const { spec, out } = fixture();
    const before = CONTRACT_FILES.map((f) => ({
      f,
      text: readFileSync(join(out, f), 'utf8'),
      mtime: statSync(join(out, f)).mtimeMs,
    }));
    const results = sync({ specDir: spec, outDir: out, write: false });
    expect(results.map((r) => r.status)).toEqual(CONTRACT_FILES.map(() => 'drift'));
    for (const b of before) {
      expect(readFileSync(join(out, b.f), 'utf8')).toBe(b.text);
      expect(statSync(join(out, b.f)).mtimeMs).toBe(b.mtime);
    }
  });

  it('write mode updates drifted files and a second --check reports in-sync', () => {
    const { spec, out } = fixture();
    const first = sync({ specDir: spec, outDir: out, write: true });
    expect(first.map((r) => r.status)).toEqual(CONTRACT_FILES.map(() => 'updated'));
    for (const f of CONTRACT_FILES) {
      expect(readFileSync(join(out, f), 'utf8')).toBe(
        header(f) + readFileSync(join(spec, f), 'utf8'),
      );
    }
    const second = sync({ specDir: spec, outDir: out, write: false });
    expect(second.map((r) => r.status)).toEqual(CONTRACT_FILES.map(() => 'in-sync'));
  });

  it('reports source-missing and writes nothing when a spec file is absent', () => {
    const { spec, out } = fixture();
    const results = sync({ specDir: join(spec, 'nope'), outDir: out, write: true });
    expect(results.every((r) => r.status === 'source-missing')).toBe(true);
    for (const f of CONTRACT_FILES) {
      expect(readFileSync(join(out, f), 'utf8')).toBe(header(f) + `export type stale = 'v1';\n`);
    }
  });
});

describe('sha256 check against SPEC-LANDED.txt (D5-01)', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'dockit-sha-'));
    const spec = join(dir, 'spec');
    const out = join(dir, 'contracts');
    for (const d of [spec, out]) mkdirSync(d, { recursive: true });
    const lines: string[] = [];
    for (const file of CONTRACT_FILES) {
      const body = `export type ${file.replace(/\W/g, '_')} = 'v3';\n`;
      writeFileSync(join(spec, file), body);
      writeFileSync(join(out, file), header(file) + `export type stale = 'v1';\n`);
      lines.push(`${sha(body)}  spec/${file}`);
    }
    // Extra spec files in the list (schemas, vectors) must not matter.
    lines.push(`${'0'.repeat(64)}  spec/event.schema.json`);
    return { spec, out, lines };
  }

  it('parseLanded reads shasum lines keyed by basename and ignores noise', () => {
    const m = parseLanded(
      `# header\n${'a'.repeat(64)}  spec/event.ts\n${'b'.repeat(64)} *manifest.ts\nbogus line\n`,
    );
    expect(m.get('event.ts')).toBe('a'.repeat(64));
    expect(m.get('manifest.ts')).toBe('b'.repeat(64));
    expect(m.size).toBe(2);
  });

  it('matching hashes write the files', () => {
    const { spec, out, lines } = fixture();
    const results = sync({
      specDir: spec,
      outDir: out,
      write: true,
      landed: parseLanded(lines.join('\n')),
    });
    expect(results.map((r) => r.status)).toEqual(CONTRACT_FILES.map(() => 'updated'));
  });

  it('a tampered sha256 fails the sync and writes nothing, not even the matching files', () => {
    const { spec, out, lines } = fixture();
    const tampered = lines.map((l) =>
      l.endsWith('/storage-api.ts') ? `${'f'.repeat(64)}  spec/storage-api.ts` : l,
    );
    const results = sync({
      specDir: spec,
      outDir: out,
      write: true,
      landed: parseLanded(tampered.join('\n')),
    });
    expect(results.find((r) => r.file === 'storage-api.ts')?.status).toBe('sha-mismatch');
    expect(results.some((r) => r.status === 'updated')).toBe(false);
    for (const f of CONTRACT_FILES) {
      expect(readFileSync(join(out, f), 'utf8')).toBe(header(f) + `export type stale = 'v1';\n`);
    }
  });

  it('a file missing from SPEC-LANDED.txt fails with sha-missing', () => {
    const { spec, out, lines } = fixture();
    const without = lines.filter((l) => !l.endsWith('/event.ts'));
    const results = sync({
      specDir: spec,
      outDir: out,
      write: true,
      landed: parseLanded(without.join('\n')),
    });
    expect(results.find((r) => r.file === 'event.ts')?.status).toBe('sha-missing');
    expect(results.some((r) => r.status === 'updated')).toBe(false);
  });

  it('--check also reports a sha mismatch', () => {
    const { spec, out, lines } = fixture();
    const results = sync({
      specDir: spec,
      outDir: out,
      write: false,
      landed: parseLanded(lines.map((l) => l.replace(/^[0-9a-f]{64}/, '1'.repeat(64))).join('\n')),
    });
    expect(results.every((r) => r.status === 'sha-mismatch' || r.status === 'sha-missing')).toBe(
      true,
    );
  });
});

describe('SPEC-LANDED.txt lookup order (D5-01, Sprint 4)', () => {
  // Lookup order: env SPEC_LANDED (a missing file is an error, never a fall-through), then the highest-numbered
  // <workspace>/evidence/sprint-<n>/D1/SPEC-LANDED.txt that exists. No scratch path is read.
  function workspace(sprints: number[] = [3]) {
    const ws = mkdtempSync(join(tmpdir(), 'dockit-ws-'));
    const repoRoot = join(ws, 'dockit');
    mkdirSync(repoRoot, { recursive: true });
    const files = sprints.map((n) => {
      const dir = join(ws, 'evidence', `sprint-${n}`, 'D1');
      mkdirSync(dir, { recursive: true });
      return join(dir, 'SPEC-LANDED.txt');
    });
    return { ws, repoRoot, files };
  }
  const onlyReal = (real: Set<string>) => (p: string) => real.has(p);

  it('env SPEC_LANDED wins over the evidence copies', () => {
    const { repoRoot, files } = workspace([3, 4]);
    const r = resolveSpecLandedPath({
      env: { SPEC_LANDED: '/x/env.txt' },
      root: repoRoot,
      exists: onlyReal(new Set(['/x/env.txt', ...files])),
    });
    expect(r).toEqual({ path: '/x/env.txt', via: 'env' });
  });

  it('an env value naming a missing file fails and does not fall through', () => {
    const { repoRoot, files } = workspace([3, 4]);
    const r = resolveSpecLandedPath({
      env: { SPEC_LANDED: '/x/missing.txt' },
      root: repoRoot,
      exists: onlyReal(new Set(files)),
    });
    expect(r.path).toBeUndefined();
    expect(r.via).toBe('env');
    expect(r.tried).toEqual(['/x/missing.txt']);
  });

  it('an empty env value is ignored', () => {
    const { repoRoot, files } = workspace([3]);
    const r = resolveSpecLandedPath({
      env: { SPEC_LANDED: '' },
      root: repoRoot,
      exists: onlyReal(new Set(files)),
    });
    expect(r).toEqual({ path: files[0], via: 'evidence' });
  });

  it('the only evidence copy is used when no env value is given', () => {
    const { repoRoot, files } = workspace([3]);
    const r = resolveSpecLandedPath({ env: {}, root: repoRoot, exists: onlyReal(new Set(files)) });
    expect(r).toEqual({ path: files[0], via: 'evidence' });
  });

  it('the highest-numbered sprint wins, compared as numbers (sprint-10 beats sprint-9 and sprint-4)', () => {
    const { repoRoot, files } = workspace([3, 4, 9, 10]);
    const r = resolveSpecLandedPath({ env: {}, root: repoRoot, exists: onlyReal(new Set(files)) });
    expect(r).toEqual({ path: files[3], via: 'evidence' });
    expect(r.path).toContain(join('evidence', 'sprint-10'));
  });

  it('a newer sprint folder without the file is skipped in favour of the highest one that has it', () => {
    const { repoRoot, files } = workspace([3, 4, 5]);
    const r = resolveSpecLandedPath({
      env: {},
      root: repoRoot,
      exists: onlyReal(new Set([files[0]!, files[1]!])),
    });
    expect(r).toEqual({ path: files[1], via: 'evidence' });
  });

  it('reports where it looked when neither the env value nor any evidence copy exists', () => {
    const { repoRoot, files } = workspace([3, 4]);
    const none = resolveSpecLandedPath({ env: {}, root: repoRoot, exists: () => false });
    expect(none.path).toBeUndefined();
    expect(none.tried).toEqual([files[1], files[0]]);
    const empty = resolveSpecLandedPath({
      env: {},
      root: join(tmpdir(), 'dockit-no-evidence', 'dockit'),
      exists: () => false,
    });
    expect(empty.path).toBeUndefined();
    expect(empty.tried).toEqual([
      join(tmpdir(), 'dockit-no-evidence', 'evidence', 'sprint-<n>', 'D1', 'SPEC-LANDED.txt'),
    ]);
  });

  it('never reads a scratch path: the script names no scratch directory', () => {
    const text = readFileSync(join(root, 'scripts', 'sync-contracts.mjs'), 'utf8');
    expect(text).not.toContain(['', 'private', 'tmp'].join('/'));
    expect(text).not.toContain('airplanemode-team');
  });
});

describe.skipIf(!siblingPresent)('sync-contracts CLI against the real spec (D5-07)', () => {
  const script = join(root, 'scripts', 'sync-contracts.mjs');
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [script, '--check'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  it('a tampered SPEC-LANDED.txt fails the check with sha-mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dockit-cli-'));
    const bad = join(dir, 'SPEC-LANDED.txt');
    writeFileSync(bad, CONTRACT_FILES.map((f) => `${'0'.repeat(64)}  ${f}`).join('\n') + '\n');
    const r = run({ SPEC_LANDED: bad });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('sha-mismatch');
    expect(r.stdout).not.toMatch(/^updated\t/m);
  });

  it('an env SPEC_LANDED naming a missing file fails and says so', () => {
    const r = run({ SPEC_LANDED: join(tmpdir(), 'dockit-no-such-landed.txt') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not exist');
  });
});
