/**
 * One engine at a time (B1 M1). The embedder and the answer model never sit in memory together: every use loads the engine it needs from the
 * verified, cached files, runs, and unloads it (its worker is terminated, so its WebAssembly memory goes back to the system, backend adapter
 * R16) before the next engine loads. Every load is a first load (R19): nothing is remembered between uses, no 'already verified' flag skips
 * the manifest re-verification, the cache-only acquire or the in-worker re-hash that the loader repeats.
 *
 * The per-question order is fixed by the pipeline: useEmbedder (embed the question) then useGenerator (answer), and the next question's
 * embedder loads only after the generator has been released. An ingest holds one embedder lease across all of its batches.
 *
 * Pure of the browser: the loader is injected (the real one is built in src/app/adapters.ts), so the unit tests run on three operating systems.
 */
import type { BackendAdapter } from '../contracts/backend-adapter.ts';

export type EngineKind = 'embedder' | 'generator';

/** What a loader gives back: the adapter, the tokenizer's special tokens (generator only) and the release. */
export interface LoadedEngine {
  adapter: Pick<BackendAdapter, 'embed'> | Pick<BackendAdapter, 'generate'>;
  specialTokens: readonly string[];
  /** Ends the engine's worker and releases its hold on the model files. Resolves only after the worker is gone. */
  unload(): Promise<void>;
}

export type PoolState =
  /** `again` is false only for the first load of this page. */
  | { phase: 'loading'; kind: EngineKind; again: boolean }
  | { phase: 'ready'; kind: EngineKind }
  | { phase: 'idle' }
  | { phase: 'failed'; kind: EngineKind; error: unknown };

export interface UseContext {
  /** The special and added token strings of the tokenizer loaded with this engine (empty for the embedder). */
  specialTokens: readonly string[];
}

export interface ModelPool {
  useEmbedder<T>(fn: (e: Pick<BackendAdapter, 'embed'>, ctx: UseContext) => Promise<T>): Promise<T>;
  useGenerator<T>(
    fn: (g: Pick<BackendAdapter, 'generate'>, ctx: UseContext) => Promise<T>,
  ): Promise<T>;
}

export interface ModelPoolDeps {
  /** A first load of one engine (see ModelService.load). */
  load(kind: EngineKind): Promise<LoadedEngine>;
  onState?(state: PoolState): void;
}

/** An AdapterError of 'not_loaded' from any copy of the runtime (recognised by name and string code, as the pipeline does). */
const isNotLoaded = (e: unknown): boolean =>
  e instanceof Error &&
  e.name === 'AdapterError' &&
  (e as { code?: unknown }).code === 'not_loaded';

export function createModelPool(deps: ModelPoolDeps): ModelPool {
  let tail: Promise<unknown> = Promise.resolve();
  let loadedBefore = false;
  const state = (s: PoolState): void => {
    try {
      deps.onState?.(s);
    } catch {
      // a listener must never break a use
    }
  };

  async function once<T>(kind: EngineKind, fn: (e: LoadedEngine) => Promise<T>): Promise<T> {
    state({ phase: 'loading', kind, again: loadedBefore });
    let engine: LoadedEngine;
    try {
      engine = await deps.load(kind);
    } catch (error) {
      state({ phase: 'failed', kind, error });
      throw error;
    }
    loadedBefore = true;
    state({ phase: 'ready', kind });
    try {
      return await fn(engine);
    } finally {
      try {
        await engine.unload();
      } catch {
        // releasing an engine that is already gone is not an error worth showing: the use has its result
      }
      state({ phase: 'idle' });
    }
  }

  /** Runs one use. An engine that was ended under it (not_loaded: a crashed worker) is re-loaded once and the use retried. */
  async function run<T>(kind: EngineKind, fn: (e: LoadedEngine) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(kind, fn);
      } catch (e) {
        if (isNotLoaded(e) && attempt === 0) continue;
        throw e;
      }
    }
  }

  function enqueue<T>(kind: EngineKind, fn: (e: LoadedEngine) => Promise<T>): Promise<T> {
    const result = tail.then(() => run(kind, fn));
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    useEmbedder: (fn) =>
      enqueue('embedder', (e) =>
        fn(e.adapter as Pick<BackendAdapter, 'embed'>, { specialTokens: e.specialTokens }),
      ),
    useGenerator: (fn) =>
      enqueue('generator', (e) =>
        fn(e.adapter as Pick<BackendAdapter, 'generate'>, { specialTokens: e.specialTokens }),
      ),
  };
}
