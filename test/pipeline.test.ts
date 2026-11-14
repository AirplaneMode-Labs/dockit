import { describe, expect, it } from 'vitest';
import { EVENT_NAME_PATTERN, EVENT_SPEC } from '../src/contracts/event.ts';
import { StorageError } from '../src/contracts/storage-api.ts';
import { AdapterError } from '../src/contracts/backend-adapter.ts';
import { MemoryStore } from '../src/pipeline/memory-store.ts';
import { MockAdapter } from '../src/pipeline/mock-adapter.ts';
import { EventLog, newEvent } from '../src/pipeline/events.ts';
import { pdfStage } from '../src/pipeline/stages/pdf.ts';
import { triageStage } from '../src/pipeline/stages/triage.ts';
import { extractStage } from '../src/pipeline/stages/extract.ts';
import { glyphGateStage } from '../src/pipeline/stages/glyphGate.ts';
import { storeStage } from '../src/pipeline/stages/store.ts';
import { answerStage } from '../src/pipeline/stages/answer.ts';
import { runPipeline, STAGE_ORDER } from '../src/pipeline/run.ts';
import { TRUSTED_KEYS } from '../src/trust.ts';
import type { PipelineInput } from '../src/pipeline/types.ts';

function syntheticPdf(bytes = 4096): Blob {
  // Synthetic bytes only. Looks nothing like a real document on purpose.
  const buf = new Uint8Array(bytes);
  let x = 0x12345678;
  for (let i = 0; i < bytes; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    buf[i] = x & 0xff;
  }
  return new Blob([buf], { type: 'application/pdf' });
}

function input(): PipelineInput {
  return { file: syntheticPdf(), fileName: 'synthetic.pdf', question: 'What is this?' };
}

describe('stage stubs', () => {
  it('pdf stage returns pageCount unknown for any input', async () => {
    for (const blob of [syntheticPdf(0), syntheticPdf(10), syntheticPdf(100_000)]) {
      const r = await pdfStage({ ...input(), file: blob });
      expect(r.pageCount).toBe('unknown');
      expect(r.bytes).toBe(blob.size);
      expect(r.stub).toBe(true);
    }
  });

  it('triage stage returns unknown kinds', async () => {
    const r = await triageStage(await pdfStage(input()));
    expect(r.pageKinds).toEqual([]);
    expect(r.summary).toBe('unknown');
    expect(r.stub).toBe(true);
  });

  it('extract stage reports source none and no text', async () => {
    const r = await extractStage(await triageStage(await pdfStage(input())));
    expect(r.source).toBe('none');
    expect(r.chunks).toEqual([]);
    expect(r.stub).toBe(true);
  });

  it('glyph gate stage passes with a null clean fraction and a stub flag', async () => {
    const r = await glyphGateStage(await extractStage(await triageStage(await pdfStage(input()))));
    expect(r.passed).toBe(true);
    expect(r.cleanFraction).toBeNull();
    expect(r.stub).toBe(true);
  });

  it('store stage writes through the StorageApi and reports what it stored', async () => {
    const store = new MemoryStore();
    const gate = await glyphGateStage(
      await extractStage(await triageStage(await pdfStage(input()))),
    );
    const r = await storeStage(gate, { store, documentId: 'doc-1' });
    expect(r.namespace).toBe('dockit.documents');
    expect(r.stored).toBe(1);
    expect(await store.get(r.namespace, 'doc-1')).toMatchObject({ chunks: 0 });
    expect(r.stub).toBe(true);
  });

  it('answer stage returns a placeholder-prefixed answer through the adapter', async () => {
    const store = new MemoryStore();
    const adapter = new MockAdapter();
    await adapter.load(MockAdapter.placeholderEntry(), MockAdapter.placeholderLoadOptions());
    const gate = await glyphGateStage(
      await extractStage(await triageStage(await pdfStage(input()))),
    );
    const stored = await storeStage(gate, { store, documentId: 'doc-1' });
    const r = await answerStage(stored, { adapter, question: 'What is this?' });
    expect(r.answer.startsWith('placeholder:')).toBe(true);
    expect(r.finishReason).toBe('stop');
    expect(r.stub).toBe(true);
  });
});

