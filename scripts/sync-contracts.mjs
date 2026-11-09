#!/usr/bin/env node
// Copies the six contract files from the sibling runtime repository (../runtime/spec) into
// src/contracts/, prepending the vendoring header. The source of truth is runtime/spec; never edit
// the vendored copies by hand. `--check` reports in-sync or drift per file, writes nothing and
// exits 1 on drift. Exits 0 and prints a notice when the sibling is absent.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
export const DEFAULT_SPEC_DIR = join(root, '..', 'runtime', 'spec');
export const DEFAULT_OUT_DIR = join(root, 'src', 'contracts');

// Each contract carries its own version (spec release 0.2.0): the header names that contract's
// version, not the release's.
export const CONTRACT_VERSIONS = {
  'manifest.ts': '0.1.0',
  'capability-profile.ts': '0.1.0',
  'event.ts': '0.1.1',
  'storage-api.ts': '0.1.0',
  'backend-adapter.ts': '0.2.0',
  'model-descriptor.ts': '0.1.0',
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
 * Compare (and optionally rewrite) every vendored contract against runtime/spec.
 * Returns one { file, target, status } per contract with status
 * 'in-sync' | 'drift' | 'updated' | 'source-missing'. Nothing is written when write is false.
 */
export function sync({ specDir = DEFAULT_SPEC_DIR, outDir = DEFAULT_OUT_DIR, write = true } = {}) {
  const results = [];
  for (const file of CONTRACT_FILES) {
    const source = join(specDir, file);
    const target = join(outDir, file);
    if (!existsSync(source)) {
      results.push({ file, target, status: 'source-missing' });
      continue;
    }
    const src = readFileSync(source, 'utf8');
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const inSync = vendoredBody(current) === src;
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
  const results = sync({ write: !check });
  for (const r of results) console.log(`${r.status}\t${r.target}`);
  if (check && results.some((r) => r.status === 'drift')) process.exit(1);
}
