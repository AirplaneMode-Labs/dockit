import { describe, expect, it, vi } from 'vitest';
import {
  createModelService,
  assertEntriesUnderModels,
  type ModelServiceDeps,
} from '../src/model/model-service.ts';
import { openManifestStore } from '../src/model/manifest-store.ts';
import { Refusal } from '../src/pipeline/reasons.ts';
import { RecordingSink } from './helpers/fakes.ts';

const BASE = 'https://airplanemode-labs.github.io/dockit/';
const ID = 'dev.airplanemode.dockit-models';
const entry = (id: string, url: string) => ({
  id,
  url,
  size: 10,
  sha256: 'a'.repeat(64),
  kind: 'model',
  pin: true,
});
const manifestBytes = (
  entries = [
    entry('a.onnx', 'qwen3-0.6b/onnx/model.onnx'),
    entry('b.json', 'qwen3-0.6b/config.json'),
  ],
  id = ID,
) =>
  new TextEncoder().encode(
    JSON.stringify({
      spec: 'airplanemode.manifest/0.1',
      id,
      version: '0.2.0-dev',
      entries,
      signatures: [],
    }),
  );

type SetupOpts = Omit<Partial<ModelServiceDeps>, 'online'> & {
  online?: boolean;
  stored?: Uint8Array;
};
function setup(all: SetupOpts = {}) {
  const { online: onlineFlag, stored: storedBytes, ...over } = all;
  const stored = new Map<string, Uint8Array>();
  if (storedBytes) stored.set(ID, storedBytes);
  const sink = new RecordingSink();
  const calls = {
    fetchManifest: 0,
    loadManifest: [] as unknown[],
    ensure: [] as string[],
    loadAdapters: [] as unknown[],
    has: [] as string[],
  };
  const deps: ModelServiceDeps = {
    expectManifestId: ID,
    baseURI: BASE,
    online: () => onlineFlag ?? true,
    fetchManifestBytes: async () => {
      calls.fetchManifest++;
      return manifestBytes();
    },
    manifests: {
      get: async (id) => stored.get(id),
      put: async (id, b) => void stored.set(id, b),
      delete: async (id) => void stored.delete(id),
    },
    assets: {
      loadManifest: async (m, trust, o) => {
        calls.loadManifest.push([m, o]);
        return m as never;
      },
      ensure: async (id, o) => {
        calls.ensure.push(id);
        o?.onProgress?.({ entryId: id, received: 10, total: 10, resumedFrom: 0 });
      },
      has: async (id) => {
        calls.has.push(id);
        return true;
      },
    },
    trust: new Map([['k', new Uint8Array(32)]]),
    events: sink,
    loadAdapters: async (m, _a, o) => {
      calls.loadAdapters.push(o);
      return { generator: {} as never, embedder: {} as never, specialTokens: ['<|im_end|>'] };
    },
    ...over,
  } as ModelServiceDeps;
  return { svc: createModelService(deps), stored, calls, sink, deps };
}

describe('model config', () => {
  it('throws at start when expectManifestId is missing or not a manifest id', () => {
    const { deps } = setup();
    expect(() => createModelService({ ...deps, expectManifestId: undefined as never })).toThrow(
      /expectManifestId/,
    );
    expect(() => createModelService({ ...deps, expectManifestId: '' })).toThrow(/expectManifestId/);
    expect(() => createModelService({ ...deps, expectManifestId: 'BAD ID' })).toThrow(
      /expectManifestId/,
    );
    expect(() => createModelService(deps)).not.toThrow();
  });

  it("every resolved entry pathname must start with the app's own models/ path", () => {
    const m = (...urls: string[]) => ({ entries: urls.map((u, i) => entry(`e${i}`, u)) });
    expect(() =>
      assertEntriesUnderModels(m('qwen3-0.6b/x.onnx', 'ort/a.wasm'), BASE),
    ).not.toThrow();
    for (const bad of [
      '../runtime/x.onnx',
      '../../x',
      '/dockit/vendor/x',
      '/models/x',
      '//evil.example/x',
      'https://evil.example/dockit/models/x',
      'https://airplanemode-labs.github.io/runtime/models/x',
      '..\\models\\x',
      'models/../vendor/x',
      '%2e%2e/x',
    ]) {
      expect(() => assertEntriesUnderModels(m('ok.bin', bad), BASE), bad).toThrowError(
        expect.objectContaining({ reason: 'manifest_refused' }),
      );
    }
  });

  it('the path prefix follows the document base, so it holds under /dockit/ and at the root', () => {
    expect(() =>
      assertEntriesUnderModels({ entries: [entry('a', 'x.bin')] }, 'http://127.0.0.1:4173/'),
    ).not.toThrow();
    expect(() =>
      assertEntriesUnderModels(
        { entries: [entry('a', '../x.bin')] },
        'http://127.0.0.1:4173/dockit/',
      ),
    ).toThrow();
  });
});

