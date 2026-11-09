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

describe('memory store (StorageApi 0.1)', () => {
  it('round-trips values and deletes', async () => {
    const s = new MemoryStore();
    await s.set('ns', 'k', { a: 1 });
    expect(await s.get('ns', 'k')).toEqual({ a: 1 });
    expect(await s.delete('ns', 'k')).toBe(true);
    expect(await s.get('ns', 'k')).toBeUndefined();
  });

  it('query throws not_implemented naming Sprint 4', async () => {
    const s = new MemoryStore();
    const err = await s.query('ns', new Float32Array(4), 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe('not_implemented');
    expect((err as StorageError).message).toMatch(/Sprint 4/);
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
