#!/usr/bin/env node
// Assembles dockit's four sibling builds (runtime, localdata, pagetriage, glyphsift) from the exact commits in
// deps.lock.json (TD-40). Nothing it produces is committed: vendor/, public/models/, public/app/ort/ and
// src/generated/ are git-ignored.
//
//   node scripts/assemble-deps.mjs --siblings <dir> [--allow-dirty]   <dir>/<dep> are working clones (local use)
//   node scripts/assemble-deps.mjs --checkouts <dir>                  <dir>/<dep> are clean checkouts at the locked
//                                                                     commits (what pages.yml and the architect's
//                                                                     wrap-up simulation use)
//
// For each dependency it re-checks `git rev-parse HEAD` against the lock (exit 2 on a mismatch, before any build),
// refuses a tree with uncommitted changes unless --allow-dirty (the commit is then recorded as '<sha>-dirty'), runs
// the dependency's own build, copies the outputs to vendor/<dep>/ and writes vendor/PROVENANCE.json
// {dep, commit, dirty, files:[{path, size, sha256}]}.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEP_NAMES = ['runtime', 'localdata', 'pagetriage', 'glyphsift'];
const HERE = dirname(fileURLToPath(import.meta.url));
export const DOCKIT_ROOT = resolve(HERE, '..');

export class AssembleError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'AssembleError';
    this.exitCode = exitCode;
  }
}

/** Validates deps.lock.json: schema 1, exactly the four dependencies, each a 40-hex lower-case commit. */
export function parseLock(lock) {
  if (lock?.schema !== 1) throw new AssembleError('deps.lock.json: schema must be 1', 2);
  const names = Object.keys(lock.deps ?? {});
  if (names.length !== DEP_NAMES.length || !DEP_NAMES.every((n) => names.includes(n))) {
    throw new AssembleError(`deps.lock.json: deps must be exactly ${DEP_NAMES.join(', ')}`, 2);
  }
  for (const n of DEP_NAMES) {
    const d = lock.deps[n];
    if (d?.repo !== `AirplaneMode-Labs/${n}`)
      throw new AssembleError(`deps.lock.json: ${n}.repo must be AirplaneMode-Labs/${n}`, 2);
    if (typeof d.commit !== 'string' || !/^[0-9a-f]{40}$/.test(d.commit)) {
      throw new AssembleError(
        `deps.lock.json: ${n}.commit must be 40 lower-case hex characters`,
        2,
      );
    }
  }
  return lock;
}

export function parseArgs(argv) {
  const usage = 'usage: assemble-deps.mjs (--siblings <dir> | --checkouts <dir>) [--allow-dirty]';
  let mode;
  let dir;
  let allowDirty = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--siblings' || a === '--checkouts') {
      if (mode !== undefined || argv[i + 1] === undefined) throw new Error(usage);
      mode = a.slice(2);
      dir = argv[++i];
    } else if (a === '--allow-dirty') allowDirty = true;
    else throw new Error(usage);
  }
  if (mode === undefined) throw new Error(usage);
  return { mode, dir, allowDirty };
}

/**
 * Where a dependency's clone or checkout lives: <dir>/<dep> in both modes. <dir> is made absolute first (--siblings .. is relative to the
 * cwd), which on Windows adds the current drive. `pathApi` is the platform's join and resolve; the tests pass path.win32 or path.posix
 * (pinned to a working directory) so both sets of rules run on any host.
 */
export const depDir = (mode, dir, dep, pathApi = { join, resolve }) =>
  pathApi.join(pathApi.resolve(dir), dep);

/**
 * What to run in each dependency and what to take from it. runtime's last step also writes the model bundle
 * (public/models, the ORT files, the signed manifest and the compiled-in trust root) into dockit.
 */
export function buildPlan({ dockitRoot = DOCKIT_ROOT } = {}) {
  const d = (...p) =>
    join(dockitRoot, ...p)
      .split(sep)
      .join('/');
  const ds = d;
  return {
    runtime: {
      steps: [
        { cmd: 'npm', args: ['ci', '--ignore-scripts'] },
        { cmd: 'npm', args: ['run', 'build'] },
        // both models are fetched into runtime's .cache/models: https only, no token, every file re-hashed, a cached file refetched on a mismatch
        { cmd: 'node', args: ['test/tools/fetch-model.mjs', 'qwen3-0.6b-wasm-q8'] },
        { cmd: 'node', args: ['test/tools/fetch-model.mjs', 'multilingual-e5-small-wasm-q8'] },
        { cmd: 'node', args: [ds('scripts', 'copy-ort.mjs'), '--to', d('public', 'app', 'ort')] },
        {
          cmd: 'node',
          args: [
            'scripts/bundle-models.mjs',
            '--set',
            'dockit',
            '--out',
            d('public', 'models'),
            '--root',
            d('public'),
            '--manifest-id',
            'dev.airplanemode.dockit-models',
            '--ort-dir',
            d('public', 'app', 'ort'),
            '--trust-root-out',
            d('src', 'generated', 'trust-root.ts'),
          ],
        },
        {
          cmd: 'node',
          args: [ds('scripts', 'copy-ort.mjs'), '--to', d('public', 'app', 'ort'), '--drop-wasm'],
        },
      ],
      outputs: [{ from: 'dist', to: '.' }],
    },
    localdata: {
      steps: [
        { cmd: 'npm', args: ['ci', '--ignore-scripts'] },
        { cmd: 'npm', args: ['run', 'build:wasm'] },
        { cmd: 'npm', args: ['run', 'build'] },
      ],
      outputs: [{ from: 'dist', to: '.' }],
    },
    pagetriage: {
      // the pdf-feature WASM build (structure of a PDF), written to its own folder so the pixel-only build stays intact
      steps: [
        {
          cmd: 'bash',
          args: ['scripts/build-wasm.sh'],
          env: { PAGETRIAGE_WASM_FEATURES: 'pdf', WASM_OUT: 'dist/wasm-pdf' },
        },
      ],
      outputs: [{ from: 'dist/wasm-pdf/web', to: '.' }],
    },
    glyphsift: {
      steps: [{ cmd: 'bash', args: ['scripts/build-wasm.sh'] }],
      outputs: [{ from: 'dist/wasm/web', to: '.' }],
    },
  };
}

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();

