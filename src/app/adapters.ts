/**
 * Builds an engine adapter (answer model or embedder) over the verified, cached files. Each model gets its own runtime worker adapter: one
 * engine worker holds one model, and only one is loaded at a time. Nothing is downloaded here: the assets are acquired with cacheOnly from the
 * AssetManager that already verified the manifest.
 */
import engineWorkerUrl from 'virtual:dockit-deps/runtime/worker/engine-worker.js?worker&url';
import type { BackendAdapter } from '../contracts/backend-adapter.ts';
import type { CapabilityProfile } from '../contracts/capability-profile.ts';
import type { EventSink } from '../contracts/event.ts';
import type { AssetsPort, ManifestLike } from '../model/model-service.ts';
import type { EngineKind, LoadedEngine } from '../model/model-pool.ts';
import { EMBEDDER_DESCRIPTOR, GENERATOR_DESCRIPTOR, TOKENIZER_ENTRY } from '../model/entries.ts';
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

type RuntimeFns = {
  detectCapabilities(): Promise<CapabilityProfile>;
};
type BackendFns = {
  createDefaultAdapters(o: DefaultAdapterOptions): (BackendAdapter & { device: string })[];
  ORT_FACTORY_FILE?: string;
};

/**
 * Loads ONE engine (B1 M1): the answer model or the embedder, each in a runtime worker of its own, a first load every time (R19). The manifest
 * was just re-verified by the model service; the files are acquired with cacheOnly (a miss is a refusal, never a fetch) and re-hashed in the
 * worker (R15) by the adapter's own load. The release ends the worker, which returns its WebAssembly memory to the system (R16).
 */
export async function loadAdapter(
  kind: EngineKind,
  manifest: ManifestLike,
  assets: AssetsPort,
  opts: { cacheOnly: boolean; events: EventSink },
): Promise<LoadedEngine> {
  const rt = runtime as unknown as RuntimeFns;
  const be = backends as unknown as BackendFns;
  // TD-84: the adapter is given the real profile; runtime 0.6.0's satisfies() reads ramGb 0 (not exposed) as unknown, never below a minimum
  const profile = await rt.detectCapabilities();
  const ortFactoryUrl = new URL(
    `./app/ort/${be.ORT_FACTORY_FILE ?? 'ort-wasm-simd-threaded.asyncify.mjs'}`,
    document.baseURI,
  ).href;
  const adapter = be
    .createDefaultAdapters({ ortFactoryUrl, workerUrl: engineWorkerUrl })
    .find((x) => x.device === 'wasm');
  if (adapter === undefined) throw new Error('no WebAssembly adapter');
  const source = assets as unknown as AssetSourceLike;
  const ids = new Set(manifest.entries.map((e) => e.id));
  const descriptor = kind === 'generator' ? GENERATOR_DESCRIPTOR : EMBEDDER_DESCRIPTOR;
  if (!ids.has(descriptor)) throw new Error(`the model list has no entry ${descriptor}`);

  const unload = async (): Promise<void> => {
    await adapter.unload();
  };
  try {
    const load = {
      assets: source,
      profile,
      events: opts.events,
      cacheOnly: opts.cacheOnly,
    } as never;
    await adapter.load(source.getEntry(descriptor) as never, load);
    let specialTokens: readonly string[] = [];
    if (kind === 'generator' && ids.has(TOKENIZER_ENTRY)) {
      const blob = await source.getBlob(TOKENIZER_ENTRY);
      specialTokens = specialTokensFromTokenizerJson(JSON.parse(await blob.text()));
    }
    return { adapter, specialTokens, unload };
  } catch (e) {
    // a load that failed must not leave its worker behind
    await unload().catch(() => undefined);
    throw e;
  }
}
