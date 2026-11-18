/**
 * Builds the two engine adapters (answer model and embedder) over the verified, cached files. Each model gets its own
 * runtime worker adapter: one engine worker holds one model. Nothing is downloaded here: the assets are acquired with
 * cacheOnly from the AssetManager that already verified the manifest.
 */
import engineWorkerUrl from 'virtual:dockit-deps/runtime/worker/engine-worker.js?worker&url';
import type { BackendAdapter } from '../contracts/backend-adapter.ts';
import type { CapabilityProfile } from '../contracts/capability-profile.ts';
import type { EventSink } from '../contracts/event.ts';
import type { AssetsPort, LoadedModels, ManifestLike } from '../model/model-service.ts';
import { specialTokensFromTokenizerJson } from '../pipeline/prompt.ts';
import * as backends from 'virtual:dockit-deps/runtime/backends/index.js';
import { runtime } from '../deps/runtime.ts';

interface AssetSourceLike {
  getBlob(entryId: string, opts?: { rehash?: boolean }): Promise<Blob>;
  getEntry(entryId: string): unknown;
}

interface DefaultAdapterOptions {
  ortFactoryUrl: string;
  workerUrl: string;
}

const GENERATOR_DESCRIPTOR = 'qwen3-0.6b.descriptor';
const EMBEDDER_DESCRIPTOR = 'multilingual-e5-small.descriptor';
const TOKENIZER_ENTRY = 'qwen3-0.6b.tokenizer';

type RuntimeFns = {
  detectCapabilities(): Promise<CapabilityProfile>;
};
type BackendFns = {
  createDefaultAdapters(o: DefaultAdapterOptions): (BackendAdapter & { device: string })[];
  ORT_FACTORY_FILE?: string;
};

export async function loadAdapters(
  manifest: ManifestLike,
  assets: AssetsPort,
  opts: { cacheOnly: boolean; events: EventSink },
): Promise<LoadedModels> {
  const rt = runtime as unknown as RuntimeFns;
  const be = backends as unknown as BackendFns;
  const profile = await rt.detectCapabilities();
  const ortFactoryUrl = new URL(
    `./app/ort/${be.ORT_FACTORY_FILE ?? 'ort-wasm-simd-threaded.asyncify.mjs'}`,
    document.baseURI,
  ).href;
  const mk = () => {
    const a = be
      .createDefaultAdapters({ ortFactoryUrl, workerUrl: engineWorkerUrl })
      .find((x) => x.device === 'wasm');
    if (a === undefined) throw new Error('no WebAssembly adapter');
    return a;
  };
  const source = assets as unknown as AssetSourceLike;
  const ids = new Set(manifest.entries.map((e) => e.id));
  for (const id of [GENERATOR_DESCRIPTOR, EMBEDDER_DESCRIPTOR])
    if (!ids.has(id)) throw new Error(`the model list has no entry ${id}`);

  const generator = mk();
  const embedder = mk();
  const load = { assets: source, profile, events: opts.events, cacheOnly: opts.cacheOnly } as never;
  await generator.load(source.getEntry(GENERATOR_DESCRIPTOR) as never, load);
  await embedder.load(source.getEntry(EMBEDDER_DESCRIPTOR) as never, load);

  let specialTokens: readonly string[] = [];
  if (ids.has(TOKENIZER_ENTRY)) {
    const blob = await source.getBlob(TOKENIZER_ENTRY);
    specialTokens = specialTokensFromTokenizerJson(JSON.parse(await blob.text()));
  }
  return {
    generator,
    embedder,
    specialTokens,
    // a failed unload of one must not keep the other loaded
    unload: async () => {
      await Promise.allSettled([generator.unload(), embedder.unload()]);
    },
  };
}
