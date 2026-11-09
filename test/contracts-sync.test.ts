import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_FILES,
  CONTRACT_VERSIONS,
  header,
  sync,
  vendoredBody,
} from '../scripts/sync-contracts.mjs';

const root = join(import.meta.dirname, '..');
const specDir = join(root, '..', 'runtime', 'spec');
const contractsDir = join(root, 'src', 'contracts');
const siblingPresent = existsSync(specDir);

describe('vendored contracts', () => {
  it('uses the per-file version map for spec release 0.2.0 and vendors six files', () => {
    expect(CONTRACT_VERSIONS).toEqual({
      'manifest.ts': '0.1.0',
      'capability-profile.ts': '0.1.0',
      'event.ts': '0.1.1',
      'storage-api.ts': '0.1.0',
      'backend-adapter.ts': '0.2.0',
      'model-descriptor.ts': '0.1.0',
    });
    expect(CONTRACT_FILES).toHaveLength(6);
    expect(header('event.ts')).toBe(
      '// Vendored from AirplaneMode-Labs/runtime spec/event.ts @ 0.1.1; source of truth is runtime/spec; do not edit here\n',
    );
    expect(header('backend-adapter.ts')).toContain('@ 0.2.0;');
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
