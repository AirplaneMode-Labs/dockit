import { describe, expect, it, vi } from 'vitest';
import {
  createModelService,
  type EngineKind,
  type ModelServiceDeps,
} from '../src/model/model-service.ts';
import { createModelPool } from '../src/model/model-pool.ts';
import { ANSWER_ENTRY_ID } from '../src/model/entries.ts';
import { memoryRefusalMessage } from '../src/pipeline/memory-line.ts';

// B1 M1 and M6 on the model service: every engine load re-verifies the stored manifest (R19) and acquires from the cache only; the memory line
// is read from the verified manifest's answer entry and refuses before any model byte is read (TD-67, TD-84).

const BASE = 'https://airplanemode-labs.github.io/dockit/';
const ID = 'dev.airplanemode.dockit-models';
const entry = (id: string, minProfile?: Record<string, unknown>) => ({
  id,
  url: `qwen3-0.6b/${id}`,
  size: 10,
  sha256: 'a'.repeat(64),
  kind: 'model',
  pin: true,
  ...(minProfile === undefined ? {} : { minProfile }),
});
const manifestBytes = (answerMinProfile?: Record<string, unknown>) =>
  new TextEncoder().encode(
    JSON.stringify({
      spec: 'airplanemode.manifest/0.1',
      id: ID,
      version: '0.2.0-dev',
      entries: [
        entry('multilingual-e5-small.descriptor', { backendTier: 'wasm-simd' }),
        entry(ANSWER_ENTRY_ID, answerMinProfile),
      ],
      signatures: [],
    }),
  );

function setup(opts: { answer?: Record<string, unknown>; ramGb?: number | 'throws' } = {}) {
  const verified: unknown[] = [];
  const loads: { kind: EngineKind; cacheOnly: boolean }[] = [];
  const live = { n: 0, max: 0 };
  const stored = new Map<string, Uint8Array>([[ID, manifestBytes(opts.answer)]]);
  const deps: ModelServiceDeps = {
    expectManifestId: ID,
    baseURI: BASE,
    online: () => false,
    fetchManifestBytes: async () => {
      throw new Error('offline');
    },
    manifests: {
      get: async (id) => stored.get(id),
      put: async () => undefined,
      delete: async () => undefined,
    },
    assets: {
      loadManifest: async (m) => {
        verified.push(m);
        return m as never;
      },
      ensure: async () => undefined,
      has: async () => true,
    },
    trust: new Map([['k', new Uint8Array(32)]]),
    events: { emit: () => undefined },
    loadAdapter: async (kind, _m, _a, o) => {
      loads.push({ kind, cacheOnly: o.cacheOnly });
      live.n++;
      live.max = Math.max(live.max, live.n);
      return {
        adapter: {} as never,
        specialTokens: [],
        unload: async () => {
          live.n--;
        },
      };
    },
    profile: async () => {
      if (opts.ramGb === 'throws') throw new Error('no profile');
      return { ramGb: opts.ramGb ?? 8 };
    },
  };
  return { svc: createModelService(deps), verified, loads, live };
}

describe('model service: every engine load is a first load (R19)', () => {
  it('7 questions: 8 embedder loads (1 ingest + 7) and 7 generator loads, one manifest verification per load, every acquire cacheOnly', async () => {
    const { svc, verified, loads, live } = setup({ answer: { ramGb: 4 } });
    const pool = createModelPool({
      load: async (kind) => {
        const m = await svc.load(kind);
        return m;
      },
    });
    await pool.useEmbedder(async () => undefined); // the ingest
    for (let q = 0; q < 7; q++) {
      await pool.useEmbedder(async () => undefined);
      await pool.useGenerator(async () => undefined);
    }
    expect(loads.filter((l) => l.kind === 'embedder')).toHaveLength(8);
    expect(loads.filter((l) => l.kind === 'generator')).toHaveLength(7);
    expect(verified).toHaveLength(15); // verify calls equal load calls: nothing is remembered between loads
    expect(loads.every((l) => l.cacheOnly)).toBe(true);
    expect(live.max).toBe(1);
  });
});

describe('model service: the memory line (M6, TD-67, TD-84)', () => {
  it('below the line: unsupported_profile with the exact sentence, after the manifest is verified and before any adapter is loaded', async () => {
    const { svc, verified, loads } = setup({ answer: { ramGb: 4 }, ramGb: 2 });
    for (const kind of ['embedder', 'generator'] as const) {
      const err = await svc.load(kind).catch((e: unknown) => e);
      expect(err).toMatchObject({
        name: 'Refusal',
        reason: 'unsupported_profile',
        message: memoryRefusalMessage(2, 4),
      });
    }
    expect(verified).toHaveLength(2); // the manifest was verified first
    expect(loads).toHaveLength(0); // and no model byte was read
  });

  it('the threshold is read from the manifest: an answer entry with ramGb 2 lets a device that reports 2 load', async () => {
    const { svc, loads } = setup({ answer: { ramGb: 2 }, ramGb: 2 });
    await svc.load('generator');
    expect(loads).toHaveLength(1);
  });

  it('a reported value at the line loads', async () => {
    const { svc, loads } = setup({ answer: { ramGb: 4 }, ramGb: 4 });
    await svc.load('embedder');
    expect(loads).toHaveLength(1);
  });

  it('an unknown value (ramGb 0) is NOT refused (TD-84)', async () => {
    const { svc, loads } = setup({ answer: { ramGb: 4 }, ramGb: 0 });
    await svc.load('generator');
    expect(loads).toHaveLength(1);
  });

  it('a manifest with no ramGb in the answer entry has no line: nothing is refused', async () => {
    const { svc, loads } = setup({ answer: { backendTier: 'wasm-simd' }, ramGb: 1 });
    await svc.load('generator');
    expect(loads).toHaveLength(1);
  });

  it('a capability profile that cannot be read is no verdict: nothing is refused', async () => {
    const { svc, loads } = setup({ answer: { ramGb: 4 }, ramGb: 'throws' });
    await svc.load('generator');
    expect(loads).toHaveLength(1);
  });

  it('memoryLine() gives the verified manifest answer entry minProfile.ramGb, or undefined when there is none', async () => {
    expect(await setup({ answer: { ramGb: 4 } }).svc.memoryLine()).toBe(4);
    expect(await setup({ answer: { ramGb: 2 } }).svc.memoryLine()).toBe(2);
    expect(await setup({ answer: { backendTier: 'wasm-simd' } }).svc.memoryLine()).toBeUndefined();
  });

  it('memoryLine() is undefined when nothing verified is stored (offline, nothing downloaded)', async () => {
    const noStore = vi.fn(async () => undefined);
    const s = createModelService({
      expectManifestId: ID,
      baseURI: BASE,
      online: () => false,
      fetchManifestBytes: async () => {
        throw new Error('offline');
      },
      manifests: { get: noStore, put: async () => undefined, delete: async () => undefined },
      assets: {
        loadManifest: async (m) => m as never,
        ensure: async () => undefined,
        has: async () => true,
      },
      trust: new Map(),
      events: { emit: () => undefined },
      loadAdapter: async () => ({
        adapter: {} as never,
        specialTokens: [],
        unload: async () => undefined,
      }),
    });
    expect(await s.memoryLine()).toBeUndefined();
  });
});
