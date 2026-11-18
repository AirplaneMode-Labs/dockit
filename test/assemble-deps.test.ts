import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ad from '../scripts/assemble-deps.mjs';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A scratch git repository standing in for a sibling clone, with one commit. */
function scratchRepo(parent: string, name: string): { dir: string; sha: string } {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'scratch\n');
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  git(dir, 'add', 'README.md', '.gitignore');
  git(dir, 'commit', '-q', '-m', 'scratch');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}

const DEPS = ['runtime', 'localdata', 'pagetriage', 'glyphsift'] as const;

function fixture(extra?: (name: string, dir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'dockit-deps-'));
  const checkouts = join(root, 'checkouts');
  const out = join(root, 'dockit');
  mkdirSync(out, { recursive: true });
  const lock: { schema: 1; deps: Record<string, { repo: string; commit: string }> } = {
    schema: 1,
    deps: {},
  };
  const repos: Record<string, { dir: string; sha: string }> = {};
  for (const d of DEPS) {
    repos[d] = scratchRepo(checkouts, d);
    lock.deps[d] = { repo: `AirplaneMode-Labs/${d}`, commit: repos[d]!.sha };
    extra?.(d, repos[d]!.dir);
  }
  const lockPath = join(root, 'deps.lock.json');
  writeFileSync(lockPath, JSON.stringify(lock));
  return { root, checkouts, out, lockPath, repos };
}

/** An exec that records every step and writes the files a real build would leave behind. */
function fakeExec(calls: { cwd: string; cmd: string; args: string[] }[]) {
  return (cwd: string, cmd: string, args: string[]) => {
    calls.push({ cwd, cmd, args });
    const dep = cwd.split(/[\\/]/).pop()!;
    mkdirSync(join(cwd, 'dist'), { recursive: true });
    writeFileSync(join(cwd, 'dist', `${dep}.out.js`), `// ${dep} build\n`);
    mkdirSync(join(cwd, 'dist', 'wasm', 'web'), { recursive: true });
    writeFileSync(join(cwd, 'dist', 'wasm', 'web', `${dep}_bg.wasm`), 'wasm');
    writeFileSync(join(cwd, 'dist', 'wasm', 'web', `${dep}.js`), 'js');
  };
}

describe('assemble-deps: lock file', () => {
  it('the committed deps.lock.json has schema 1 and four 40-hex commits', () => {
    const lock = JSON.parse(readFileSync(join(__dirname, '..', 'deps.lock.json'), 'utf8'));
    expect(lock.schema).toBe(1);
    expect(Object.keys(lock.deps).sort()).toEqual([...DEPS].sort());
    for (const d of DEPS) {
      expect(lock.deps[d].commit).toMatch(/^[0-9a-f]{40}$/);
      expect(lock.deps[d].repo).toBe(`AirplaneMode-Labs/${d}`);
    }
  });

  it('refuses a lock with a short, uppercase or missing commit, a wrong schema or an extra dependency', () => {
    const good = JSON.parse(readFileSync(join(__dirname, '..', 'deps.lock.json'), 'utf8'));
    expect(() => ad.parseLock(good)).not.toThrow();
    for (const mutate of [
      (l: any) => (l.deps.runtime.commit = 'abc1234'),
      (l: any) => (l.deps.runtime.commit = l.deps.runtime.commit.toUpperCase()),
      (l: any) => delete l.deps.glyphsift,
      (l: any) => (l.schema = 2),
      (l: any) => (l.deps.extra = { repo: 'x/y', commit: 'a'.repeat(40) }),
      (l: any) => (l.deps.runtime.repo = 'someone-else/runtime'),
    ]) {
      const bad = structuredClone(good);
      mutate(bad);
      expect(() => ad.parseLock(bad)).toThrow();
    }
  });
});

