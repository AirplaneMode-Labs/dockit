import { describe, expect, it, vi } from 'vitest';
import { AdapterError } from '../src/contracts/backend-adapter.ts';
import {
  createModelPool,
  type EngineKind,
  type LoadedEngine,
  type PoolState,
} from '../src/model/model-pool.ts';

/** A fake engine host: counts how many engines are loaded at any moment, and records the order of every load and unload. */
function host(
  opts: { failUnload?: (n: number) => boolean; failLoad?: (n: number) => unknown } = {},
) {
  const log: string[] = [];
  let live = 0;
  let max = 0;
  let loads = 0;
  let unloads = 0;
  const load = vi.fn(async (kind: EngineKind): Promise<LoadedEngine> => {
    const n = ++loads;
    await Promise.resolve();
    const err = opts.failLoad?.(n);
    if (err !== undefined) throw err;
    live++;
    max = Math.max(max, live);
    log.push(`load:${kind}`);
    let gone = false;
    return {
      adapter:
        kind === 'embedder'
          ? ({
              embed: async (t: string[]) => ({
                vectors: t.map(() => new Float32Array(1)),
                dims: 1,
                normalized: true,
              }),
            } as never)
          : ({
              generate: async () => ({ text: 'x', finishReason: 'stop' }),
            } as never),
      specialTokens: kind === 'generator' ? ['<|im_end|>'] : [],
      unload: async () => {
        const k = ++unloads;
        log.push(`unload:${kind}`);
        if (!gone) {
          gone = true;
          live--;
        }
        if (opts.failUnload?.(k) === true) throw new Error('unload failed');
      },
    };
  });
  return {
    load,
    log,
    maxLive: () => max,
    live: () => live,
    loads: () => loads,
  };
}

