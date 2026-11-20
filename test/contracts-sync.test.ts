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
  readLandedFrom,
  resolveSpecLandedPath,
  sync,
  vendoredBody,
} from '../scripts/sync-contracts.mjs';

const root = join(import.meta.dirname, '..');
const specDir = join(root, '..', 'runtime', 'spec');
const contractsDir = join(root, 'src', 'contracts');
const siblingPresent = existsSync(specDir);

describe('vendored contracts', () => {
  it('uses the per-file version map for spec release 0.6.1 and vendors six files', () => {
    // Release 0.6.1 (2026-11-20, untagged): every header names its contract's own version. manifest 0.1.4 is "manifest spec v0.1" (published, additive patch:
    // the Release manifests section); event 0.1.6 and storage API 0.4.1 are draft patches; the other three are the contract versions of 0.6.0, unchanged.
    expect(CONTRACT_VERSIONS).toEqual({
      'manifest.ts': '0.1.4',
      'capability-profile.ts': '0.1.1',
      'event.ts': '0.1.6',
      'storage-api.ts': '0.4.1',
      'backend-adapter.ts': '0.5.0',
      'model-descriptor.ts': '0.2.1',
    });
    expect(CONTRACT_FILES).toHaveLength(6);
    expect(header('event.ts')).toBe(
      '// Vendored from AirplaneMode-Labs/runtime spec/event.ts @ 0.1.6; source of truth is runtime/spec; do not edit here\n',
    );
    expect(header('manifest.ts')).toContain('@ 0.1.4;');
    expect(header('capability-profile.ts')).toContain('@ 0.1.1;');
    expect(header('storage-api.ts')).toContain('@ 0.4.1;');
    expect(header('backend-adapter.ts')).toContain('@ 0.5.0;');
    expect(header('model-descriptor.ts')).toContain('@ 0.2.1;');
    expect(() => header('unknown.ts')).toThrow(/no version/);
  });

  it('each vendored body states the contract version its header names (the header cannot drift from the file again)', () => {
    const named: Record<string, RegExp> = {
      'manifest.ts': /Manifest contract 0\.1\.4\b/u,
      'capability-profile.ts': /Capability profile contract 0\.1\.1\b/u,
      'event.ts': /Event contract 0\.1\.6\b/u,
      'storage-api.ts': /Storage API contract 0\.4\.1\b/u,
      'backend-adapter.ts': /Backend adapter contract 0\.5\.0\b/u,
      'model-descriptor.ts': /Model descriptor contract 0\.2\.1\b/u,
    };
    for (const file of CONTRACT_FILES)
      expect(readFileSync(join(contractsDir, file), 'utf8').slice(0, 600), file).toMatch(
        named[file]!,
      );
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

describe('a stale header is drift too (Sprint 7: capability-profile.ts said @ 0.1.0 over a 0.1.1 body)', () => {
  function pair() {
    const dir = mkdtempSync(join(tmpdir(), 'dockit-hdr-'));
    const spec = join(dir, 'spec');
    const out = join(dir, 'contracts');
    mkdirSync(spec);
    mkdirSync(out);
    for (const f of CONTRACT_FILES) {
      writeFileSync(join(spec, f), `export type same = 1;\n`);
      writeFileSync(join(out, f), header(f) + `export type same = 1;\n`);
    }
    return { spec, out };
  }
  it('is in sync when body and header are both right', () => {
    const { spec, out } = pair();
    expect(
      sync({ specDir: spec, outDir: out, write: false }).every((r) => r.status === 'in-sync'),
    ).toBe(true);
  });
  it('a body that matches under an older header is drift on --check and is rewritten otherwise', () => {
    const { spec, out } = pair();
    writeFileSync(
      join(out, 'capability-profile.ts'),
      '// Vendored from AirplaneMode-Labs/runtime spec/capability-profile.ts @ 0.1.0; source of truth is runtime/spec; do not edit here\nexport type same = 1;\n',
    );
    expect(
      sync({ specDir: spec, outDir: out, write: false }).find(
        (r) => r.file === 'capability-profile.ts',
      )?.status,
    ).toBe('drift');
    expect(
      sync({ specDir: spec, outDir: out, write: true }).find(
        (r) => r.file === 'capability-profile.ts',
      )?.status,
    ).toBe('updated');
    expect(readFileSync(join(out, 'capability-profile.ts'), 'utf8')).toBe(
      header('capability-profile.ts') + 'export type same = 1;\n',
    );
  });
});

// Sprint 7: D1's SPEC-LANDED.txt is prose and the digests are in LANDED.json next to it ({ files: { 'spec/<file>': sha256 } }). The reader takes the sha lines when
// there are any and the JSON beside the file when there are none; neither is ever guessed.
describe('LANDED.json beside SPEC-LANDED.txt (Sprint 7)', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const dirWith = (landedTxt: string, json?: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'dockit-landed-'));
    writeFileSync(join(dir, 'SPEC-LANDED.txt'), landedTxt);
    if (json !== undefined) writeFileSync(join(dir, 'LANDED.json'), JSON.stringify(json));
    return dir;
  };

  it('a prose SPEC-LANDED.txt with a LANDED.json beside it gives the digests of the json, keyed by basename', () => {
    const dir = dirWith('SPEC RELEASE 0.6.1 LANDED\n(no digest lines)\n', {
      specRelease: '0.6.1',
      files: {
        'spec/manifest.ts': 'a'.repeat(64),
        'spec/examples/event.example.json': 'b'.repeat(64),
      },
    });
    const m = readLandedFrom(join(dir, 'SPEC-LANDED.txt'));
    expect(m.get('manifest.ts')).toBe('a'.repeat(64));
    expect(m.get('event.example.json')).toBe('b'.repeat(64));
    expect(m.size).toBe(2);
  });

  it('digest lines in SPEC-LANDED.txt win over a LANDED.json (the older format keeps working)', () => {
    const dir = dirWith(`${'c'.repeat(64)}  spec/manifest.ts\n`, {
      files: { 'spec/manifest.ts': 'd'.repeat(64) },
    });
    expect(readLandedFrom(join(dir, 'SPEC-LANDED.txt')).get('manifest.ts')).toBe('c'.repeat(64));
  });

  it('without digest lines and without a LANDED.json the map is empty, so every file is sha-missing and nothing is written', () => {
    const dir = dirWith('prose only\n');
    const landed = readLandedFrom(join(dir, 'SPEC-LANDED.txt'));
    expect(landed.size).toBe(0);
    const spec = join(dir, 'spec');
    const out = join(dir, 'contracts');
    mkdirSync(spec);
    mkdirSync(out);
    for (const f of CONTRACT_FILES) writeFileSync(join(spec, f), `export type x = 1;\n`);
    const results = sync({ specDir: spec, outDir: out, write: true, landed });
    expect(results.every((r) => r.status === 'sha-missing' || r.status === 'blocked')).toBe(true);
    for (const f of CONTRACT_FILES) expect(existsSync(join(out, f))).toBe(false);
  });

  it('a LANDED.json that is not valid or has no files object is an error, never an empty pass', () => {
    const bad = mkdtempSync(join(tmpdir(), 'dockit-landed-'));
    writeFileSync(join(bad, 'SPEC-LANDED.txt'), 'prose\n');
    writeFileSync(join(bad, 'LANDED.json'), '{ not json');
    expect(() => readLandedFrom(join(bad, 'SPEC-LANDED.txt'))).toThrow(/LANDED\.json/u);
    const noFiles = dirWith('prose\n', { specRelease: '0.6.1' });
    expect(() => readLandedFrom(join(noFiles, 'SPEC-LANDED.txt'))).toThrow(/files/u);
    const badDigest = dirWith('prose\n', { files: { 'spec/manifest.ts': 'nope' } });
    expect(() => readLandedFrom(join(badDigest, 'SPEC-LANDED.txt'))).toThrow(/sha256/u);
  });

  it('a sync with the json digests writes the files, and a flipped digest blocks all of them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dockit-landed-'));
    const spec = join(dir, 'spec');
    const out = join(dir, 'contracts');
    mkdirSync(spec);
    mkdirSync(out);
    const files: Record<string, string> = {};
    for (const f of CONTRACT_FILES) {
      const body = `export type ${f.replace(/\W/g, '_')} = 'v4';\n`;
      writeFileSync(join(spec, f), body);
      files[`spec/${f}`] = sha(body);
    }
    writeFileSync(join(dir, 'SPEC-LANDED.txt'), 'prose\n');
    writeFileSync(join(dir, 'LANDED.json'), JSON.stringify({ files }));
    const ok = sync({
      specDir: spec,
      outDir: out,
      write: true,
      landed: readLandedFrom(join(dir, 'SPEC-LANDED.txt')),
    });
    expect(ok.map((r) => r.status)).toEqual(CONTRACT_FILES.map(() => 'updated'));
    writeFileSync(
      join(dir, 'LANDED.json'),
      JSON.stringify({ files: { ...files, 'spec/event.ts': '0'.repeat(64) } }),
    );
    const bad = sync({
      specDir: spec,
      outDir: out,
      write: true,
      landed: readLandedFrom(join(dir, 'SPEC-LANDED.txt')),
    });
    expect(bad.find((r) => r.file === 'event.ts')?.status).toBe('sha-mismatch');
    expect(bad.some((r) => r.status === 'updated')).toBe(false);
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
