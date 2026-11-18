import { describe, expect, it, vi } from 'vitest';
import { AdapterError, type AdapterErrorCode } from '../../src/contracts/backend-adapter.ts';
import { AppController, type ControllerDeps } from '../../src/app/controller.ts';
import { EventLog } from '../../src/pipeline/events.ts';
import type { Answer, OpenedDocument, Pipeline } from '../../src/pipeline/pipeline.ts';
import { Refusal } from '../../src/pipeline/reasons.ts';
import type { ModelService } from '../../src/model/model-service.ts';

const doc = (over: Partial<OpenedDocument> = {}): OpenedDocument => ({
  docId: 'd1',
  ns: 'dockit.dd1',
  pages: 3,
  chunks: 5,
  held: 0,
  heldChunks: [],
  skippedPages: [],
  kept: false,
  truncated: false,
  ...over,
});
const answer = (text = 'It is 45 days [S1].'): Answer => ({
  text,
  sources: [],
  cited: [],
  unknownCitations: 0,
  firstTokenMs: 5,
  totalMs: 10,
  outTokens: 3,
  tokensPerSecond: 1,
  finishReason: 'stop',
  budget: 256,
});

function setup(
  over: {
    framed?: boolean;
    pipeline?: Partial<Pipeline>;
    models?: Partial<ModelService>;
    online?: boolean;
  } = {},
) {
  const events = new EventLog();
  const loadSpy = vi.fn(async () => ({
    generator: { generate: vi.fn() },
    embedder: { embed: vi.fn() },
    specialTokens: ['<|im_end|>'],
    manifest: { entries: [] },
  }));
  const models: ModelService = {
    download: vi.fn(async ({ onProgress }) => {
      onProgress?.({ entryId: 'a', received: 50, total: 100, resumedFrom: 0 });
      onProgress?.({ entryId: 'b', received: 20, total: 200, resumedFrom: 0 });
    }),
    load: loadSpy as never,
    status: vi.fn(async () => ({ cached: true })),
    plannedBytes: vi.fn(async () => 300),
    ...over.models,
  };
  const pipeline: Pipeline = {
    open: vi.fn(async () => doc()),
    ask: vi.fn(async () => answer()),
    remove: vi.fn(async () => undefined),
    listKept: vi.fn(async () => []),
    adopt: vi.fn(async () => doc({ kept: true })),
    current: () => undefined,
    ...over.pipeline,
  };
  const deps: ControllerDeps = {
    framed: over.framed ?? false,
    events,
    models,
    makePipeline: () => pipeline,
    pipelineDeps: {
      store: {} as never,
      analysis: {} as never,
      extract: async () => ({ pages: [], skipped: [], truncated: false }),
    },
    detectCapability: async () => ({
      profile: { gpu: 'none', ramGb: 8 } as never,
      verdict: 'meets',
    }),
    online: () => over.online ?? true,
  };
  const c = new AppController(deps);
  return { c, models, pipeline, events, loadSpy };
}
const file = () => new File([new Uint8Array(4)], 'x.pdf');

