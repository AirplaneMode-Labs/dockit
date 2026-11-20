#!/usr/bin/env node
// Copies the six contract files from the sibling runtime repository (../runtime/spec) into
// src/contracts/, prepending the vendoring header. The source of truth is runtime/spec; never edit
// the vendored copies by hand. `--check` reports in-sync or drift per file, writes nothing and
// exits 1 on drift. Exits 0 and prints a notice when the sibling is absent.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
export const DEFAULT_SPEC_DIR = join(root, '..', 'runtime', 'spec');
// D1 writes SPEC-LANDED.txt when the spec release has landed: one `sha256  path` line per spec file.
// Lookup order (resolveSpecLandedPath): env SPEC_LANDED (a missing file is an error), then the highest-numbered
// <workspace>/evidence/sprint-<n>/D1/SPEC-LANDED.txt that exists (the committed copy). No scratch path is baked in.
export const DEFAULT_OUT_DIR = join(root, 'src', 'contracts');

// Each contract carries its own version (spec release 0.6.1, 2026-11-20, untagged): the header names that contract's version, not the release's.
// Manifest 0.1.4 is "manifest spec v0.1" (published, an additive patch: the Release manifests section); event 0.1.6 and storage API 0.4.1 are draft
// patches; the capability profile, backend adapter and model descriptor keep the versions they had in 0.6.0.
export const CONTRACT_VERSIONS = {
  'manifest.ts': '0.1.4',
  'capability-profile.ts': '0.1.1',
  'event.ts': '0.1.6',
  'storage-api.ts': '0.4.1',
  'backend-adapter.ts': '0.5.0',
  'model-descriptor.ts': '0.2.1',
};
export const CONTRACT_FILES = Object.keys(CONTRACT_VERSIONS);
export const header = (file) => {
  const version = CONTRACT_VERSIONS[file];
  if (version === undefined) throw new Error(`sync-contracts: no version recorded for ${file}`);
  return `// Vendored from AirplaneMode-Labs/runtime spec/${file} @ ${version}; source of truth is runtime/spec; do not edit here\n`;
};

export function vendoredBody(text) {
  // Strip the single-line vendoring header so the remainder can be diffed against the source.
  const nl = text.indexOf('\n');
  return text.startsWith('// Vendored from ') && nl !== -1 ? text.slice(nl + 1) : text;
}

/**
 * The digest map for a SPEC-LANDED.txt: its `sha256  path` lines when it has any, else the `files` object of the LANDED.json beside it (D1 writes both
 * since Sprint 7: the .txt is prose, the .json holds { files: { 'spec/<file>': sha256 } }). A missing LANDED.json gives an empty map (every file is then
 * sha-missing and nothing is written); one that is not valid JSON, has no files object or holds a digest that is not 64 lower-case hex is an error.
 */
export function readLandedFrom(landedTxtPath) {
  const fromLines = parseLanded(readFileSync(landedTxtPath, 'utf8'));
  if (fromLines.size > 0) return fromLines;
  const json = join(dirname(landedTxtPath), 'LANDED.json');
  if (!existsSync(json)) return fromLines;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(json, 'utf8'));
  } catch (e) {
    throw new Error(`${json}: LANDED.json is not valid JSON (${e.message})`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.files === null ||
    typeof parsed.files !== 'object'
  )
    throw new Error(`${json}: LANDED.json has no files object`);
  const map = new Map();
  for (const [path, digest] of Object.entries(parsed.files)) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest))
      throw new Error(`${json}: the sha256 of ${path} is not 64 lower-case hex characters`);
    map.set(path.split('/').pop(), digest);
  }
  return map;
}

/** Parses `shasum -a 256` style lines into Map<basename, sha256>; other lines are ignored. */
export function parseLanded(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/u.exec(line.trim());
    if (m) map.set(m[2].split('/').pop(), m[1]);
  }
  return map;
}

/**
 * Where SPEC-LANDED.txt is read from. Order: env SPEC_LANDED, then the highest-numbered
 * <workspace>/evidence/sprint-<n>/D1/SPEC-LANDED.txt that exists (n compared as a number). An env value naming a
 * missing file is an error and never falls through to another copy. Returns { path, via } on success, or
 * { path: undefined, via?, tried } listing every place looked at (highest sprint first).
 * @param {{ env?: Record<string, string | undefined>, root?: string, exists?: (p: string) => boolean, readdir?: (p: string) => string[] }} [opts]
 */