describe('memory store (StorageApi 0.2 interface, KV only)', () => {
  it('round-trips values and deletes', async () => {
    const s = new MemoryStore();
    await s.set('ns', 'k', { a: 1 });
    expect(await s.get('ns', 'k')).toEqual({ a: 1 });
    expect(await s.delete('ns', 'k')).toBe(true);
    expect(await s.get('ns', 'k')).toBeUndefined();
  });

  it('query and putVectors throw not_implemented naming Sprint 5; indexInfo says there is no index (no index wiring in this build)', async () => {
    const s = new MemoryStore();
    const q = await s.query('ns', new Float32Array(4), 3).catch((e: unknown) => e);
    expect(q).toBeInstanceOf(StorageError);
    expect((q as StorageError).code).toBe('not_implemented');
    expect((q as StorageError).message).toMatch(/Sprint 5/);
    const p = await s
      .putVectors('ns', [{ key: 'a', vector: new Float32Array(4) }])
      .catch((e: unknown) => e);
    expect(p).toBeInstanceOf(StorageError);
    expect((p as StorageError).code).toBe('not_implemented');
    expect((p as StorageError).message).toMatch(/Sprint 5/);
    expect(await s.indexInfo('ns')).toBeUndefined();
    // Errors never carry a key, a vector component or a value.
    expect(JSON.stringify([q, p])).not.toMatch(/"a"/);
  });

  it('rejects bad namespaces and keys', async () => {
    const s = new MemoryStore();
    await expect(s.set('Bad NS', 'k', 1)).rejects.toMatchObject({ code: 'invalid_namespace' });
    await expect(s.set('ns', '', 1)).rejects.toMatchObject({ code: 'invalid_key' });
    await expect(s.set('ns', 'a\u0000b', 1)).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('rejects unstorable values', async () => {
    const s = new MemoryStore();
    await expect(s.set('ns', 'k', new Map() as never)).rejects.toMatchObject({
      code: 'invalid_value',
    });
    await expect(s.set('ns', 'k', (() => 1) as never)).rejects.toMatchObject({
      code: 'invalid_value',
    });
  });
});

describe('mock adapter (BackendAdapter 0.1)', () => {
  it('echoes prompts and produces deterministic 64-dim embeddings', async () => {
    const a = new MockAdapter();
    expect(a.capabilities()).toEqual({ generate: true, embed: true, streaming: true });
    await expect(a.generate('hi')).rejects.toBeInstanceOf(AdapterError);
    await a.load(MockAdapter.placeholderEntry(), MockAdapter.placeholderLoadOptions());
    const r = await a.generate('hello');
    expect(r.text).toContain('hello');
    const e1 = await a.embed(['a', 'b']);
    const e2 = await a.embed(['a', 'b']);
    expect(e1.dims).toBe(64);
    expect(e1.vectors).toHaveLength(2);
    expect(Array.from(e1.vectors[0]!)).toEqual(Array.from(e2.vectors[0]!));
    expect(Array.from(e1.vectors[0]!)).not.toEqual(Array.from(e1.vectors[1]!));
    await a.unload();
    await expect(a.generate('hi')).rejects.toMatchObject({ code: 'not_loaded' });
  });
});

describe('events (Event 0.1 attrs rules enforced in code)', () => {
  it('produces schema-shaped events', () => {
    const e = newEvent({ source: 'dockit', kind: 'log', name: 'pipeline.start', level: 'info' });
    expect(e.spec).toBe(EVENT_SPEC);
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.isInteger(e.ts)).toBe(true);
    expect(e.name).toMatch(EVENT_NAME_PATTERN);
  });

  it('rejects attrs keys that may carry document text or identifiers', () => {
    for (const key of ['prompt', 'documentText', 'content', 'ua', 'userAgent', 'pageText']) {
      expect(() =>
        newEvent({ source: 'dockit', kind: 'log', name: 'x', level: 'info', attrs: { [key]: 1 } }),
      ).toThrow(TypeError);
    }
  });

  it('rejects more than 32 attrs keys and invalid key names', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 33; i++) many[`k${i}`] = i;
    expect(() =>
      newEvent({ source: 'dockit', kind: 'log', name: 'x', level: 'info', attrs: many }),
    ).toThrow(TypeError);
    expect(() =>
      newEvent({ source: 'dockit', kind: 'log', name: 'x', level: 'info', attrs: { '1bad': 1 } }),
    ).toThrow(TypeError);
  });

  it('truncates long strings and strips query strings from URLs', () => {
    const e = newEvent({
      source: 'dockit',
      kind: 'log',
      name: 'x',
      level: 'info',
      attrs: { long: 'a'.repeat(2000), url: 'https://example.invalid/path?secret=1#f' },
    });
    expect((e.attrs['long'] as string).length).toBe(1024);
    expect(e.attrs['url']).toBe('https://example.invalid/path');
  });

  it('validates the event name', () => {
    expect(() =>
      newEvent({ source: 'dockit', kind: 'log', name: 'Bad.Name', level: 'info' }),
    ).toThrow(TypeError);
  });

  it('the log keeps insertion order and notifies subscribers', () => {
    const log = new EventLog(3);
    const seen: string[] = [];
    log.subscribe((e) => seen.push(e.name));
    for (const n of ['a', 'b', 'c', 'd']) {
      log.emit(newEvent({ source: 'dockit', kind: 'log', name: n, level: 'debug' }));
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    expect(log.snapshot().map((e) => e.name)).toEqual(['b', 'c', 'd']);
  });
});

