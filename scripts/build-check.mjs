#!/usr/bin/env node
// A STUB build (DOCKIT_DEPS=stub): the app, the workers and the service worker are built and type-checked against stand-ins for the
// four sibling builds, which only scripts/assemble-deps.mjs produces. The page carries a 'stub build' banner and the result is never
// deployed. `npm run ci` uses it so a lone checkout stays green on three OSes.
//
//   node scripts/build-check.mjs              build into a fresh temporary directory, then remove it
//   node scripts/build-check.mjs --out dist   build into ./dist and keep it (the browser specs serve it)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const keep = outIdx >= 0;
const out = keep
  ? resolve(root, args[outIdx + 1] ?? '')
  : mkdtempSync(join(tmpdir(), 'dockit-stub-'));
if (keep && (args[outIdx + 1] ?? '') === '') {
  console.error('build-check: --out needs a directory');
  process.exit(2);
}

const env = { ...process.env, DOCKIT_DEPS: 'stub', DOCKIT_OUT_DIR: out };
const node = process.execPath;
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const steps = [
  [vite, 'build', '--emptyOutDir'],
  [vite, 'build', '-c', 'vite.sw.config.ts'],
  [join(root, 'scripts', 'inject-precache.mjs')],
];
let status = 0;
for (const step of steps) {
  const r = spawnSync(node, step, { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) {
    status = r.status ?? 1;
    break;
  }
}
if (!keep) rmSync(out, { recursive: true, force: true });
else if (status === 0) console.log(`build-check: stub build kept in ${out} (never deploy it)`);
process.exit(status);
