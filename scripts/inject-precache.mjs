#!/usr/bin/env node
// Runs after `vite build` and the service-worker logic build. It
//   1. derives the build hash from dist/.vite/manifest.json,
//   2. lists every file of the app shell under dist/ with its SHA-256,
//   3. splices the bundled routing module (dist/sw-logic.iife.js) and the precache list into
//      the hand-written public/sw.js template, writing dist/sw.js,
//   4. removes the intermediate sw-logic bundle.
// It exits non-zero if the precache list would be empty or any placeholder is missing.
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
const template = join(root, 'public', 'sw.js');
const logicBundle = join(dist, 'sw-logic.iife.js');
const viteManifest = join(dist, '.vite', 'manifest.json');

function fail(msg) {
  console.error(`inject-precache: ${msg}`);
  process.exit(1);
}

if (!existsSync(dist)) fail('dist/ does not exist; run vite build first');
if (!existsSync(viteManifest))
  fail('dist/.vite/manifest.json missing; build.manifest must be true');
if (!existsSync(logicBundle))
  fail('dist/sw-logic.iife.js missing; run vite build -c vite.sw.config.ts');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const buildHash = sha256(readFileSync(viteManifest)).slice(0, 16);

// Files that are never precached: the worker itself, its intermediate bundle, Vite metadata.
const EXCLUDE = new Set(['sw.js', 'sw-logic.iife.js']);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(dist, full).split(sep).join('/');
    if (rel === '.vite' || rel.startsWith('.vite/')) continue;
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (!EXCLUDE.has(rel)) acc.push(rel);
  }
  return acc;
}

const entries = walk(dist)
  .sort()
  .map((rel) => ({ url: `./${rel}`, sha256: sha256(readFileSync(join(dist, rel))) }));

if (entries.length === 0) fail('precache list is empty');
if (!entries.some((e) => e.url === './index.html')) fail('index.html missing from dist');
if (!entries.some((e) => e.url === './offline.html')) fail('offline.html missing from dist');

const tpl = readFileSync(template, 'utf8');
const logic = readFileSync(logicBundle, 'utf8');
for (const marker of ['/* __SW_LOGIC__ */', '__BUILD_HASH__', '/* __PRECACHE__ */ []']) {
  if (!tpl.includes(marker)) fail(`template public/sw.js lacks marker ${marker}`);
}
const out = tpl
  .replace('/* __SW_LOGIC__ */', () => logic.trimEnd())
  .replace('__BUILD_HASH__', buildHash)
  .replace('/* __PRECACHE__ */ []', () => JSON.stringify(entries, null, 2));

writeFileSync(join(dist, 'sw.js'), out);
unlinkSync(logicBundle);
console.log(`inject-precache: build ${buildHash}, ${entries.length} precache entries`);