describe('pipeline run', () => {
  it('runs all six stages in order and emits schema-valid events', async () => {
    const log = new EventLog();
    const result = await runPipeline(input(), { events: log });
    expect(result.stages.map((s) => s.stage)).toEqual(STAGE_ORDER);
    expect(STAGE_ORDER).toEqual(['pdf', 'triage', 'extract', 'glyphGate', 'store', 'answer']);
    expect(result.answer.answer.startsWith('placeholder:')).toBe(true);
    expect(result.placeholder).toBe(true);
    const names = log.snapshot().map((e) => e.name);
    expect(names[0]).toBe('pipeline.start');
    expect(names.at(-1)).toBe('pipeline.complete');
    for (const stage of STAGE_ORDER) {
      expect(names).toContain(`pipeline.stage.${stage.toLowerCase()}`);
    }
    for (const e of log.snapshot()) {
      expect(e.name).toMatch(EVENT_NAME_PATTERN);
      expect(e.spec).toBe(EVENT_SPEC);
      for (const [k, v] of Object.entries(e.attrs)) {
        expect(k).not.toMatch(/prompt|text|content|document|ua|userAgent/i);
        if (typeof v === 'string') expect(v).not.toMatch(/:\/\/[^?]*\?/);
      }
    }
  });

  it('never puts the question or file name into event attrs', async () => {
    const log = new EventLog();
    await runPipeline(
      { ...input(), fileName: 'SECRET-name.pdf', question: 'SECRET question' },
      { events: log },
    );
    const json = JSON.stringify(log.snapshot());
    expect(json).not.toContain('SECRET');
  });
});

describe('trust set', () => {
  it('is empty and frozen until real keys are compiled in', () => {
    expect(TRUSTED_KEYS.size).toBe(0);
    expect(Object.isFrozen(TRUSTED_KEYS)).toBe(true);
  });
});

