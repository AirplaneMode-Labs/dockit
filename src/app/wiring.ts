/**
 * The real dependencies of the app: the two workers, pdf.js, localdata, the runtime AssetManager and the engine adapters.
 * Nothing here runs in a unit test (those use fakes); the built page is exercised by test/e2e.spec.ts.
 */
import type { Event } from '../contracts/event.ts';
import { createStore } from '../deps/localdata.ts';
import { runtime } from '../deps/runtime.ts';
import { openManifestStore } from '../model/manifest-store.ts';
import { DOCKIT_MANIFEST_ID } from '../model/manifest-id.ts';
import { createModelService, type AssetsPort } from '../model/model-service.ts';
import { EventLog } from '../pipeline/events.ts';
import { TRUSTED_KEYS } from '../trust.ts';
import { startAnalysisWorker, startPdfWorker } from '../workers/start.ts';
import { createAnalysisClient } from '../workers/analysis-client.ts';
import { extractPdfText } from '../workers/pdf-extract.ts';
import { loadPdfJs } from '../workers/pdf-loader.ts';
import { loadAdapter } from './adapters.ts';
import { AppController } from './controller.ts';

export const events = new EventLog(500);

// The runtime DevTools hook: window.__airplanemodeDevtools.snapshot() returns the timing, memory and model events of this page (counts, timings
// and enums only, never a file name, text, question or answer). The runtime DevTools panel and the benchmark read it.
(runtime as { exposeDevtoolsHook?: (s: { snapshot(): Event[] }) => unknown }).exposeDevtoolsHook?.(
  events,
);

interface AssetManagerLike extends AssetsPort {
  loadManifest(
    manifest: unknown,
    trust: ReadonlyMap<string, Uint8Array>,
    opts: { baseUrl: string },
  ): Promise<unknown>;
}

/**
 * The runtime's capability profile. The verdict against the model's minimum is not decided here: the memory line is read from the verified
 * manifest's answer entry by the model service and the controller (B1 M6, TD-67). No threshold is a constant of the page.
 */
async function detectCapability() {
  const rt = runtime as unknown as {
    detectCapabilities(): Promise<import('../contracts/capability-profile.ts').CapabilityProfile>;
  };
  return { profile: await rt.detectCapabilities() };
}

export async function createAppController(): Promise<AppController> {
  const framed = window.top !== window.self;
  const analysis = createAnalysisClient({ startWorker: startAnalysisWorker as never });
  const memory = await createStore({ driver: 'memory', events });
  const AssetManager = (
    runtime as unknown as { AssetManager: new (o: unknown) => AssetManagerLike }
  ).AssetManager;
  const assets = new AssetManager({
    store: 'auto',
    allowedOrigins: [location.origin],
    expectManifestId: DOCKIT_MANIFEST_ID,
    events,
  });
  const manifests = await openManifestStore();
  const modelsUrl = new URL('models/manifest.json', document.baseURI).href;
  const models = createModelService({
    expectManifestId: DOCKIT_MANIFEST_ID,
    baseURI: document.baseURI,
    online: () => navigator.onLine,
    fetchManifestBytes: async () => {
      const res = await fetch(modelsUrl, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    manifests,
    assets,
    trust: TRUSTED_KEYS,
    events,
    loadAdapter: (kind, m, a, o) => loadAdapter(kind, m, a, { ...o, events }),
    profile: async () => (await detectCapability()).profile,
  });
  return new AppController({
    framed,
    events: events as unknown as {
      emit(e: Event): void;
      subscribe(fn: (e: Event) => void): () => void;
    },
    models,
    pipelineDeps: {
      store: memory,
      persistent: () => createStore({ driver: 'opfs', events }),
      analysis,
      extract: async (bytes, pages) =>
        extractPdfText({
          lib: await loadPdfJs(),
          startWorker: startPdfWorker as never,
          bytes,
          pages,
          assetBase: new URL('./pdfjs/', document.baseURI).href,
        }),
    },
    detectCapability,
    online: () => navigator.onLine,
  });
}