describe('model service: download', () => {
  it('fetches the manifest, verifies it with the expected id, ensures every entry, then stores the raw bytes', async () => {
    const { svc, calls, stored } = setup();
    const progress: number[] = [];
    await svc.download({ onProgress: (p) => progress.push(p.received) });
    expect(calls.fetchManifest).toBe(1);
    expect(calls.loadManifest).toHaveLength(1);
    expect(calls.ensure).toEqual(['a.onnx', 'b.json']);
    expect(progress.length).toBeGreaterThan(0);
    expect(stored.get(ID)).toEqual(manifestBytes());
  });

  it('a manifest fetch that fails (the network is not really there) is model_not_cached, not an unexplained error', async () => {
    const { svc } = setup({
      fetchManifestBytes: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(svc.download({})).rejects.toMatchObject({
      name: 'Refusal',
      reason: 'model_not_cached',
    });
  });

  it('a manifest with an entry outside models/ is refused BEFORE the asset manager is called: 0 requests', async () => {
    const bad = manifestBytes([entry('a.onnx', '../runtime/x.onnx')]);
    const { svc, calls, stored } = setup({ fetchManifestBytes: async () => bad });
    await expect(svc.download({})).rejects.toMatchObject({
      name: 'Refusal',
      reason: 'manifest_refused',
      detail: { reason: 'path_prefix' },
    });
    expect(calls.loadManifest).toEqual([]);
    expect(calls.ensure).toEqual([]);
    expect(stored.size).toBe(0);
  });

  it('a verifier refusal is manifest_refused with its reason, nothing is downloaded and nothing is stored', async () => {
    const { svc, calls, stored } = setup({
      assets: {
        loadManifest: async () => {
          throw Object.assign(new Error('refused'), {
            name: 'ManifestError',
            reason: 'unexpected_id',
          });
        },
        ensure: async () => {
          throw new Error('must not be called');
        },
        has: async () => true,
      } as never,
    });
    await expect(svc.download({})).rejects.toMatchObject({
      reason: 'manifest_refused',
      detail: { reason: 'unexpected_id' },
    });
    expect(stored.size).toBe(0);
    expect(calls.ensure).toEqual([]);
  });

  it('refuses to download while offline, with model_not_cached, and fetches nothing', async () => {
    const { svc, calls } = setup({ online: false });
    await expect(svc.download({})).rejects.toMatchObject({ reason: 'model_not_cached' });
    expect(calls.fetchManifest).toBe(0);
  });

  it('an oversize or non-JSON manifest is manifest_refused, not an unhandled error', async () => {
    const a = setup({ fetchManifestBytes: async () => new TextEncoder().encode('{not json') });
    await expect(a.svc.download({})).rejects.toMatchObject({ reason: 'manifest_refused' });
    const b = setup({ fetchManifestBytes: async () => new Uint8Array(2 * 1024 * 1024) });
    await expect(b.svc.download({})).rejects.toMatchObject({ reason: 'manifest_refused' });
  });
});

describe('model service: load (S-OFF-1, the stored manifest is re-verified on every load)', () => {
  it('re-verifies the stored manifest bytes on every load and loads the adapters with cacheOnly', async () => {
    const { svc, calls } = setup({ stored: manifestBytes() });
    await svc.load();
    await svc.load();
    expect(calls.loadManifest).toHaveLength(2);
    expect(calls.fetchManifest).toBe(0);
    expect(calls.loadAdapters).toEqual([{ cacheOnly: true }, { cacheOnly: true }]);
  });

  it('no stored manifest is model_not_cached', async () => {
    const { svc } = setup();
    await expect(svc.load()).rejects.toMatchObject({ reason: 'model_not_cached' });
  });

  it('online, a stored manifest that fails verification is discarded and refetched', async () => {
    let first = true;
    const { svc, calls, stored } = setup({
      stored: manifestBytes(),
      assets: {
        loadManifest: async (m: unknown) => {
          if (first) {
            first = false;
            throw Object.assign(new Error('x'), { reason: 'no_valid_signature' });
          }
          return m as never;
        },
        ensure: async () => {},
        has: async () => true,
      } as never,
    });
    await svc.load();
    expect(calls.fetchManifest).toBe(1);
    expect(stored.get(ID)).toEqual(manifestBytes());
  });

  it('a stored manifest that fails verification while the browser says online but the refetch fails: the original manifest_refused is what the user sees', async () => {
    const { svc } = setup({
      stored: manifestBytes(),
      fetchManifestBytes: async () => {
        throw new TypeError('Failed to fetch');
      },
      assets: {
        loadManifest: async () => {
          throw Object.assign(new Error('x'), { reason: 'no_valid_signature' });
        },
        ensure: async () => {},
        has: async () => true,
      } as never,
    });
    await expect(svc.load()).rejects.toMatchObject({
      reason: 'manifest_refused',
      detail: { reason: 'no_valid_signature' },
    });
  });

  it('offline, a stored manifest that fails verification is manifest_refused with its reason, and 0 model bytes reach the engine', async () => {
    const tampered = manifestBytes();
    const at = new TextDecoder().decode(tampered).indexOf('"sha256":"') + 12;
    tampered[at] = tampered[at]! ^ 3; // one hex digit of a recorded hash: still valid JSON
    const loadAdapters = vi.fn();
    const { svc, calls } = setup({
      online: false,
      stored: tampered,
      loadAdapters: loadAdapters as never,
      assets: {
        loadManifest: async () => {
          throw Object.assign(new Error('x'), { reason: 'no_valid_signature' });
        },
        ensure: async () => {},
        has: async () => true,
      } as never,
    });
    await expect(svc.load()).rejects.toMatchObject({
      reason: 'manifest_refused',
      detail: { reason: 'no_valid_signature' },
    });
    expect(loadAdapters).not.toHaveBeenCalled();
    expect(calls.fetchManifest).toBe(0);
  });

  it('a stored manifest whose entries leave models/ is refused too (the stored bytes are re-checked like fetched ones)', async () => {
    const { svc } = setup({ online: false, stored: manifestBytes([entry('a.onnx', '../x.onnx')]) });
    await expect(svc.load()).rejects.toMatchObject({
      reason: 'manifest_refused',
      detail: { reason: 'path_prefix' },
    });
  });

  it('a model file missing from the cache while offline is model_not_cached (the adapter says not_cached: a cacheOnly miss)', async () => {
    const { svc } = setup({
      online: false,
      stored: manifestBytes(),
      loadAdapters: async () => {
        throw Object.assign(new Error('not cached'), { name: 'AdapterError', code: 'not_cached' });
      },
    });
    await expect(svc.load()).rejects.toMatchObject({ reason: 'model_not_cached' });
  });

  it('an AssetError from the asset manager (a file not stored in full) is model_not_cached too', async () => {
    const { svc } = setup({
      online: false,
      stored: manifestBytes(),
      loadAdapters: async () => {
        throw Object.assign(new Error('not stored'), { name: 'AssetError', code: 'not_cached' });
      },
    });
    await expect(svc.load()).rejects.toMatchObject({ reason: 'model_not_cached' });
  });

  it('a not_loaded from the adapter is NOT a missing model (BUG-T1-S5-R2-01): it is passed on as it is, never as model_not_cached', async () => {
    const { svc } = setup({
      online: false,
      stored: manifestBytes(),
      loadAdapters: async () => {
        throw Object.assign(new Error('ended'), { name: 'AdapterError', code: 'not_loaded' });
      },
    });
    const err = await svc.load().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AdapterError', code: 'not_loaded' });
    expect(err).not.toBeInstanceOf(Refusal);
  });

  it('a first load that fails with the engine code backend is tried once more after a pause (a file written less than a second ago may not be readable yet); integrity is never retried', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { svc } = setup({
        stored: manifestBytes(),
        loadAdapters: async () => {
          attempts++;
          if (attempts === 1)
            throw Object.assign(new Error('engine'), { name: 'AdapterError', code: 'backend' });
          return { generator: {} as never, embedder: {} as never, specialTokens: [] };
        },
      });
      const p = svc.load();
      await vi.advanceTimersByTimeAsync(1600);
      await expect(p).resolves.toBeDefined();
      expect(attempts).toBe(2);
      let tries = 0;
      const b = setup({
        stored: manifestBytes(),
        loadAdapters: async () => {
          tries++;
          throw Object.assign(new Error('x'), { name: 'AdapterError', code: 'integrity' });
        },
      });
      const q = b.svc.load();
      const asserted = expect(q).rejects.toMatchObject({ reason: 'integrity' });
      await vi.advanceTimersByTimeAsync(5000);
      await asserted;
      expect(tries).toBe(1);
      let backendTries = 0;
      const c = setup({
        stored: manifestBytes(),
        loadAdapters: async () => {
          backendTries++;
          throw Object.assign(new Error('engine'), { name: 'AdapterError', code: 'backend' });
        },
      });
      const r = c.svc.load();
      const failed = expect(r).rejects.toMatchObject({ code: 'backend' });
      await vi.advanceTimersByTimeAsync(5000);
      await failed;
      expect(backendTries).toBe(2); // once more, not forever
    } finally {
      vi.useRealTimers();
    }
  });

  it('status() says cached only when a stored manifest verifies and every entry is present', async () => {
    const a = setup({ stored: manifestBytes() });
    await expect(a.svc.status()).resolves.toMatchObject({ cached: true });
    const b = setup();
    await expect(b.svc.status()).resolves.toMatchObject({ cached: false });
    const c = setup({
      stored: manifestBytes(),
      assets: {
        loadManifest: async (m: unknown) => m,
        ensure: async () => {},
        has: async (id: string) => id !== 'b.json',
      } as never,
    });
    await expect(c.svc.status()).resolves.toMatchObject({ cached: false });
  });

  it('the total download size is the sum of the entry sizes (shown on the Download button)', async () => {
    const { svc } = setup({
      fetchManifestBytes: async () =>
        manifestBytes([entry('a', 'x/a'), { ...entry('b', 'x/b'), size: 5 }]),
    });
    await expect(svc.plannedBytes()).resolves.toBe(15);
  });
});