describe('model pool (B1 M1: one engine at a time)', () => {
  it('over an ingest and a 7-question sequence at most one engine is ever loaded, in the fixed per-question order', async () => {
    const h = host();
    const pool = createModelPool({ load: h.load });
    await pool.useEmbedder(async (e) => {
      await e.embed(['a']);
      await e.embed(['b']); // one lease holds the embedder across the batches of an ingest
    });
    for (let q = 0; q < 7; q++) {
      await pool.useEmbedder((e) => e.embed(['query']));
      await pool.useGenerator((g) => g.generate([{ role: 'user', content: 'q' }]));
    }
    expect(h.maxLive()).toBe(1);
    expect(h.live()).toBe(0);
    expect(h.loads()).toBe(15); // 1 ingest + 7 embedder + 7 generator
    const expected = ['load:embedder', 'unload:embedder'];
    for (let q = 0; q < 7; q++)
      expected.push('load:embedder', 'unload:embedder', 'load:generator', 'unload:generator');
    expect(h.log).toEqual(expected);
  });

  it('the embedder is unloaded before the generator loads, and the generator before the next embedder', async () => {
    const h = host();
    const pool = createModelPool({ load: h.load });
    await pool.useEmbedder(async () => undefined);
    await pool.useGenerator(async () => undefined);
    await pool.useEmbedder(async () => undefined);
    expect(h.log).toEqual([
      'load:embedder',
      'unload:embedder',
      'load:generator',
      'unload:generator',
      'load:embedder',
      'unload:embedder',
    ]);
  });

  it('two uses started at the same time are serialised: the second loads only after the first has unloaded', async () => {
    const h = host();
    const pool = createModelPool({ load: h.load });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = pool.useGenerator(async () => hold);
    const second = pool.useEmbedder(async () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.log).toEqual(['load:generator']); // the embedder has not been loaded beside it
    release();
    await Promise.all([first, second]);
    expect(h.log).toEqual([
      'load:generator',
      'unload:generator',
      'load:embedder',
      'unload:embedder',
    ]);
    expect(h.maxLive()).toBe(1);
  });

  it('a use that throws still unloads, and the error reaches the caller untouched', async () => {
    const h = host();
    const pool = createModelPool({ load: h.load });
    const boom = new Error('boom');
    await expect(
      pool.useGenerator(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(h.log).toEqual(['load:generator', 'unload:generator']);
    expect(h.live()).toBe(0);
    await pool.useEmbedder(async () => undefined); // and the pool is usable again
    expect(h.maxLive()).toBe(1);
  });

  it('a failed unload still releases: the next load goes ahead, and the use result is returned', async () => {
    const h = host({ failUnload: (n) => n === 1 });
    const pool = createModelPool({ load: h.load });
    await expect(pool.useEmbedder(async () => 'result')).resolves.toBe('result');
    await pool.useGenerator(async () => undefined);
    expect(h.log).toEqual([
      'load:embedder',
      'unload:embedder',
      'load:generator',
      'unload:generator',
    ]);
    expect(h.maxLive()).toBe(1);
  });

  it('a load that fails rejects the use with that error, runs nothing and leaves nothing loaded; the next use loads normally', async () => {
    const refusal = new Error('refused');
    const h = host({ failLoad: (n) => (n === 1 ? refusal : undefined) });
    const pool = createModelPool({ load: h.load });
    const used = vi.fn();
    await expect(pool.useGenerator(used)).rejects.toBe(refusal);
    expect(used).not.toHaveBeenCalled();
    expect(h.live()).toBe(0);
    await pool.useGenerator(async () => undefined);
    expect(h.log).toEqual(['load:generator', 'unload:generator']);
  });

  it('every use is a first load: the loader is called once per use, nothing is remembered between uses', async () => {
    const h = host();
    const pool = createModelPool({ load: h.load });
    for (let i = 0; i < 3; i++) await pool.useGenerator(async () => undefined);
    expect(h.load).toHaveBeenCalledTimes(3);
    expect(h.load.mock.calls.map((c) => c[0])).toEqual(['generator', 'generator', 'generator']);
  });

  it('the generator lease carries the special tokens of the tokenizer it just loaded', async () => {
    const h = host();
    const pool = createModelPool({ load: h.load });
    const seen = await pool.useGenerator(async (_g, ctx) => ctx.specialTokens);
    expect(seen).toEqual(['<|im_end|>']);
  });

  it('an engine that was ended under a use (not_loaded) is re-loaded ONCE and the use retried; a second not_loaded is thrown', async () => {
    const h = host();
    const pool = createModelPool({ load: h.load });
    let calls = 0;
    await expect(
      pool.useGenerator(async () => {
        if (++calls === 1) throw new AdapterError('not_loaded', 'ended');
        return 'ok';
      }),
    ).resolves.toBe('ok');
    expect(calls).toBe(2);
    expect(h.log).toEqual([
      'load:generator',
      'unload:generator',
      'load:generator',
      'unload:generator',
    ]);
    let again = 0;
    await expect(
      pool.useGenerator(async () => {
        again++;
        throw new AdapterError('not_loaded', 'still ended');
      }),
    ).rejects.toMatchObject({ code: 'not_loaded' });
    expect(again).toBe(2);
    expect(h.live()).toBe(0);
  });

  it('an abort (the worker host ended the engine) propagates, and the ended engine is released', async () => {
    const h = host();
    const pool = createModelPool({ load: h.load });
    await expect(
      pool.useGenerator(async () => {
        throw new AdapterError('aborted', 'stop');
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(h.log).toEqual(['load:generator', 'unload:generator']);
  });

  it('reports its state: loading (again after the first), ready while a use runs, idle after the unload, failed when a load fails', async () => {
    const h = host({ failLoad: (n) => (n === 3 ? new Error('no') : undefined) });
    const states: PoolState[] = [];
    const pool = createModelPool({ load: h.load, onState: (s) => states.push(s) });
    await pool.useEmbedder(async () => undefined);
    await pool.useGenerator(async () => undefined);
    await pool.useEmbedder(async () => undefined).catch(() => undefined);
    expect(
      states.map((s) => [s.phase, 'kind' in s ? s.kind : '', 'again' in s ? s.again : '']),
    ).toEqual([
      ['loading', 'embedder', false],
      ['ready', 'embedder', ''],
      ['idle', '', ''],
      ['loading', 'generator', true],
      ['ready', 'generator', ''],
      ['idle', '', ''],
      ['loading', 'embedder', true],
      ['failed', 'embedder', ''],
    ]);
  });
});