describe('assemble-deps: the build plan follows the sprint spec', () => {
  it('runs each dependency its own build in a fixed order with ignore-scripts installs', () => {
    const plan = ad.buildPlan({ dockitRoot: '/d' });
    expect(plan.runtime.steps.map((s: any) => [s.cmd, ...s.args].join(' '))).toEqual([
      'npm ci --ignore-scripts',
      'npm run build',
      'node test/tools/fetch-model.mjs qwen3-0.6b-wasm-q8',
      'node test/tools/fetch-model.mjs multilingual-e5-small-wasm-q8',
      'node /d/scripts/copy-ort.mjs --to /d/public/app/ort',
      'node scripts/bundle-models.mjs --set dockit --out /d/public/models --root /d/public --manifest-id dev.airplanemode.dockit-models --ort-dir /d/public/app/ort --trust-root-out /d/src/generated/trust-root.ts',
      'node /d/scripts/copy-ort.mjs --to /d/public/app/ort --drop-wasm',
    ]);
    expect(plan.localdata.steps.map((s: any) => [s.cmd, ...s.args].join(' '))).toEqual([
      'npm ci --ignore-scripts',
      'npm run build:wasm',
      'npm run build',
    ]);
    expect(plan.glyphsift.steps.map((s: any) => [s.cmd, ...s.args].join(' '))).toEqual([
      'bash scripts/build-wasm.sh',
    ]);
    expect(plan.pagetriage.steps.map((s: any) => [s.cmd, ...s.args].join(' '))).toEqual([
      'bash scripts/build-wasm.sh',
    ]);
    // the pdf-feature build, written to its own folder
    expect(plan.pagetriage.steps[0].env).toEqual({
      PAGETRIAGE_WASM_FEATURES: 'pdf',
      WASM_OUT: 'dist/wasm-pdf',
    });
    expect(Object.keys(plan)).toEqual(['runtime', 'localdata', 'pagetriage', 'glyphsift']);
  });

  it('uses node:path only: every plan path is built with the platform separator helpers', () => {
    const src = readFileSync(join(__dirname, '..', 'scripts', 'assemble-deps.mjs'), 'utf8');
    expect(src).toMatch(/from 'node:path'/);
    expect(src).not.toMatch(/\bglob\b|child_process.*shell: true|\bexecSync\(/);
  });
});

describe('assemble-deps: --checkouts mode against scratch git repositories', () => {
  it('builds each dep, copies outputs into vendor/<dep>/, and writes PROVENANCE.json with commit, dirty and per-file sha256', async () => {
    const f = fixture();
    const calls: { cwd: string; cmd: string; args: string[] }[] = [];
    const prov = await ad.assembleDeps({
      mode: 'checkouts',
      dir: f.checkouts,
      dockitRoot: f.out,
      lockPath: f.lockPath,
      exec: fakeExec(calls),
      plan: Object.fromEntries(
        DEPS.map((d) => [
          d,
          {
            steps: [{ cmd: 'build', args: [d] }],
            outputs: [
              { from: 'dist/wasm/web', to: '.' },
              { from: 'dist/' + d + '.out.js', to: d + '.out.js' },
            ],
          },
        ]),
      ),
    });
    expect(calls.map((c) => c.args[0])).toEqual([...DEPS]);
    for (const d of DEPS) {
      expect(existsSync(join(f.out, 'vendor', d, `${d}_bg.wasm`))).toBe(true);
      expect(existsSync(join(f.out, 'vendor', d, `${d}.out.js`))).toBe(true);
    }
    const written = JSON.parse(readFileSync(join(f.out, 'vendor', 'PROVENANCE.json'), 'utf8'));
    expect(written).toEqual(prov);
    expect(written.deps.map((e: any) => e.dep)).toEqual([...DEPS]);
    for (const e of written.deps) {
      expect(e.commit).toBe(f.repos[e.dep]!.sha);
      expect(e.dirty).toBe(false);
      expect(e.files.length).toBeGreaterThanOrEqual(2);
      for (const file of e.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.size).toBeGreaterThan(0);
        expect(file.path).not.toMatch(/\\/);
      }
    }
  });

  it('a lock mismatch exits 2 before any build runs', async () => {
    const f = fixture();
    const lock = JSON.parse(readFileSync(f.lockPath, 'utf8'));
    lock.deps.pagetriage.commit = 'f'.repeat(40);
    writeFileSync(f.lockPath, JSON.stringify(lock));
    const calls: unknown[] = [];
    await expect(
      ad.assembleDeps({
        mode: 'checkouts',
        dir: f.checkouts,
        dockitRoot: f.out,
        lockPath: f.lockPath,
        exec: (...a: unknown[]) => calls.push(a),
        plan: {},
      }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/pagetriage.*does not match deps\.lock\.json/s),
    });
    expect(calls).toEqual([]);
    expect(existsSync(join(f.out, 'vendor'))).toBe(false);
  });

  it('a dirty checkout is refused unless --allow-dirty, which records <sha>-dirty', async () => {
    const f = fixture();
    writeFileSync(join(f.repos.runtime!.dir, 'README.md'), 'changed\n');
    const base = {
      mode: 'checkouts',
      dir: f.checkouts,
      dockitRoot: f.out,
      lockPath: f.lockPath,
      exec: fakeExec([]),
      plan: Object.fromEntries(
        DEPS.map((d) => [d, { steps: [], outputs: [{ from: 'README.md', to: 'README.md' }] }]),
      ),
    };
    await expect(ad.assembleDeps(base)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/runtime.*uncommitted/s),
    });
    const prov = await ad.assembleDeps({ ...base, allowDirty: true });
    const rt = prov.deps.find((e: any) => e.dep === 'runtime');
    expect(rt.dirty).toBe(true);
    expect(rt.commit).toBe(`${f.repos.runtime!.sha}-dirty`);
    expect(prov.deps.find((e: any) => e.dep === 'glyphsift').commit).toBe(f.repos.glyphsift!.sha);
  });

  it('a missing build output is an error that names the dependency and the path', async () => {
    const f = fixture();
    await expect(
      ad.assembleDeps({
        mode: 'checkouts',
        dir: f.checkouts,
        dockitRoot: f.out,
        lockPath: f.lockPath,
        exec: () => {},
        plan: Object.fromEntries(
          DEPS.map((d) => [d, { steps: [], outputs: [{ from: 'dist/nothing.js', to: 'x.js' }] }]),
        ),
      }),
    ).rejects.toThrow(/runtime.*dist\/nothing\.js/s);
  });

  it('a missing checkout folder is an error naming it; --siblings and --checkouts are the only modes', async () => {
    const f = fixture();
    await expect(
      ad.assembleDeps({
        mode: 'checkouts',
        dir: join(f.root, 'absent'),
        dockitRoot: f.out,
        lockPath: f.lockPath,
        exec: () => {},
        plan: {},
      }),
    ).rejects.toThrow(/absent/);
    expect(() => ad.parseArgs(['--nothing'])).toThrow(/usage/);
    expect(ad.parseArgs(['--siblings', '..', '--allow-dirty'])).toMatchObject({
      mode: 'siblings',
      dir: '..',
      allowDirty: true,
    });
    expect(ad.parseArgs(['--checkouts', 'deps'])).toMatchObject({
      mode: 'checkouts',
      dir: 'deps',
      allowDirty: false,
    });
    expect(() => ad.parseArgs(['--siblings', '..', '--checkouts', 'x'])).toThrow(/usage/);
  });

  it('siblings mode finds <dir>/<dep>; checkouts mode finds <dir>/<dep> too (the same layout)', () => {
    expect(ad.depDir('siblings', '/w', 'runtime')).toBe(join('/w', 'runtime'));
    expect(ad.depDir('checkouts', '/c', 'runtime')).toBe(join('/c', 'runtime'));
  });
});

