/**
 * Side-effect module, imported FIRST by the pdf worker: installs the runtime egress guard on the worker's own scope
 * before pdf.js is evaluated. The guard allows only same-origin URLs under the pdf.js asset folder (cmaps and
 * standard fonts); every other fetch, XMLHttpRequest, WebSocket, EventSource, importScripts and nested Worker is
 * refused. ES module evaluation runs imports in order, so this module's body runs before pdf.js loads.
 */
import { installEgressGuard } from '../deps/worker-support.ts';

installEgressGuard({
  allowPathPrefixes: [new URL(/* @vite-ignore */ '../pdfjs/', import.meta.url).pathname],
});
