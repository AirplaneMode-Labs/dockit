import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveDepsMode } from './scripts/deps-mode.mjs';

const root = dirname(fileURLToPath(import.meta.url));
/** 'Built from main at <sha12>' in CI (VITE_BUILD_SHA is the 40-hex GITHUB_SHA), else 'Local build <sha12>[-dirty]'. */
function buildId(): string {
  const ci = process.env['VITE_BUILD_SHA'] ?? '';
  if (/^[0-9a-f]{40}$/.test(ci)) return `Built from main at ${ci.slice(0, 12)}`;
  try {
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', root, ...a], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const sha = git('rev-parse', 'HEAD').slice(0, 12);
    // untracked files do not count: vendor/, public/models and src/generated are ignored, and a new source file shows as modified once added
    const dirty = git('status', '--porcelain', '--untracked-files=no').length > 0;
    return `Local build ${sha}${dirty ? '-dirty' : ''}`;
  } catch {
    return 'Local build unknown';
  }
}

const mode = resolveDepsMode({
  env: process.env,
  hasProvenance: existsSync(join(root, 'vendor', 'PROVENANCE.json')),
});

/**
 * Development only: the React fast-refresh preamble is an inline module script, which the
 * strict CSP in index.html forbids. The dev server therefore strips the CSP meta; the
 * production build keeps it verbatim. Production is what the Playwright spec tests.
 */
function stripCspInDev(): Plugin {
  return {
    name: 'dockit-strip-csp-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/u, '');
    },
  };
}

/**
 * Build-time rewrite of the endpoints @huggingface/transformers ships as defaults. The runtime adapter always overrides them at run
 * time (remoteHost, the ONNX Runtime wasmPaths on a CDN), and the third sits on a Node-only code path; rewriting all three means the
 * built page names no Hugging Face or CDN endpoint, so even a bypassed override could not reach one. The build fails if a literal is
 * not found, so a library update is reviewed. (Same list as runtime/demo/engine-defaults.ts.)
 */
const ENGINE_DEFAULTS: [string, string][] = [
  ['remoteHost: "https://huggingface.co/"', 'remoteHost: "https://invalid.invalid/"'],
  [
    '`https://cdn.jsdelivr.net/npm/onnxruntime-web@${',
    '`https://invalid.invalid/onnxruntime-web@${',
  ],
  ['["huggingface.co", "hf.co"]', '["invalid.invalid"]'],
];
const neutraliseEngineDefaults: Plugin = {
  name: 'dockit-neutralise-engine-defaults',
  apply: 'build',
  transform(code, id) {
    if (!/@huggingface[\\/]transformers[\\/]dist[\\/]transformers\.web\.js$/.test(id)) return null;
    let out = code;
    for (const [from, to] of ENGINE_DEFAULTS) {
      if (!out.includes(from))
        throw new Error(
          `transformers.web.js no longer contains ${from}: review the engine defaults`,
        );
      out = out.split(from).join(to);
    }
    return { code: out, map: null };
  },
};

/**
 * onnxruntime-web's JS names its own wasm with new URL('...wasm', import.meta.url), which vite would copy into the output: a second
 * 28 MB copy that is never fetched (the engine is handed the verified binary from the signed manifest). Drop it.
 */
const dropEmittedWasm: Plugin = {
  name: 'dockit-drop-emitted-wasm',
  apply: 'build',
  generateBundle(_o, bundle) {
    for (const name of Object.keys(bundle))
      if (bundle[name]?.type === 'asset' && name.endsWith('.wasm')) delete bundle[name];
  },
};

/**
 * Files that are served as they are, not bundled: the pagetriage and glyphsift WASM builds (the analysis worker imports
 * them from <base>vendor/ and the egress guard allows exactly that prefix) and pdf.js's cmaps and standard fonts
 * (<base>pdfjs/, the other prefix the pdf worker's guard allows). scripts/inject-precache.mjs lists each with its sha256.
 */
function copyServedAssets(): Plugin {
  return {
    name: 'dockit-copy-served-assets',
    apply: 'build',
    closeBundle() {
      const out = resolve(root, process.env['DOCKIT_OUT_DIR'] ?? 'dist');
      const pdfjs = join(root, 'node_modules', 'pdfjs-dist');
      for (const dir of ['cmaps', 'standard_fonts']) {
        mkdirSync(join(out, 'pdfjs', dir), { recursive: true });
        cpSync(join(pdfjs, dir), join(out, 'pdfjs', dir), { recursive: true });
      }
      if (mode === 'vendor') {
        for (const dep of ['pagetriage', 'glyphsift']) {
          mkdirSync(join(out, 'vendor', dep), { recursive: true });
          // the .js glue and the .wasm only: the .d.ts files are type declarations, not part of the page
          cpSync(join(root, 'vendor', dep), join(out, 'vendor', dep), {
            recursive: true,
            filter: (src) => !src.endsWith('.d.ts'),
          });
        }
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [
    react(),
    stripCspInDev(),
    neutraliseEngineDefaults,
    dropEmittedWasm,
    copyServedAssets(),
  ],
  resolve: {
    alias: {
      'virtual:dockit-trust-root':
        mode === 'stub'
          ? join(root, 'src', 'deps', 'stub', 'trust-root.ts')
          : join(root, 'src', 'generated', 'trust-root.ts'),
      'virtual:dockit-deps':
        mode === 'stub' ? join(root, 'src', 'deps', 'stub') : join(root, 'vendor'),
    },
  },
  define: {
    __DOCKIT_STUB__: JSON.stringify(mode === 'stub'),
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildId()),
  },
  // Workers (pdf, analysis, engine) are ES modules, built beside the page chunks in app/.
  worker: { format: 'es', plugins: () => [neutraliseEngineDefaults, dropEmittedWasm] },
  build: {
    target: 'es2022',
    manifest: true,
    // Vite's default bundle directory is assets/. dockit reserves /assets/* for large model
    // and data files that the service worker must pass through, so the bundle lives in app/.
    assetsDir: 'app',
    sourcemap: false,
    outDir: process.env['DOCKIT_OUT_DIR'] ?? 'dist',
    // onnxruntime-web's own wasm is never fetched (the verified ORT build under public/app/ort/ is handed to the engine)
    chunkSizeWarningLimit: 4000,
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