describe('manifest store (IndexedDB database dockit, object store manifest, key = manifest id)', () => {
  function fakeIdb() {
    const dbs = new Map<string, Map<string, Map<string, unknown>>>();
    const calls: string[] = [];
    const factory = {
      open(name: string, version: number) {
        calls.push(`open ${name} ${version}`);
        const req: any = {};
        queueMicrotask(() => {
          const stores = dbs.get(name) ?? new Map();
          const fresh = !dbs.has(name);
          dbs.set(name, stores);
          const db = {
            objectStoreNames: { contains: (n: string) => stores.has(n) },
            createObjectStore: (n: string) => void stores.set(n, new Map()),
            transaction(n: string, mode: string) {
              calls.push(`tx ${n} ${mode}`);
              const store = stores.get(n)!;
              const tx: any = { oncomplete: null, onerror: null };
              const wrap = (fn: () => unknown) => {
                const r: any = {};
                queueMicrotask(() => {
                  r.result = fn();
                  r.onsuccess?.();
                  queueMicrotask(() => tx.oncomplete?.());
                });
                return r;
              };
              tx.objectStore = () => ({
                get: (k: string) => wrap(() => store.get(k)),
                put: (v: unknown, k: string) => wrap(() => void store.set(k, v)),
                delete: (k: string) => wrap(() => void store.delete(k)),
              });
              return tx;
            },
            close() {},
          };
          req.result = db;
          if (fresh) req.onupgradeneeded?.({ target: req });
          req.onsuccess?.();
        });
        return req;
      },
    };
    return { factory, calls };
  }

  it('round-trips raw bytes by manifest id and deletes them', async () => {
    const { factory, calls } = fakeIdb();
    const store = await openManifestStore(factory as never);
    expect(calls[0]).toBe('open dockit 1');
    expect(await store.get(ID)).toBeUndefined();
    await store.put(ID, new Uint8Array([1, 2, 3]));
    expect(await store.get(ID)).toEqual(new Uint8Array([1, 2, 3]));
    await store.delete(ID);
    expect(await store.get(ID)).toBeUndefined();
  });

  it('keys by manifest id only: another id is a separate record', async () => {
    const { factory } = fakeIdb();
    const store = await openManifestStore(factory as never);
    await store.put(ID, new Uint8Array([1]));
    expect(await store.get('dev.airplanemode.runtime-demo-models')).toBeUndefined();
  });
});