describe('deps mode selection (stub builds)', () => {
  it('resolveDepsMode: DOCKIT_DEPS=stub gives stub; otherwise vendor when PROVENANCE exists; otherwise a refusal', async () => {
    const { resolveDepsMode } = await import('../scripts/deps-mode.mjs');
    expect(resolveDepsMode({ env: { DOCKIT_DEPS: 'stub' }, hasProvenance: false })).toBe('stub');
    expect(resolveDepsMode({ env: {}, hasProvenance: true })).toBe('vendor');
    expect(() => resolveDepsMode({ env: {}, hasProvenance: false })).toThrow(/assemble-deps/);
    expect(() => resolveDepsMode({ env: { DOCKIT_DEPS: 'bogus' }, hasProvenance: true })).toThrow(
      /DOCKIT_DEPS/,
    );
  });
});

describe('copy-ort: the pinned ONNX Runtime Web files bundle-models takes as input', () => {
  it('copies the two files named by runtime src/backends/ort-pins.ts from node_modules/onnxruntime-web/dist, and --drop-wasm removes the binary afterwards', async () => {
    const { ortFileNames, copyOrt, dropWasm } = await import('../scripts/copy-ort.mjs');
    const root = mkdtempSync(join(tmpdir(), 'dockit-ort-'));
    mkdirSync(join(root, 'src', 'backends'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'onnxruntime-web', 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'backends', 'ort-pins.ts'),
      "export const ORT_WASM_FILE = 'ort-x.wasm';\nexport const ORT_FACTORY_FILE = 'ort-x.mjs';\n",
    );
    writeFileSync(join(root, 'node_modules', 'onnxruntime-web', 'dist', 'ort-x.wasm'), 'wasm');
    writeFileSync(join(root, 'node_modules', 'onnxruntime-web', 'dist', 'ort-x.mjs'), 'mjs');
    expect(ortFileNames(root)).toEqual({ wasm: 'ort-x.wasm', factory: 'ort-x.mjs' });
    const to = join(root, 'out', 'ort');
    copyOrt(root, to);
    expect(readFileSync(join(to, 'ort-x.wasm'), 'utf8')).toBe('wasm');
    expect(readFileSync(join(to, 'ort-x.mjs'), 'utf8')).toBe('mjs');
    dropWasm(root, to);
    expect(existsSync(join(to, 'ort-x.wasm'))).toBe(false);
    expect(existsSync(join(to, 'ort-x.mjs'))).toBe(true);
  });

  it('refuses a pins file without the two names', async () => {
    const { ortFileNames } = await import('../scripts/copy-ort.mjs');
    const root = mkdtempSync(join(tmpdir(), 'dockit-ort-'));
    mkdirSync(join(root, 'src', 'backends'), { recursive: true });
    writeFileSync(join(root, 'src', 'backends', 'ort-pins.ts'), 'export const X = 1;\n');
    expect(() => ortFileNames(root)).toThrow(/ORT_WASM_FILE/);
  });
});