describe('app controller', () => {
  it('init() wires the capability card, the model status and the planned size', async () => {
    const { c } = setup();
    await c.init();
    const s = c.getState();
    expect(s.capability.verdict).toBe('meets');
    // BUG-T1-S5-06: Chrome 157 reports 32 on a 48 GB Mac, so the note must not say browsers cap memory at 8 GB
    expect(s.capability.note).toBe(
      'This is the rounded memory the browser reports (navigator.deviceMemory), not free memory.',
    );
    expect(s.capability.note).not.toMatch(/cap/i);
    expect(s.capability.note).not.toMatch(/8 GB/);
    expect(s.model).toMatchObject({ status: 'cached', plannedBytes: 300 });
  });

  it('download() aggregates progress over every file and ends cached', async () => {
    const { c } = setup({ models: { status: async () => ({ cached: false }) } });
    await c.init();
    expect(c.getState().model.status).toBe('absent');
    await c.download();
    expect(c.getState().model.status).toBe('cached');
    expect(c.getState().model.receivedBytes).toBe(70);
    expect(c.getState().model.totalBytes).toBe(300);
  });

  it('a failed download shows the refusal and, for model_not_cached, goes back to absent', async () => {
    const { c } = setup({
      models: {
        download: async () => {
          throw new Refusal('model_not_cached');
        },
        status: async () => ({ cached: false }),
      },
    });
    await c.init();
    await c.download();
    expect(c.getState().model.status).toBe('absent');
    expect(c.getState().model.refusal?.message).toBe(
      'The model is not downloaded on this device. Connect once and press Download.',
    );
    const d = setup({
      models: {
        download: async () => {
          throw new Refusal('manifest_refused', undefined, { reason: 'unexpected_id' });
        },
      },
    });
    await d.c.download();
    expect(d.c.getState().model).toMatchObject({
      status: 'refused',
      refusal: { reason: 'manifest_refused', detail: 'unexpected_id' },
    });
  });

  it('openFile() puts a refusal in the document card with its plain message, and never loads the model', async () => {
    const { c, loadSpy } = setup({
      pipeline: {
        open: async () => {
          throw new Refusal('no_text_layer', undefined, {
            pages: [{ page: 1, reason: 'ocr_not_yet' }],
          });
        },
      },
    });
    await c.openFile(file());
    expect(c.getState().doc.status).toBe('refused');
    expect(c.getState().doc.refusal?.message).toBe(
      'This PDF has no text layer (it looks scanned). OCR is not yet supported.',
    );
    expect(c.getState().doc.refusal?.pages?.[0]?.message).toMatch(/image only/);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('openFile() on success shows the document facts and passes the keep choice', async () => {
    const { c, pipeline } = setup();
    c.setKeep(true);
    await c.openFile(file());
    expect(c.getState().doc).toMatchObject({ status: 'ready', info: { chunks: 5 } });
    expect(pipeline.open).toHaveBeenCalledWith(expect.anything(), { keep: true });
  });

  it('pipeline.stage events drive the per-stage rows', async () => {
    const { c, events } = setup({
      pipeline: {
        open: async function () {
          const { newEvent } = await import('../../src/pipeline/events.ts');
          events.emit(
            newEvent({
              source: 'dockit',
              kind: 'timing',
              name: 'pipeline.stage',
              level: 'debug',
              durationMs: 12,
              attrs: { stage: 'read', outcome: 'ok', reason: '', pages: 0, chunks: 0, held: 0 },
            }),
          );
          events.emit(
            newEvent({
              source: 'dockit',
              kind: 'timing',
              name: 'pipeline.stage',
              level: 'warn',
              durationMs: 3,
              attrs: {
                stage: 'triage',
                outcome: 'refused',
                reason: 'encrypted',
                pages: 0,
                chunks: 0,
                held: 0,
              },
            }),
          );
          throw new Refusal('encrypted');
        },
      },
    });
    await c.openFile(file());
    const rows = Object.fromEntries(c.getState().doc.stages.map((r) => [r.stage, r.status]));
    expect(rows).toMatchObject({ read: 'ok', triage: 'refused', extract: 'waiting' });
    expect(c.getState().doc.refusal?.reason).toBe('encrypted');
  });

  it('ask() stores the answer, sanitised for display, and clears the streamed text', async () => {
    const { c } = setup({ pipeline: { ask: async () => answer('45 days‮ [S1]\u{E0041}') } });
    await c.ask('What is the grace period?');
    expect(c.getState().ask).toMatchObject({
      status: 'done',
      displayText: '45 days [S1]',
      streamed: '',
    });
  });

  it('ask() refusals appear in the ask card; an abort is Stopped, without a refusal', async () => {
    const a = setup({
      pipeline: {
        ask: async () => {
          throw new Refusal('model_not_cached');
        },
      },
    });
    await a.c.ask('q');
    expect(a.c.getState().ask).toMatchObject({
      status: 'refused',
      refusal: { reason: 'model_not_cached' },
    });
    const b = setup({
      pipeline: {
        ask: async () => {
          throw new AdapterError('aborted', 'x');
        },
      },
    });
    await b.c.ask('q');
    // BUG-T1-S5-R2-02: shown as Stopped (its own status), not as a failure and not as idle
    expect(b.c.getState().ask).toMatchObject({ status: 'stopped', refusal: undefined });
  });

  it('stop() aborts the signal passed to the pipeline', async () => {
    let signal: AbortSignal | undefined;
    let release: () => void = () => undefined;
    const { c } = setup({
      pipeline: {
        ask: async (_q, o) => {
          signal = o.signal;
          await new Promise<void>((r) => (release = r));
          return answer();
        },
      },
    });
    const p = c.ask('q');
    await Promise.resolve();
    c.stop();
    expect(signal?.aborted).toBe(true);
    release();
    await p;
  });

  it('streamed tokens accumulate while the answer is being produced', async () => {
    const { c } = setup({
      pipeline: {
        ask: async (_q, o) => {
          o.onToken?.('4');
          o.onToken?.('5');
          expect(c.getState().ask.streamed).toBe('45');
          return answer();
        },
      },
    });
    await c.ask('q');
  });

  it('remove() deletes the document through the pipeline and resets the card', async () => {
    const { c, pipeline } = setup();
    await c.openFile(file());
    await c.remove();
    expect(pipeline.remove).toHaveBeenCalledWith('d1');
    expect(c.getState().doc).toMatchObject({ status: 'none', info: undefined });
  });

  it('a framed page refuses every action with reason framed and does nothing', async () => {
    const { c, pipeline, models } = setup({ framed: true });
    await c.init();
    await c.openFile(file());
    expect(c.getState().doc.refusal?.reason).toBe('framed');
    await c.ask('q');
    expect(c.getState().ask.refusal?.reason).toBe('framed');
    await c.download();
    expect(c.getState().model.refusal?.reason).toBe('framed');
    expect(pipeline.open).not.toHaveBeenCalled();
    expect(pipeline.ask).not.toHaveBeenCalled();
    expect(models.download).not.toHaveBeenCalled();
    expect(models.status).not.toHaveBeenCalled();
  });

  it('kept documents: refreshKept lists them, useKept adopts, removeKept deletes through the pipeline', async () => {
    const { c, pipeline } = setup({
      pipeline: { listKept: async () => [{ docId: 'k1', ns: 'dockit.dk1', pages: 2, chunks: 4 }] },
    });
    await c.init();
    expect(c.getState().kept).toHaveLength(1);
    await c.useKept('k1');
    expect(c.getState().doc).toMatchObject({ status: 'ready', info: { kept: true } });
    await c.removeKept('k1');
    expect(pipeline.remove).toHaveBeenCalledWith('k1');
  });

  it('the models are loaded lazily, by the first stage that needs them', async () => {
    let embed: ((t: string[]) => Promise<unknown>) | undefined;
    const events = new EventLog();
    const loadSpy = vi.fn(async () => ({
      generator: {},
      embedder: {
        embed: async (t: string[]) => ({
          vectors: t.map(() => new Float32Array(1)),
          dims: 1,
          normalized: true,
        }),
      },
      specialTokens: ['<|x|>'],
      manifest: { entries: [] },
    }));
    const c = new AppController({
      framed: false,
      events,
      models: {
        download: async () => undefined,
        load: loadSpy as never,
        status: async () => ({ cached: true }),
        plannedBytes: async () => 1,
      },
      makePipeline: (d) => {
        embed = d.embedder.embed as never;
        return {
          open: async () => doc(),
          ask: async () => answer(),
          remove: async () => undefined,
          listKept: async () => [],
          adopt: async () => doc(),
          current: () => undefined,
        };
      },
      pipelineDeps: {
        store: {} as never,
        analysis: {} as never,
        extract: async () => ({ pages: [], skipped: [], truncated: false }),
      },
      detectCapability: async () => ({ profile: {} as never, verdict: 'meets' }),
      online: () => true,
    });
    await c.openFile(file());
    expect(loadSpy).not.toHaveBeenCalled();
    await embed!(['x']);
    await embed!(['y']);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(c.getState().model.status).toBe('ready');
  });
});

// BUG-T1-S5-R2-01 and -02: Stop ends the engine worker (backend adapter R8), so the next question first re-loads the model from the stored,
// re-verified manifest and the cached files. The fakes below behave the way the worker host does: after an abort the adapter that was stopped
// is not loaded, and its next generate() rejects 'not_loaded'.
describe('app controller: Stop, then the next question', () => {
  type Step = 'ok' | 'abort-after-token' | 'abort-before-token' | 'not_loaded' | 'wait-then-abort';
  const crossRealm = (code: string) =>
    Object.assign(new Error(code), { name: 'AdapterError', code });
  const GRACE = 'The grace period is 45 days [S1].';

  class FakeSet {
    ended = false;
    unloaded = false;
    generateCalls = 0;
    constructor(readonly steps: Step[]) {}
    readonly embedder = {
      embed: async (t: string[]) => {
        if (this.unloaded) throw new AdapterError('not_loaded', 'embedder');
        return { vectors: t.map(() => new Float32Array(1)), dims: 1, normalized: true as const };
      },
    };
    readonly generator = {
      generate: async (
        _p: unknown,
        o?: { signal?: AbortSignal; onToken?: (t: string) => void },
      ) => {
        this.generateCalls++;
        if (this.ended || this.unloaded) throw new AdapterError('not_loaded', 'ended');
        const step = this.steps.shift() ?? 'ok';
        if (step === 'not_loaded') throw new AdapterError('not_loaded', 'worker is gone');
        if (step === 'abort-before-token') {
          await new Promise<void>((r) => o?.signal?.addEventListener('abort', () => r()));
          this.ended = true;
          throw crossRealm('aborted');
        }
        if (step === 'abort-after-token' || step === 'wait-then-abort') {
          if (step === 'abort-after-token') o?.onToken?.('4');
          await new Promise<void>((r) => o?.signal?.addEventListener('abort', () => r()));
          this.ended = true; // the worker was terminated (R8)
          return { text: step === 'abort-after-token' ? '4' : '', finishReason: 'abort' as const };
        }
        o?.onToken?.('The grace');
        return { text: GRACE, finishReason: 'stop' as const };
      },
    };
    unload = vi.fn(async () => {
      this.unloaded = true;
    });
  }

  function engineSetup(opts: {
    sets: Step[][];
    loadErrors?: Record<number, unknown>;
    gate?: Promise<void>[];
  }) {
    const events = new EventLog();
    const made: FakeSet[] = [];
    let loadCalls = 0;
    const gates = opts.gate ?? [];
    const load = vi.fn(async () => {
      const n = ++loadCalls;
      await gates[n - 1];
      if (opts.loadErrors?.[n] !== undefined) throw opts.loadErrors[n];
      const set = new FakeSet(opts.sets[Math.min(n - 1, opts.sets.length - 1)]!.slice());
      made.push(set);
      return {
        generator: set.generator,
        embedder: set.embedder,
        specialTokens: ['<|im_end|>'],
        unload: set.unload,
        manifest: { entries: [] },
      };
    });
    const asked: string[] = [];
    const c = new AppController({
      framed: false,
      events,
      models: {
        download: async () => undefined,
        load: load as never,
        status: async () => ({ cached: true }),
        plannedBytes: async () => 1,
      },
      makePipeline: (d) => ({
        open: async () => doc(),
        ask: async (q, o) => {
          asked.push(q);
          await d.embedder.embed([`query: ${q}`]);
          const r = await d.generator.generate([{ role: 'user', content: q }], {
            ...(o.signal === undefined ? {} : { signal: o.signal }),
            ...(o.onToken === undefined ? {} : { onToken: o.onToken }),
          });
          return { ...answer(r.text), finishReason: r.finishReason };
        },
        remove: async () => undefined,
        listKept: async () => [],
        adopt: async () => doc(),
        current: () => undefined,
      }),
      pipelineDeps: {
        store: {} as never,
        analysis: {} as never,
        extract: async () => ({ pages: [], skipped: [], truncated: false }),
      },
      detectCapability: async () => ({ profile: {} as never, verdict: 'meets' }),
      online: () => false, // offline: nothing may be fetched
    });
    const trail: string[] = [];
    c.subscribe(() => {
      const m = c.getState().model;
      const t = `${m.status}${m.reloading === true ? '+again' : ''}`;
      if (trail.at(-1) !== t) trail.push(t);
    });
    return { c, made, load, asked, trail };
  }
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 1));
    expect(f()).toBe(true);
  };

  it('Stop while the answer streams keeps the partial text; the next question re-loads once, from the stored manifest, and answers', async () => {
    const h = engineSetup({ sets: [['abort-after-token'], ['ok']] });
    await h.c.init();
    h.trail.splice(0, h.trail.length, h.c.getState().model.status); // the card's states from here on
    const first = h.c.ask('List every number that appears in the policy and what it means.');
    await until(() => h.c.getState().ask.streamed === '4');
    h.c.stop();
    await first;
    expect(h.c.getState().ask).toMatchObject({ status: 'done', displayText: '4' });
    expect(h.load).toHaveBeenCalledTimes(1);
    // the engine that was stopped is released, and the card says the files are on the device but nothing is loaded (not 'ready')
    expect(h.made[0]!.unload).toHaveBeenCalledTimes(1);
    expect(h.c.getState().model.status).toBe('cached');

    await h.c.ask('What is the grace period?');
    expect(h.load).toHaveBeenCalledTimes(2); // the existing load path again: re-verifies the stored manifest, loads from the cache
    expect(h.c.getState().ask).toMatchObject({
      status: 'done',
      displayText: GRACE,
      refusal: undefined,
    });
    expect(h.c.getState().model).toMatchObject({ status: 'ready', refusal: undefined });
    expect(h.trail).toEqual(['cached', 'loading', 'ready', 'cached', 'loading+again', 'ready']);
  });

  it('Stop before the first token is Stopped (no answer text, no refusal); the next question works the same way', async () => {
    const h = engineSetup({ sets: [['abort-before-token'], ['ok']] });
    await h.c.init();
    const first = h.c.ask('What is the grace period?');
    await until(() => h.made.length === 1 && h.made[0]!.generateCalls === 1);
    h.c.stop();
    await first;
    expect(h.c.getState().ask).toMatchObject({
      status: 'stopped',
      answer: undefined,
      displayText: '',
      refusal: undefined,
    });
    await h.c.ask('What is the grace period?');
    expect(h.c.getState().ask).toMatchObject({ status: 'done', displayText: GRACE });
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it('while the model is re-loading the status says so, and a second Ask is ignored until the re-load settles', async () => {
    let open: () => void = () => undefined;
    const second = new Promise<void>((r) => (open = r));
    const h = engineSetup({
      sets: [['abort-after-token'], ['ok']],
      gate: [Promise.resolve(), second],
    });
    await h.c.init();
    const first = h.c.ask('q1');
    await until(() => h.c.getState().ask.streamed === '4');
    h.c.stop();
    await first;

    const again = h.c.ask('What is the grace period?');
    await until(() => h.c.getState().model.status === 'loading');
    expect(h.c.getState().model.reloading).toBe(true);
    expect(h.c.getState().ask.status).toBe('working');
    await h.c.ask('a second question while the first waits for the model'); // ignored: Ask is disabled until the re-load settles
    expect(h.asked).toEqual(['q1', 'What is the grace period?']);
    open();
    await again;
    expect(h.c.getState().ask).toMatchObject({ status: 'done', displayText: GRACE });
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it('a re-load that is refused shows its own reason (manifest_refused, integrity), never "not downloaded"; the next Ask tries again', async () => {
    const refused = new Refusal('manifest_refused', undefined, { reason: 'no_valid_signature' });
    const h = engineSetup({ sets: [['abort-after-token'], ['ok']], loadErrors: { 2: refused } });
    await h.c.init();
    const first = h.c.ask('q1');
    await until(() => h.c.getState().ask.streamed === '4');
    h.c.stop();
    await first;
    await h.c.ask('What is the grace period?');
    expect(h.c.getState().ask).toMatchObject({
      status: 'refused',
      refusal: { reason: 'manifest_refused', detail: 'no_valid_signature' },
    });
    expect(h.c.getState().ask.refusal?.message).not.toMatch(/not downloaded/);
    expect(h.c.getState().model).toMatchObject({
      status: 'refused',
      refusal: { reason: 'manifest_refused', detail: 'no_valid_signature' },
    });
    // the third load (the second try) succeeds: nothing is stuck
    await h.c.ask('What is the grace period?');
    expect(h.c.getState().ask).toMatchObject({ status: 'done', displayText: GRACE });
    expect(h.c.getState().model.status).toBe('ready');

    const i = engineSetup({
      sets: [['abort-after-token'], ['ok']],
      loadErrors: { 2: new AdapterError('integrity', 'x') },
    });
    await i.c.init();
    const f2 = i.c.ask('q1');
    await until(() => i.c.getState().ask.streamed === '4');
    i.c.stop();
    await f2;
    await i.c.ask('What is the grace period?');
    expect(i.c.getState().ask.refusal?.reason).toBe('integrity');
  });

  it('model_not_cached appears only when the load says a file is really missing (a not_cached adapter error, or no stored manifest)', async () => {
    for (const missing of [new Refusal('model_not_cached'), new AdapterError('not_cached', 'x')]) {
      const h = engineSetup({ sets: [['abort-after-token'], ['ok']], loadErrors: { 2: missing } });
      await h.c.init();
      const first = h.c.ask('q1');
      await until(() => h.c.getState().ask.streamed === '4');
      h.c.stop();
      await first;
      await h.c.ask('What is the grace period?');
      expect(h.c.getState().ask.refusal?.reason).toBe('model_not_cached');
      expect(h.c.getState().model.status).toBe('absent');
    }
  });

  it('a generate that rejects not_loaded with no Stop (a crashed worker) is re-loaded once and retried, with the answer shown', async () => {
    const h = engineSetup({ sets: [['not_loaded'], ['ok']] });
    await h.c.init();
    await h.c.ask('What is the grace period?');
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.made[0]!.unload).toHaveBeenCalledTimes(1);
    expect(h.c.getState().ask).toMatchObject({ status: 'done', displayText: GRACE });
  });

  it('a not_loaded that survives the one re-load is a plain failure, not "not downloaded" and not a loop', async () => {
    const h = engineSetup({ sets: [['not_loaded'], ['not_loaded']] });
    await h.c.init();
    await h.c.ask('What is the grace period?');
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.c.getState().ask).toMatchObject({
      status: 'refused',
      refusal: { reason: 'failed', message: 'The answer failed.' },
    });
  });

  it('every AdapterErrorCode shows its intended outcome in the ask card (a table: nothing falls through to corrupt)', async () => {
    const table: Record<AdapterErrorCode, { status: string; reason?: string }> = {
      not_loaded: { status: 'refused', reason: 'failed' },
      unsupported_profile: { status: 'refused', reason: 'unsupported_profile' },
      unsupported_operation: { status: 'refused', reason: 'failed' },
      aborted: { status: 'stopped' },
      backend: { status: 'refused', reason: 'failed' },
      unavailable: { status: 'refused', reason: 'unsupported_profile' },
      bad_descriptor: { status: 'refused', reason: 'failed' },
      egress_refused: { status: 'refused', reason: 'failed' },
      integrity: { status: 'refused', reason: 'integrity' },
      context_overflow: { status: 'refused', reason: 'context_overflow' },
      not_cached: { status: 'refused', reason: 'model_not_cached' },
    };
    for (const [code, want] of Object.entries(table)) {
      const { c } = setup({
        pipeline: {
          ask: async () => {
            throw crossRealm(code);
          },
        },
      });
      await c.ask('q');
      const s = c.getState().ask;
      expect(s.status, code).toBe(want.status);
      expect(s.refusal?.reason, code).toBe(want.reason);
      expect(s.refusal?.reason, code).not.toBe('corrupt');
    }
  });

  it('an error that is not an AdapterError is a plain failure too, with the reason failed', async () => {
    const { c } = setup({
      pipeline: {
        ask: async () => {
          throw new TypeError('boom');
        },
      },
    });
    await c.ask('q');
    expect(c.getState().ask).toMatchObject({
      status: 'refused',
      refusal: { reason: 'failed', message: 'The answer failed.' },
    });
  });
});
