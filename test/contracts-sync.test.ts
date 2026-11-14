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
  it('uses the per-file version map for spec release 0.3.0 and vendors six files', () => {
    expect(CONTRACT_VERSIONS).toEqual({
      'manifest.ts': '0.1.0',
      'capability-profile.ts': '0.1.0',
      'event.ts': '0.1.2',
      'storage-api.ts': '0.1.0',
      'backend-adapter.ts': '0.3.0',
      'model-descriptor.ts': '0.2.0',
    });
    expect(CONTRACT_FILES).toHaveLength(6);
    expect(header('event.ts')).toBe(
      '// Vendored from AirplaneMode-Labs/runtime spec/event.ts @ 0.1.2; source of truth is runtime/spec; do not edit here\n',
    );
    expect(header('backend-adapter.ts')).toContain('@ 0.3.0;');
    expect(header('model-descriptor.ts')).toContain('@ 0.2.0;');
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

describe('SPEC-LANDED.txt lookup order (D5-07)', () => {
  // Lookup order: env SPEC_LANDED, then <workspace>/evidence/sprint-3/D1/SPEC-LANDED.txt. An env value that names a missing file is an error, never a fall-through.
  function workspace() {
    const ws = mkdtempSync(join(tmpdir(), 'dockit-ws-'));
    const repoRoot = join(ws, 'dockit');
    mkdirSync(repoRoot, { recursive: true });
    const evidence = join(ws, 'evidence', 'sprint-3', 'D1');
    mkdirSync(evidence, { recursive: true });
    return { ws, repoRoot, evidenceFile: join(evidence, 'SPEC-LANDED.txt') };
  }
  const onlyReal = (real: Set<string>) => (p: string) => real.has(p);

  it('env SPEC_LANDED wins over both files', () => {
    const { repoRoot, evidenceFile } = workspace();
    const r = resolveSpecLandedPath({
      env: { SPEC_LANDED: '/x/env.txt' },
      root: repoRoot,
      exists: onlyReal(new Set(['/x/env.txt', evidenceFile])),
    });
    expect(r).toEqual({ path: '/x/env.txt', via: 'env' });
  });

  it('an env value naming a missing file fails and does not fall through', () => {
    const { repoRoot, evidenceFile } = workspace();
    const r = resolveSpecLandedPath({
      env: { SPEC_LANDED: '/x/missing.txt' },
      root: repoRoot,
      exists: onlyReal(new Set([evidenceFile])),
    });
    expect(r.path).toBeUndefined();
    expect(r.via).toBe('env');
    expect(r.tried).toEqual(['/x/missing.txt']);
  });

  it('an empty env value is ignored', () => {
    const { repoRoot, evidenceFile } = workspace();
    const r = resolveSpecLandedPath({
      env: { SPEC_LANDED: '' },
      root: repoRoot,
      exists: onlyReal(new Set([evidenceFile])),
    });
    expect(r).toEqual({ path: evidenceFile, via: 'evidence' });
  });

  it('the workspace evidence copy is used when no env value is given', () => {
    const { repoRoot, evidenceFile } = workspace();
    const r = resolveSpecLandedPath({
      env: {},
      root: repoRoot,
      exists: onlyReal(new Set([evidenceFile])),
    });
    expect(r).toEqual({ path: evidenceFile, via: 'evidence' });
  });

  it('reports where it looked when neither the env value nor the evidence copy exists', () => {
    const { repoRoot, evidenceFile } = workspace();
    const none = resolveSpecLandedPath({ env: {}, root: repoRoot, exists: () => false });
    expect(none.path).toBeUndefined();
    expect(none.tried).toEqual([evidenceFile]);
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
