#!/usr/bin/env node
// Writes public/THIRD-PARTY-NOTICES.txt from the licence files of the packages the built app bundles, verbatim under a "<name> <version>" heading.
//   node scripts/make-notices.mjs           write the file
//   node scripts/make-notices.mjs --check   exit 1 unless the file is up to date
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'public', 'THIRD-PARTY-NOTICES.txt');

/** Bundled npm packages. onnxruntime-web and onnxruntime-common ship no licence file in the package: their MIT text is the one below. */
export const PACKAGES = [
  'react',
  'react-dom',
  'scheduler',
  'pdfjs-dist',
  '@huggingface/transformers',
  '@huggingface/jinja',
  'onnxruntime-web',
  'onnxruntime-common',
];
export const ORT_MIT = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export const MODELS = `Models (not part of this file's packages; downloaded once from this page's own origin and verified against a signed manifest)
  Qwen3-0.6B, Apache-2.0, Copyright (c) Alibaba Cloud (the Qwen team). Base model Qwen/Qwen3-0.6B; files from onnx-community/Qwen3-0.6B-ONNX at revision 79346d370dfae34801d26993fda9ae2372900fd0. The licence text is served with the model as models/LICENSE-Qwen3-0.6B.txt.
  multilingual-e5-small, MIT per the intfloat/multilingual-e5-small model card. Files from Xenova/multilingual-e5-small at revision 761b726dd34fb83930e26aab4e9ac3899aa1fa78. The licence text is served as models/LICENSE-multilingual-e5-small.txt.`;

export function build() {
  const parts = [
    'Third-party notices for dockit',
    '',
    'dockit bundles the packages below. Their licence texts follow verbatim.',
    '',
  ];
  for (const name of PACKAGES) {
    const dir = join(root, 'node_modules', name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const lic = existsSync(join(dir, 'LICENSE'))
      ? readFileSync(join(dir, 'LICENSE'), 'utf8').trim()
      : ORT_MIT;
    parts.push(
      '='.repeat(72),
      `${name} ${pkg.version} (${pkg.license})`,
      '='.repeat(72),
      '',
      lic,
      '',
    );
  }
  parts.push('='.repeat(72), 'Models', '='.repeat(72), '', MODELS, '');
  return parts.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = build();
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
      console.error(
        'public/THIRD-PARTY-NOTICES.txt is out of date: run node scripts/make-notices.mjs',
      );
      process.exit(1);
    }
    console.log('public/THIRD-PARTY-NOTICES.txt is up to date');
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
