import { defineConfig } from 'vite';

/**
 * Second build step: bundle the pure routing module into a classic script that
 * public/sw.js can consume. scripts/inject-precache.mjs splices the output into dist/sw.js.
 */
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    lib: {
      entry: 'src/sw-logic.ts',
      formats: ['iife'],
      name: 'SW_LOGIC',
      fileName: () => 'sw-logic.iife.js',
    },
  },
});
