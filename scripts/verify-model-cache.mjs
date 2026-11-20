#!/usr/bin/env node
// Re-hashes the restored model files against the pins runtime committed (test/tools/models.json of the locked runtime checkout), before the assembler
// runs. bench-windows.yml restores the model cache restore-only: a cache is data from an earlier run, so every file in it is checked, never trusted.
//
//   node scripts/verify-model-cache.mjs --checkouts deps [--model <name>]...
//
// A file that is present and differs in size or sha256 stops the job (exit 1; the message names the file and both digests, never its contents).
// A file that is absent is a cold cache: it is reported and left to runtime's own pinned fetcher (https only, no token, every file re-hashed on download).
// A pin path that leaves the cache folder, a model missing from the pins, or a missing pins file is exit 2.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULT_MODELS = ['qwen3-0.6b-wasm-q8', 'multilingual-e5-small-wasm-q8'];
const args = process.argv.slice(2);
const checkouts = args.includes('--checkouts') ? args[args.indexOf('--checkouts') + 1] : undefined;
const models = args.flatMap((a, i) => (a === '--model' ? [args[i + 1]] : []));
const fail = (code, message) => {
  console.error(`verify-model-cache: ${message}`);
  process.exit(code);
};
if (!checkouts || checkouts.startsWith('--'))
  fail(2, 'usage: verify-model-cache.mjs --checkouts <dir> [--model <name>]...');

const runtime = resolve(checkouts, 'runtime');
const pinsFile = join(runtime, 'test', 'tools', 'models.json');
if (!existsSync(pinsFile)) fail(2, `no pins file at ${pinsFile}`);
const pins = JSON.parse(readFileSync(pinsFile, 'utf8')).models ?? {};
const cache = join(runtime, '.cache', 'models');

const sha256 = (file) =>
  new Promise((ok, bad) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', bad);
  });

let verified = 0;
for (const name of models.length > 0 ? models : DEFAULT_MODELS) {
  const model = pins[name];
  if (!model || !Array.isArray(model.files)) fail(2, `${name} is not in ${pinsFile}`);
  const base = join(cache, name);
  for (const f of model.files) {
    const file = resolve(base, ...String(f.path).split('/'));
    const rel = relative(base, file);
    if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..')
      fail(2, `${name}: the pinned path ${JSON.stringify(f.path)} leaves the cache folder`);
    if (!existsSync(file)) {
      console.log(`absent: ${name}/${f.path} (cold cache: runtime's pinned fetcher downloads it)`);
      continue;
    }
    const size = statSync(file).size;
    if (size !== f.size) fail(1, `${name}/${f.path}: size ${size}, pinned ${f.size}`);
    const got = await sha256(file);
    if (got !== f.sha256) fail(1, `${name}/${f.path}: sha256 ${got}, pinned ${f.sha256}`);
    verified += 1;
  }
}
console.log(
  `verify-model-cache: verified ${verified} file${verified === 1 ? '' : 's'} against ${pinsFile.split(sep).slice(-4).join('/')}`,
);
