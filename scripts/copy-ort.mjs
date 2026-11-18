#!/usr/bin/env node
// Prepares the pinned ONNX Runtime Web files for runtime's bundle-models (its --ort-dir input) and tidies afterwards. Run by
// assemble-deps with the runtime checkout as the working directory.
//
//   node scripts/copy-ort.mjs --to <dir>                copies the .wasm and the .mjs factory named by src/backends/ort-pins.ts
//                                                       from node_modules/onnxruntime-web/dist into <dir>
//   node scripts/copy-ort.mjs --to <dir> --drop-wasm    removes the .wasm again: it is an entry of the signed manifest (models/ort/)
//                                                       and the engine receives that verified copy, so a second 26 MB file would
//                                                       only add size. The .mjs factory stays: the page loads it as a script.
//
// bundle-models re-hashes both files against the pins, so a wrong file fails the build there.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function ortFileNames(runtimeRoot) {
  const text = readFileSync(join(runtimeRoot, 'src', 'backends', 'ort-pins.ts'), 'utf8');
  const wasm = /export const ORT_WASM_FILE = '([A-Za-z0-9._-]+)'/.exec(text)?.[1];
  const factory = /export const ORT_FACTORY_FILE = '([A-Za-z0-9._-]+)'/.exec(text)?.[1];
  if (!wasm || !factory)
    throw new Error('src/backends/ort-pins.ts does not define ORT_WASM_FILE and ORT_FACTORY_FILE');
  return { wasm, factory };
}

export function copyOrt(runtimeRoot, to) {
  const { wasm, factory } = ortFileNames(runtimeRoot);
  mkdirSync(to, { recursive: true });
  for (const name of [wasm, factory]) {
    const from = join(runtimeRoot, 'node_modules', 'onnxruntime-web', 'dist', name);
    if (!existsSync(from))
      throw new Error(`${from} is missing: run npm ci --ignore-scripts in the runtime checkout`);
    copyFileSync(from, join(to, name));
  }
}

export function dropWasm(runtimeRoot, to) {
  rmSync(join(to, ortFileNames(runtimeRoot).wasm), { force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--to');
  if (
    i < 0 ||
    args[i + 1] === undefined ||
    args.some((a) => !['--to', '--drop-wasm', args[i + 1]].includes(a))
  ) {
    console.error(
      'usage: copy-ort.mjs --to <dir> [--drop-wasm]   (run with the runtime checkout as the working directory)',
    );
    process.exit(2);
  }
  const to = resolve(args[i + 1]);
  if (args.includes('--drop-wasm')) dropWasm(process.cwd(), to);
  else copyOrt(process.cwd(), to);
}
