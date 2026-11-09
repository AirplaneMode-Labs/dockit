import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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

export default defineConfig({
  base: './',
  plugins: [react(), stripCspInDev()],
  build: {
    target: 'es2022',
    manifest: true,
    // Vite's default bundle directory is assets/. dockit reserves /assets/* for large model
    // and data files that the service worker must pass through, so the bundle lives in app/.
    assetsDir: 'app',
    sourcemap: false,
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