export function resolveSpecLandedPath({
  env = process.env,
  root: repoRoot = root,
  exists = existsSync,
  readdir = (p) => readdirSync(p),
} = {}) {
  const fromEnv = env.SPEC_LANDED;
  if (fromEnv !== undefined && fromEnv !== '') {
    return exists(fromEnv)
      ? { path: fromEnv, via: 'env' }
      : { path: undefined, via: 'env', tried: [fromEnv] };
  }
  const evidenceDir = join(repoRoot, '..', 'evidence');
  let sprints = [];
  try {
    sprints = readdir(evidenceDir)
      .map((name) => /^sprint-(\d+)$/u.exec(name))
      .filter((m) => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => b - a);
  } catch {
    sprints = [];
  }
  if (sprints.length === 0) {
    return { path: undefined, tried: [join(evidenceDir, 'sprint-<n>', 'D1', 'SPEC-LANDED.txt')] };
  }
  const tried = [];
  for (const n of sprints) {
    const candidate = join(evidenceDir, `sprint-${n}`, 'D1', 'SPEC-LANDED.txt');
    tried.push(candidate);
    if (exists(candidate)) return { path: candidate, via: 'evidence' };
  }
  return { path: undefined, tried };
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Compare (and optionally rewrite) every vendored contract against runtime/spec.
 * Returns one { file, target, status } per contract with status
 * 'in-sync' | 'drift' | 'updated' | 'source-missing' | 'sha-mismatch' | 'sha-missing'. Nothing is
 * written when write is false. When `landed` (from parseLanded) is given, every source file's sha256
 * must equal its entry; any mismatch or absent entry fails the whole sync and nothing is written.
 */
/** @param {{ specDir?: string, outDir?: string, write?: boolean, landed?: Map<string, string> | undefined }} [opts] */
export function sync({
  specDir = DEFAULT_SPEC_DIR,
  outDir = DEFAULT_OUT_DIR,
  write = true,
  landed = undefined,
} = {}) {
  const results = [];
  if (landed !== undefined) {
    let failed = false;
    const checks = [];
    for (const file of CONTRACT_FILES) {
      const source = join(specDir, file);
      const target = join(outDir, file);
      if (!existsSync(source)) {
        checks.push({ file, target, status: 'source-missing' });
        failed = true;
        continue;
      }
      const want = landed.get(file);
      const got = sha256(readFileSync(source, 'utf8'));
      const status = want === undefined ? 'sha-missing' : want === got ? 'ok' : 'sha-mismatch';
      if (status !== 'ok') failed = true;
      checks.push({ file, target, status });
    }
    if (failed) return checks.map((r) => (r.status === 'ok' ? { ...r, status: 'blocked' } : r));
  }
  for (const file of CONTRACT_FILES) {
    const source = join(specDir, file);
    const target = join(outDir, file);
    if (!existsSync(source)) {
      results.push({ file, target, status: 'source-missing' });
      continue;
    }
    const src = readFileSync(source, 'utf8');
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    // the body AND the header: a body that matches under a header naming an older contract version is drift too
    const inSync = current === header(file) + src;
    if (!inSync && write) writeFileSync(target, header(file) + src);
    results.push({ file, target, status: inSync ? 'in-sync' : write ? 'updated' : 'drift' });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(DEFAULT_SPEC_DIR)) {
    console.log(`sync-contracts: ${DEFAULT_SPEC_DIR} not found; nothing to do`);
    process.exit(0);
  }
  const check = process.argv.includes('--check');
  const located = resolveSpecLandedPath();
  if (located.path === undefined) {
    console.error(
      `sync-contracts: SPEC-LANDED.txt does not exist (${located.tried.join(', ')}): the spec has not landed or SPEC_LANDED is wrong; nothing synced`,
    );
    process.exit(1);
  }
  console.log(`sync-contracts: SPEC-LANDED.txt from ${located.via}: ${located.path}`);
  const landed = readLandedFrom(located.path);
  const results = sync({ write: !check, landed });
  for (const r of results) console.log(`${r.status}\t${r.target}`);
  const bad = new Set(['drift', 'sha-mismatch', 'sha-missing', 'source-missing', 'blocked']);
  if (results.some((r) => bad.has(r.status))) process.exit(1);
}