describe('planned model and backend chain card (D5-03)', () => {
  it('holds the model-card wording, sizes, source and chain as constants', async () => {
    const plan = await import('../src/pipeline/model-plan.ts');
    expect(plan.MODEL_PLAN.name).toBe('Qwen3-1.7B');
    expect(plan.MODEL_PLAN.licence).toBe('Apache-2.0');
    expect(plan.MODEL_PLAN.webgpu).toEqual({ dtype: 'q4f16', bytes: 1_426_069_098 });
    expect(plan.MODEL_PLAN.wasm).toEqual({ dtype: 'q8', bytes: 1_742_387_852 });
    expect(plan.MODEL_PLAN.source).toBe('onnx-community/Qwen3-1.7B-ONNX@3231b522c6e7');
    expect(plan.MODEL_PLAN.contingency).toBe('Qwen3-0.6B');
    expect(plan.MODEL_CARD_TEXT).toContain(
      'Planned production model: Qwen3-1.7B (Apache-2.0), WebGPU q4f16 1.43 GB, WASM q8 1.74 GB. Provisional until the Sprint 5 measurement on an 8 GB laptop; contingency Qwen3-0.6B.',
    );
    expect(plan.MODEL_CARD_TEXT).not.toContain('not yet loaded in a browser');
    expect(plan.MODEL_LOADED_IN_BROWSER).toBe(true);
    expect(plan.MODEL_CARD_TEXT).toContain(
      'Loaded once in a browser: a local, unscored WebGPU smoke run of five synthetic Hindi prompts on an Apple-silicon Mac, which needed ONNX Runtime graph optimisation turned off (evidence/sprint-2/D1/hindi-smoke.json).',
    );
    expect(plan.CHAIN.map((r) => r.id)).toEqual(['webgpu', 'wasm', 'builtin', 'refuse']);
    expect(plan.CHAIN.find((r) => r.id === 'builtin')?.label).toContain('opt-in');
  });

  it('prediction uses only booleans and typeof/in checks: no availability(), no create(), no fetch', async () => {
    const { predictBackends, PREDICTION_LABEL } = await import('../src/pipeline/model-plan.ts');
    let availabilityCalls = 0;
    let fetchCalls = 0;
    const env = {
      gpu: { requestAdapter: async () => ({ info: { description: 'SECRET-ADAPTER' } }) },
      webAssembly: 'object',
      globals: {
        LanguageModel: {
          availability: () => {
            availabilityCalls++;
            return 'available';
          },
          create: () => {
            availabilityCalls++;
          },
        },
      } as Record<string, unknown>,
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      fetchCalls++;
      throw new Error('no fetch allowed');
    }) as typeof fetch;
    try {
      const p = await predictBackends(env);
      expect(p).toEqual({ webgpu: true, wasm: true, builtinPresent: true });
      expect(JSON.stringify(p)).not.toContain('SECRET-ADAPTER');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(availabilityCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(PREDICTION_LABEL).toBe(
      'prediction; nothing is downloaded or loaded; inference arrives in Sprint 5',
    );
  });

  it('predicts false when WebGPU is absent, null adapter, or requestAdapter throws', async () => {
    const { predictBackends } = await import('../src/pipeline/model-plan.ts');
    const base = { webAssembly: 'undefined', globals: {} as Record<string, unknown> };
    expect(await predictBackends({ ...base, gpu: undefined })).toEqual({
      webgpu: false,
      wasm: false,
      builtinPresent: false,
    });
    expect(
      (await predictBackends({ ...base, gpu: { requestAdapter: async () => null } })).webgpu,
    ).toBe(false);
    expect(
      (
        await predictBackends({
          ...base,
          gpu: {
            requestAdapter: async () => {
              throw new Error('x');
            },
          },
        })
      ).webgpu,
    ).toBe(false);
  });
});

describe('dockit source hygiene (D5-03)', () => {
  it('imports no inference engine and uses no HTML injection', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/u.test(n)) files.push(p);
      }
    };
    walk(join(import.meta.dirname, '..', 'src'));
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/u,
      );
      expect(text, f).not.toMatch(
        /(from|import\()\s*['"](@huggingface|@mlc-ai|onnxruntime|web-llm)/u,
      );
      expect(text, f).not.toMatch(/\.availability\s*\(|LanguageModel\.create/u);
    }
  });
});

