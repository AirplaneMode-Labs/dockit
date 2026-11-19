// The dockit analysis worker (D5-05 stages 2 and 5): pagetriage's PDF structure analysis and glyphsift's gate, both as
// WASM. Started by runtime startModuleWorker with the 'dockit-workers' Trusted Types policy; the egress guard (installed
// first) lets it fetch only <base>vendor/, where the two WASM builds are served as they were built.
import './egress-first-analysis.ts';
import { createAnalysisCore, type AnalysisRequest, type WasmModules } from './analysis-core.ts';

interface WasmGlue {
  default(init: { module_or_path: string }): Promise<{ memory?: WebAssembly.Memory }>;
  [fn: string]: unknown;
}

const vendor = (path: string): string =>
  new URL(/* @vite-ignore */ `../vendor/${path}`, import.meta.url).href;

async function loadModules(): Promise<WasmModules> {
  const [pt, gs] = await Promise.all([
    import(/* @vite-ignore */ vendor('pagetriage/pagetriage.js')) as Promise<WasmGlue>,
    import(/* @vite-ignore */ vendor('glyphsift/glyphsift.js')) as Promise<WasmGlue>,
  ]);
  const [ptExports, gsExports] = await Promise.all([
    pt.default({ module_or_path: vendor('pagetriage/pagetriage_bg.wasm') }),
    gs.default({ module_or_path: vendor('glyphsift/glyphsift_bg.wasm') }),
  ]);
  const mem = (e: { memory?: WebAssembly.Memory }) => () =>
    e.memory instanceof WebAssembly.Memory ? e.memory.buffer.byteLength : null;
  return {
    pagetriage: {
      // a pagetriage build without account_pdf_streams leaves this undefined: the call throws and every file is refused as unchecked (fail closed)
      account_pdf_streams: pt[
        'account_pdf_streams'
      ] as WasmModules['pagetriage']['account_pdf_streams'],
      analyse_pdf_structure: pt[
        'analyse_pdf_structure'
      ] as WasmModules['pagetriage']['analyse_pdf_structure'],
      memoryBytes: mem(ptExports),
    },
    glyphsift: {
      gate: gs['gate'] as WasmModules['glyphsift']['gate'],
      memoryBytes: mem(gsExports),
    },
  };
}

const core = loadModules().then(createAnalysisCore);
const scope = self as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  addEventListener(t: 'message', fn: (e: MessageEvent<AnalysisRequest>) => void): void;
};
scope.addEventListener('message', (e) => {
  void core
    .then((c) => c.handle(e.data))
    .then(
      // a triage response hands the request's buffer back by transfer (B1 M3): nothing is copied, and the page can check what came home
      (r) => scope.postMessage(r, r.type === 'triage' ? [r.bytes] : []),
      () =>
        scope.postMessage({
          v: 1,
          id: (e.data as { id?: number } | null)?.id ?? 0,
          type: 'error',
          code: 'corrupt',
        }),
    );
});