/** Runs one build step. ~/.cargo/bin goes on PATH (wasm-bindgen installs there); arguments are fixed literals. */
export function defaultExec(cwd, cmd, args, env = {}) {
  const sepChar = process.platform === 'win32' ? ';' : ':';
  const path = `${join(homedir(), '.cargo', 'bin')}${sepChar}${process.env.PATH ?? ''}`;
  const win = process.platform === 'win32' && cmd === 'npm';
  const r = spawnSync(win ? 'npm.cmd' : cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env, PATH: path },
    shell: win,
  });
  if (r.status !== 0)
    throw new AssembleError(
      `${cmd} ${args.join(' ')} failed in ${cwd} (exit ${r.status ?? r.signal})`,
    );
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

export async function assembleDeps({
  mode,
  dir,
  allowDirty = false,
  dockitRoot = DOCKIT_ROOT,
  lockPath = join(dockitRoot, 'deps.lock.json'),
  plan = buildPlan({ dockitRoot }),
  exec = defaultExec,
}) {
  if (mode !== 'siblings' && mode !== 'checkouts')
    throw new AssembleError('mode must be siblings or checkouts', 2);
  const lock = parseLock(JSON.parse(readFileSync(lockPath, 'utf8')));
  // 1. every dependency is present, at the locked commit and (unless --allow-dirty) clean, before anything is built
  const state = {};
  for (const dep of DEP_NAMES) {
    const where = depDir(mode, dir, dep);
    if (!existsSync(where)) throw new AssembleError(`${dep}: no folder at ${where}`, 2);
    const head = git(where, 'rev-parse', 'HEAD');
    if (head !== lock.deps[dep].commit) {
      throw new AssembleError(
        `${dep}: HEAD ${head} does not match deps.lock.json (${lock.deps[dep].commit})`,
        2,
      );
    }
    const dirty = git(where, 'status', '--porcelain').length > 0;
    if (dirty && !allowDirty) {
      throw new AssembleError(
        `${dep}: the tree has uncommitted changes; commit them or pass --allow-dirty (recorded as ${head}-dirty)`,
        2,
      );
    }
    state[dep] = { where, head, dirty };
  }
  // 2. build and collect
  const vendor = join(dockitRoot, 'vendor');
  rmSync(vendor, { recursive: true, force: true });
  const deps = [];
  for (const dep of DEP_NAMES) {
    const { where, head, dirty } = state[dep];
    const p = plan[dep] ?? { steps: [], outputs: [] };
    for (const step of p.steps) exec(where, step.cmd, step.args, step.env ?? {});
    const dest = join(vendor, dep);
    mkdirSync(dest, { recursive: true });
    for (const o of p.outputs) {
      const from = join(where, ...o.from.split('/'));
      if (!existsSync(from))
        throw new AssembleError(
          `${dep}: expected build output ${o.from} is missing (looked in ${where})`,
        );
      const to = join(dest, ...o.to.split('/'));
      mkdirSync(statSync(from).isDirectory() ? to : dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
    }
    const files = listFiles(dest).map((f) => {
      const bytes = readFileSync(f);
      return {
        path: relative(dest, f).split(sep).join('/'),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    deps.push({ dep, commit: dirty ? `${head}-dirty` : head, dirty, files });
  }
  const provenance = { schema: 1, assembledBy: 'scripts/assemble-deps.mjs', mode, deps };
  writeFileSync(join(vendor, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const prov = await assembleDeps(args);
    console.log(
      `assembled ${prov.deps.map((d) => `${d.dep}@${d.commit.slice(0, 12)}`).join(', ')} into vendor/`,
    );
  } catch (e) {
    console.error(`assemble-deps: ${e.message}`);
    process.exit(e instanceof AssembleError ? e.exitCode : 2);
  }
}