describe('MockAdapter against Backend adapter 0.2.0 (D5-01)', () => {
  it("reports device 'wasm' and available() true without loading anything", async () => {
    const a = new MockAdapter();
    expect(a.device).toBe('wasm');
    expect(await a.available(MockAdapter.placeholderProfile())).toBe(true);
    await expect(a.generate('x')).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('runtime chain labels, worded by LANDED.json (D5-01, Sprint 4)', () => {
  const NONE = { worker: false } as const;
  const WORKER = { worker: true } as const;

  it('default (nothing landed) is the conservative wording', async () => {
    const plan = await import('../src/pipeline/model-plan.ts');
    expect(plan.chainLabels(NONE)).toEqual({
      webgpu: 'WebGPU: Transformers.js q4f16',
      wasm: 'WebAssembly: Transformers.js q8',
    });
    expect(plan.chainSentence(NONE)).toBe(
      'runtime 0.2.0-alpha.1, tested with small test models only; dockit loads nothing until Sprint 5.',
    );
  });

  it('worker landed: the sentence says runtime 0.2.0-alpha.1 runs the engine in a worker', async () => {
    const plan = await import('../src/pipeline/model-plan.ts');
    expect(plan.chainLabels(WORKER)).toEqual({
      webgpu: 'WebGPU: Transformers.js q4f16, engine in a worker',
      wasm: 'WebAssembly: Transformers.js q8, engine in a worker',
    });
    expect(plan.chainSentence(WORKER)).toBe(
      'runtime 0.2.0-alpha.1 runs the engine in a worker, tested with small test models only; dockit loads nothing until Sprint 5.',
    );
  });

  it('no label, sentence or chain rung can name WebLLM: the rung is cut from Sprint 4 (TD-08)', async () => {
    const plan = await import('../src/pipeline/model-plan.ts');
    for (const l of [NONE, WORKER]) {
      expect(JSON.stringify([plan.chainLabels(l), plan.chainSentence(l)])).not.toMatch(
        /WebLLM|MLC/,
      );
    }
    expect(JSON.stringify([plan.CHAIN, plan.CHAIN_SENTENCE, plan.MODEL_CARD_TEXT])).not.toContain(
      'WebLLM',
    );
    // The one allowed mention is the not-yet wording, used by the not-yet box.
    expect(plan.WEBLLM_NOT_YET).toBe('a WebLLM rung (cut from Sprint 4)');
  });

  it('the not-yet box wording comes from the exported constant, and App.tsx carries no other WebLLM text', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const app = readFileSync(join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8');
    expect(app).toContain('WEBLLM_NOT_YET');
    expect(app).not.toMatch(/carried to Sprint 4/);
    for (const line of app.split('\n').filter((l) => /WebLLM/.test(l))) {
      expect(line, 'a WebLLM mention in App.tsx must be the not-yet wording').toMatch(
        /cut from Sprint 4|WEBLLM_NOT_YET|WebLLM rung yet/,
      );
    }
  });

  it('keeps the built-in and refuse rungs unchanged', async () => {
    const plan = await import('../src/pipeline/model-plan.ts');
    expect(plan.CHAIN.find((r) => r.id === 'builtin')?.label).toBe(
      'Chrome built-in model (opt-in, outside the verified chain)',
    );
    expect(plan.CHAIN.find((r) => r.id === 'refuse')?.label).toBe(
      'Refuse with a plain-language reason; nothing is downloaded silently',
    );
  });

  it('the shipped constant equals the LANDED.json state when that file is reachable', async () => {
    const plan = await import('../src/pipeline/model-plan.ts');
    const { existsSync, readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Lookup: env LANDED_JSON (a missing file is an error), else every <workspace>/evidence/sprint-<n>/D1/LANDED.json
    // merged in ascending sprint order (a later sprint's entry replaces an earlier one; Sprint 4's file does not
    // repeat the worker, which landed in Sprint 3). With neither, the cross-check is skipped, never guessed.
    const root = join(import.meta.dirname, '..');
    const fromEnv = process.env.LANDED_JSON ?? '';
    if (fromEnv !== '' && !existsSync(fromEnv)) {
      throw new Error(`LANDED_JSON names a file that does not exist: ${fromEnv}`);
    }
    let landed: Record<string, unknown> | undefined;
    if (fromEnv !== '') {
      landed = JSON.parse(readFileSync(fromEnv, 'utf8')) as Record<string, unknown>;
    } else {
      const evidence = join(root, '..', 'evidence');
      const sprints = existsSync(evidence)
        ? readdirSync(evidence)
            .map((n) => /^sprint-(\d+)$/u.exec(n))
            .filter((m): m is RegExpExecArray => m !== null)
            .map((m) => Number(m[1]))
            .sort((x, y) => x - y)
        : [];
      for (const n of sprints) {
        const f = join(evidence, `sprint-${n}`, 'D1', 'LANDED.json');
        if (existsSync(f)) {
          landed = {
            ...(landed ?? {}),
            ...(JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>),
          };
        }
      }
    }
    if (landed !== undefined) {
      const green = (k: string): boolean => {
        const v = landed![k];
        if (typeof v === 'string') return v.startsWith('green');
        return typeof v === 'object' && v !== null && (v as { status?: string }).status === 'green';
      };
      expect(plan.RUNTIME_LANDED).toEqual({ worker: green('worker') });
      // WebLLM is never green: 'not landed' in Sprint 3, 'cut' in Sprint 4.
      expect(green('webllm')).toBe(false);
    }
    expect(plan.RUNTIME_LANDED).toEqual({ worker: true });
    expect(plan.CHAIN.find((r) => r.id === 'webgpu')?.label).toBe(
      plan.chainLabels(plan.RUNTIME_LANDED).webgpu,
    );
    expect(plan.CHAIN_SENTENCE).toBe(plan.chainSentence(plan.RUNTIME_LANDED));
  });

  it('the card says the engine runs in a worker and claims no dockit inference and no WebLLM', async () => {
    const plan = await import('../src/pipeline/model-plan.ts');
    expect(plan.CHAIN_SENTENCE).toBe(
      'runtime 0.2.0-alpha.1 runs the engine in a worker, tested with small test models only; dockit loads nothing until Sprint 5.',
    );
    expect(plan.CHAIN.find((r) => r.id === 'wasm')?.label).toBe(
      'WebAssembly: Transformers.js q8, engine in a worker',
    );
    expect(JSON.stringify([plan.CHAIN, plan.CHAIN_SENTENCE])).not.toMatch(/WebLLM/);
  });
});
