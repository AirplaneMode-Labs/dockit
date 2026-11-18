import { describe, expect, it } from 'vitest';
import { AdapterError } from '../../src/contracts/backend-adapter.ts';
import { StorageError } from '../../src/contracts/storage-api.ts';
import { createPipeline, type PipelineDeps } from '../../src/pipeline/pipeline.ts';
import { DEFAULT_SPECIAL_TOKENS, REFUSAL_REPLY } from '../../src/pipeline/prompt.ts';
import { Refusal } from '../../src/pipeline/reasons.ts';
import {
  FakeEmbedder,
  FakeGenerator,
  FakeStore,
  RecordingSink,
  asStore,
} from '../helpers/fakes.ts';

const FILE_NAME = 'secret-client-policy.pdf';
const PAGE_TEXTS = [
  'The sample policy covers a sample vehicle owned by the policy holder. The premium is paid yearly.',
  'The grace period for the sample policy is 45 days. Claims must be filed within 30 days of the event.',
  'The policy can be cancelled in writing. A refund is made for the unused period.',
];
const QUESTION = 'What is the grace period?';

const pdf = (extra = 0) => {
  const b = new Uint8Array(40 + extra);
  b.set(new TextEncoder().encode('%PDF-1.4\n'));
  b[20] = extra; // different bytes give a different docId
  return new File([b], FILE_NAME, { type: 'application/pdf' });
};
const oversize = (): File => {
  const f = pdf();
  Object.defineProperty(f, 'size', { value: 20_971_521 });
  return f;
};
const report = (states: string[], over: { encrypted?: boolean; pages?: number } = {}) => ({
  schema: 'pagetriage.structure/0.1',
  degraded: false,
  document: {
    pages: over.pages ?? states.length,
    sha256: 'x',
    source: 'pdf',
    producer: null,
    incremental_updates: null,
  },
  structure: { encrypted: over.encrypted ?? false },
  pages: states.map((s, i) => ({
    index: i,
    text_layer: { state: s, reliable: true, confidence: 1, evidence: [] },
  })),
  warnings: [],
});

function setup(
  over: Partial<PipelineDeps> & {
    states?: string[];
    scores?: (text: string) => number | null;
    reportOver?: Parameters<typeof report>[1];
  } = {},
) {
  const sink = new RecordingSink();
  const store = new FakeStore();
  const embedder = new FakeEmbedder();
  const generator = new FakeGenerator();
  const extractCalls: number[][] = [];
  const deps: PipelineDeps = {
    events: sink,
    store: asStore(store),
    embedder,
    generator,
    specialTokens: [...DEFAULT_SPECIAL_TOKENS],
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
    analysis: {
      triage: async () => ({
        report: report(
          over.states ?? ['native_text', 'native_text', 'native_text'],
          over.reportOver,
        ),
        peakWasmBytes: 1_000_000,
      }),
      gate: async (texts: string[]) =>
        texts.map((t) => toGate(over.scores ? over.scores(t) : 1_000_000)),
    },
    extract: async (_bytes, pages) => {
      extractCalls.push(pages);
      return {
        pages: pages.map((p) => ({ page: p, text: PAGE_TEXTS[p - 1]! })),
        skipped: [],
        truncated: false,
      };
    },
    ...over,
  } as PipelineDeps;
  return { pipeline: createPipeline(deps), sink, store, embedder, generator, extractCalls };
}

const toGate = (ppm: number | null) =>
  ppm === null
    ? { verdict: 'not_scored' as const, ppm: null, threshold: 975_000 }
    : { verdict: ppm >= 975_000 ? ('pass' as const) : ('hold' as const), ppm, threshold: 975_000 };
const stages = (sink: RecordingSink) =>
  sink
    .named('pipeline.stage')
    .map((e) => [e.attrs['stage'], e.attrs['outcome'], e.attrs['reason']]);

describe('pipeline: open a document', () => {
  it('runs read, triage, extract, chunk, gate, embed, index and emits one pipeline.stage event for each', async () => {
    const { pipeline, sink } = setup();
    const doc = await pipeline.open(pdf(), { keep: false });
    expect(stages(sink)).toEqual([
      ['read', 'ok', ''],
      ['triage', 'ok', ''],
      ['extract', 'ok', ''],
      ['chunk', 'ok', ''],
      ['gate', 'ok', ''],
      ['embed', 'ok', ''],
      ['index', 'ok', ''],
    ]);
    expect(doc.pages).toBe(3);
    expect(doc.chunks).toBeGreaterThanOrEqual(1);
    expect(doc.held).toBe(0);
    expect(doc.docId).toMatch(/^[0-9a-f]{32}$/);
    const index = sink.named('pipeline.stage').find((e) => e.attrs['stage'] === 'index')!;
    expect(index.attrs).toMatchObject({ pages: 3, chunks: doc.chunks, held: 0 });
  });

  it("indexes under the per-document namespace 'dockit.d' + docId and registers the prefix for event redaction", async () => {
    const { pipeline, store } = setup();
    const doc = await pipeline.open(pdf(), { keep: false });
    expect([...store.docs.keys()]).toEqual([`dockit.d${doc.docId}`]);
    expect(store.redacted).toEqual(['dockit.d']);
    const stored = await store.getDocument(`dockit.d${doc.docId}`, doc.docId);
    expect(stored).toMatchObject({ docId: doc.docId, pages: 3, title: 'document' });
    expect(stored!.title).not.toContain('pdf');
  });

  it("embeds 'passage: ' + text in batches of at most 32", async () => {
    const long = Array.from(
      { length: 300 },
      (_, i) => `Statement ${i} about the sample policy ends here. `,
    ).join('');
    const { pipeline, embedder } = setup({
      extract: async (_b, pages) => ({
        pages: pages.map((p) => ({ page: p, text: long })),
        skipped: [],
        truncated: false,
      }),
    });
    await pipeline.open(pdf(), { keep: false });
    expect(embedder.calls.length).toBeGreaterThan(1);
    for (const batch of embedder.calls) {
      expect(batch.length).toBeLessThanOrEqual(32);
      for (const t of batch) expect(t.startsWith('passage: ')).toBe(true);
    }
  });

  it('a chunk below the gate threshold is held, reported with ppm and threshold, and never embedded or indexed', async () => {
    const { pipeline, store, embedder, sink } = setup({
      scores: (t) => (t.includes('grace period') ? 400_000 : 1_000_000),
    });
    const doc = await pipeline.open(pdf(), { keep: false });
    expect(doc.held).toBeGreaterThanOrEqual(1);
    expect(doc.heldChunks[0]).toMatchObject({
      reason: 'held_low_score',
      ppm: 400_000,
      threshold: 975_000,
    });
    expect(doc.heldChunks[0]!.message).toMatch(/400000 ppm.*975000 ppm/);
    const hits = await store.queryChunks(
      `dockit.d${doc.docId}`,
      new Float32Array(32).fill(0.1),
      50,
    );
    for (const h of hits) expect(h.text).not.toContain('grace period');
    for (const b of embedder.calls) for (const t of b) expect(t).not.toContain('grace period');
    const gate = sink.named('pipeline.stage').find((e) => e.attrs['stage'] === 'gate')!;
    expect(gate.attrs['held']).toBe(doc.held);
  });

  it('skipped pages are reported with their reasons and the other pages are still read', async () => {
    const { pipeline, extractCalls } = setup({
      states: ['native_text', 'raster_only', 'native_text'],
    });
    const doc = await pipeline.open(pdf(), { keep: false });
    expect(extractCalls).toEqual([[1, 3]]);
    expect(doc.skippedPages).toEqual([{ page: 2, reason: 'ocr_not_yet' }]);
  });

  it('keep without a persistent store is ignored: the document stays in memory and nothing is kept', async () => {
    const a = setup();
    const d1 = await a.pipeline.open(pdf(), { keep: true });
    expect(d1.kept).toBe(false);
    expect(a.store.kv.size).toBe(0);
  });

  it('opening a second document keeps both and queries only the current one', async () => {
    const { pipeline, store } = setup();
    const d1 = await pipeline.open(pdf(1), { keep: false });
    const d2 = await pipeline.open(pdf(2), { keep: false });
    expect(d1.docId).not.toBe(d2.docId);
    expect(pipeline.current()?.docId).toBe(d2.docId);
    expect([...store.docs.keys()].sort()).toEqual(
      [`dockit.d${d1.docId}`, `dockit.d${d2.docId}`].sort(),
    );
  });

  it('remove(): clears the namespace physically, deletes the kept entry, and forgets the document', async () => {
    const { pipeline, store } = setup();
    const d = await pipeline.open(pdf(), { keep: true });
    await pipeline.remove(d.docId);
    expect(store.cleared).toEqual([`dockit.d${d.docId}`]);
    expect(await store.get('dockit.kept', d.docId)).toBeUndefined();
    expect(pipeline.current()).toBeUndefined();
    await expect(pipeline.ask(QUESTION, {})).rejects.toMatchObject({ reason: 'no_index' });
  });
});

// BUG-T2-S5-10: one chunk that the embedder or the store refuses must not end the whole document as a generic 'error'.
describe('pipeline: one rejected chunk is held, never the whole document (BUG-T2-S5-10)', () => {
  const FILLER = 'This sentence only fills the page with ordinary words about the policy. ';
  const longPage = (extra = '') => `${FILLER.repeat(5)}${extra}${FILLER.repeat(3)}`;
  /** Three pages of more than 200 units each: one chunk per page. */
  const threePages = (extra: Record<number, string> = {}): Partial<PipelineDeps> => ({
    extract: async (_b: Uint8Array, pages: number[]) => ({
      pages: pages.map((p) => ({ page: p, text: longPage(extra[p] ?? '') })),
      skipped: [],
      truncated: false,
    }),
  });

  it('a page with a lone surrogate: the gate is given well-formed text and scores it, embed and putDocument accept it, nothing is held', async () => {
    const seen: string[] = [];
    const { pipeline, store, sink } = setup({
      ...threePages({ 2: 'The grace period is 45 days. \ud800 broken glyph. ' }),
      analysis: {
        triage: async () => ({
          report: report(['native_text', 'native_text', 'native_text']),
          peakWasmBytes: 1,
        }),
        // glyphsift's gate() throws a TypeError for an ill-formed string, which the worker turns into null (not scored)
        gate: async (texts: string[]) =>
          texts.map((t) => {
            seen.push(t);
            return t.isWellFormed() ? toGate(1_000_000) : null;
          }),
      },
    });
    const doc = await pipeline.open(pdf(), { keep: false });
    expect(seen.length).toBe(doc.chunks);
    expect(seen.every((t) => t.isWellFormed())).toBe(true);
    expect(doc.held).toBe(0);
    expect(doc.heldChunks).toEqual([]);
    const hits = await store.queryChunks(
      `dockit.d${doc.docId}`,
      new Float32Array(32).fill(0.1),
      10,
    );
    expect(
      hits.some((h) => h.text.includes('The grace period is 45 days. \ufffd broken glyph.')),
    ).toBe(true);
    expect(sink.named('pipeline.stage').every((e) => e.attrs['outcome'] === 'ok')).toBe(true);
  });

  it('the embedder refuses one chunk: it is held (not_analysed), the others are embedded and indexed, and the stages stay ok', async () => {
    const { pipeline, store, embedder, sink } = setup(threePages({ 2: 'POISON ' }));
    embedder.reject = (t) => t.includes('POISON');
    const doc = await pipeline.open(pdf(), { keep: false });
    expect(doc.chunks).toBe(2);
    expect(doc.held).toBe(1);
    expect(doc.heldChunks).toHaveLength(1);
    expect(doc.heldChunks[0]).toMatchObject({
      reason: 'not_analysed',
      pages: '2',
      ppm: null,
      threshold: null,
    });
    expect(doc.heldChunks[0]!.message).toMatch(/could not be embedded.*not searched/);
    const hits = await store.queryChunks(
      `dockit.d${doc.docId}`,
      new Float32Array(32).fill(0.1),
      10,
    );
    expect(hits).toHaveLength(2);
    for (const h of hits) expect(h.text).not.toContain('POISON');
    const stages = sink.named('pipeline.stage');
    expect(stages.every((e) => e.attrs['outcome'] === 'ok')).toBe(true);
    expect(stages.find((e) => e.attrs['stage'] === 'index')!.attrs).toMatchObject({
      chunks: 2,
      held: 1,
    });
    // the batch was retried one text at a time, so only the poisoned text was lost
    expect(embedder.calls.some((c) => c.length === 1 && c[0]!.includes('POISON'))).toBe(true);
  });

  it('the store refuses one chunk (invalid_value with details.row): it is held, the commit is retried without it, the others are stored', async () => {
    const { pipeline, store, sink } = setup(threePages());
    store.rejectOrdinal = 1;
    const doc = await pipeline.open(pdf(), { keep: false });
    expect(doc.chunks).toBe(2);
    expect(doc.held).toBe(1);
    expect(doc.heldChunks[0]).toMatchObject({ reason: 'not_analysed', ordinal: 1, pages: '2' });
    expect(doc.heldChunks[0]!.message).toMatch(/could not be stored.*not searched/);
    const info = await store.getDocument(`dockit.d${doc.docId}`, doc.docId);
    expect(info!.chunks).toBe(2);
    const hits = await store.queryChunks(
      `dockit.d${doc.docId}`,
      new Float32Array(32).fill(0.1),
      10,
    );
    expect(hits.map((h) => h.ordinal).sort()).toEqual([0, 2]);
    expect(sink.named('pipeline.stage').every((e) => e.attrs['outcome'] === 'ok')).toBe(true);
  });

  it('a gate hold and an embed hold are both reported, and doc.held counts both', async () => {
    const { pipeline, embedder } = setup({
      ...threePages({ 1: 'LOWSCORE ', 3: 'POISON ' }),
      scores: (t) => (t.includes('LOWSCORE') ? 100_000 : 1_000_000),
    });
    embedder.reject = (t) => t.includes('POISON');
    const doc = await pipeline.open(pdf(), { keep: false });
    expect(doc.chunks).toBe(1);
    expect(doc.held).toBe(2);
    expect(doc.heldChunks.map((h) => h.reason).sort()).toEqual(['held_low_score', 'not_analysed']);
  });

  it('every chunk refused by the embedder is a real failure, not a document with zero passages: the first error is rethrown and the stage says error', async () => {
    const { pipeline, embedder, sink, store } = setup(threePages());
    embedder.reject = () => true;
    await expect(pipeline.open(pdf(), { keep: false })).rejects.toBeInstanceOf(TypeError);
    const last = sink.named('pipeline.stage').at(-1)!;
    expect([last.attrs['stage'], last.attrs['outcome']]).toEqual(['embed', 'error']);
    expect(store.docs.size).toBe(0);
  });

  it('a systemic embedder failure (integrity) still stops the document with its own reason: it is never turned into a held chunk', async () => {
    const { pipeline, embedder } = setup(threePages());
    embedder.failWith = new AdapterError('integrity', 'a model file did not match');
    await expect(pipeline.open(pdf(), { keep: false })).rejects.toMatchObject({
      name: 'Refusal',
      reason: 'integrity',
    });
    // the batch is not retried text by text for a systemic failure
    expect(embedder.calls).toHaveLength(1);
  });

  it('a store failure with no row to blame (an injected failure at chunk 1) stops the document and leaves nothing behind', async () => {
    const { pipeline, store, sink } = setup(threePages());
    store.failAtChunk = 1;
    await expect(pipeline.open(pdf(), { keep: false })).rejects.toThrow('injected failure');
    expect(store.docs.size).toBe(0);
    const last = sink.named('pipeline.stage').at(-1)!;
    expect([last.attrs['stage'], last.attrs['outcome']]).toEqual(['index', 'error']);
  });

  it('a store refusal that is not about one chunk (details.reason dim) is rethrown, not retried away', async () => {
    const { pipeline, store } = setup(threePages());
    store.putDocument = async () => {
      throw new StorageError('invalid_value', 'dim', { reason: 'dim', row: 0 });
    };
    await expect(pipeline.open(pdf(), { keep: false })).rejects.toMatchObject({
      code: 'invalid_value',
    });
  });

  it('a store that refuses every chunk one after another ends the document with the last refusal instead of an empty index', async () => {
    const { pipeline, store } = setup(threePages());
    store.putDocument = async () => {
      throw new StorageError('invalid_value', 'text', { reason: 'text', row: 0 });
    };
    await expect(pipeline.open(pdf(), { keep: false })).rejects.toMatchObject({
      code: 'invalid_value',
    });
    expect(store.docs.size).toBe(0);
  });
});

describe('pipeline: refusals stop the run, with the documented reason and no later stage', () => {
  const cases: [string, () => Partial<Parameters<typeof setup>[0]>, File, string, string][] = [
    ['oversize', () => ({}), oversize(), 'read', 'too_large'],
    [
      'not a pdf',
      () => ({}),
      new File([new TextEncoder().encode('plain text')], 'a.txt'),
      'read',
      'not_pdf',
    ],
    [
      'scanned',
      () => ({ states: ['raster_only', 'raster_only'] }),
      pdf(),
      'triage',
      'no_text_layer',
    ],
    ['encrypted', () => ({ reportOver: { encrypted: true } }), pdf(), 'triage', 'encrypted'],
    ['301 pages', () => ({ reportOver: { pages: 301 } }), pdf(), 'triage', 'too_many_pages'],
    [
      'corrupt report',
      () => ({
        analysis: {
          triage: async () => {
            throw new Error('bad pdf');
          },
          gate: async () => [],
        },
      }),
      pdf(),
      'triage',
      'corrupt',
    ],
    [
      'extract timeout',
      () => ({
        extract: async () => {
          throw new Refusal('timeout');
        },
      }),
      pdf(),
      'extract',
      'timeout',
    ],
  ];
  it.each(cases)('%s', async (_name, over, file, stage, reason) => {
    const { pipeline, sink, embedder, store } = setup(over() as never);
    await expect(pipeline.open(file, { keep: false })).rejects.toMatchObject({
      name: 'Refusal',
      reason,
    });
    const seen = sink.named('pipeline.stage');
    const last = seen[seen.length - 1]!;
    expect([last.attrs['stage'], last.attrs['outcome'], last.attrs['reason']]).toEqual([
      stage,
      'refused',
      reason,
    ]);
    expect(embedder.calls).toEqual([]);
    expect(store.docs.size).toBe(0);
  });

  it('a no_text_layer refusal carries the per-page reasons for display', async () => {
    const { pipeline } = setup({ states: ['raster_only'] });
    const err = await pipeline.open(pdf(), { keep: false }).catch((e) => e);
    expect(err.detail).toMatchObject({ pages: [{ page: 1, reason: 'ocr_not_yet' }] });
  });

  it('an oversize file is refused before its bytes are read (no triage or extract call)', async () => {
    const { pipeline, extractCalls, sink } = setup();
    await expect(pipeline.open(oversize(), { keep: false })).rejects.toMatchObject({
      reason: 'too_large',
    });
    expect(extractCalls).toEqual([]);
    expect(sink.named('pipeline.stage').map((e) => e.attrs['stage'])).toEqual(['read']);
  });
});

describe('pipeline: ask', () => {
  async function opened(over: Parameters<typeof setup>[0] = {}) {
    const s = setup(over);
    const doc = await s.pipeline.open(pdf(), { keep: false });
    return { ...s, doc };
  }

  it("embeds 'query: ' + the question, retrieves k=4 chunks, and answers from the model with sources and their pages", async () => {
    const { pipeline, embedder, generator, doc } = await opened();
    const a = await pipeline.ask(QUESTION, {});
    expect(embedder.calls.at(-1)).toEqual([`query: ${QUESTION}`]);
    expect(a.text).toBe('The grace period is 45 days [S1].');
    expect(a.sources.length).toBeLessThanOrEqual(4);
    expect(a.sources.length).toBe(doc.chunks > 4 ? 4 : doc.chunks);
    expect(a.sources[0]!.id).toBe('S1');
    expect(a.sources.every((s) => /^\d+( to \d+)?$/.test(s.pages))).toBe(true);
    expect(a.cited.map((c) => c.id)).toEqual(['S1']);
    expect(a.unknownCitations).toBe(0);
    expect(generator.lastOpts).toMatchObject({ maxTokens: 256, temperature: 0 });
    expect(a.firstTokenMs).toBe(5);
  });

  it('the prompt carries each retrieved chunk as a <source> with its page, the question last, and no tools', async () => {
    const { pipeline, generator } = await opened();
    await pipeline.ask(QUESTION, {});
    const user = generator.prompts[0]![1]!.content;
    expect(user).toMatch(/<source id="S1" page="\d+">/);
    expect(user.endsWith(`Question: ${QUESTION}`)).toBe(true);
    expect(generator.prompts[0]![0]!.role).toBe('system');
  });

  it('a model-invented [S9] is dropped and counted; the panel still lists only retrieved chunks', async () => {
    const { pipeline, generator } = await opened();
    generator.respond = () => 'It is 45 days [S9] and also [S1].';
    const a = await pipeline.ask(QUESTION, {});
    expect(a.cited.map((c) => c.id)).toEqual(['S1']);
    expect(a.unknownCitations).toBe(1);
    expect(a.sources.map((s) => s.id)).not.toContain('S9');
  });

  it('the refusal reply is passed through and cites nothing', async () => {
    const { pipeline, generator } = await opened();
    generator.respond = () => REFUSAL_REPLY;
    const a = await pipeline.ask('What colour is the moon?', {});
    expect(a.text).toBe(REFUSAL_REPLY);
    expect(a.cited).toEqual([]);
  });

  it('on context_overflow it drops the lowest-ranked source and retries, at most 3 times', async () => {
    const { pipeline, generator } = await opened({
      extract: async (_b, pages) => ({
        pages: pages.map((p) => ({
          page: p,
          text: Array.from(
            { length: 30 },
            (_, i) => `Paragraph ${i} on page ${p} about the sample policy. `,
          ).join(''),
        })),
        skipped: [],
        truncated: false,
      }),
    });
    generator.respond = (_m, attempt) =>
      attempt <= 2 ? new AdapterError('context_overflow', 'too long') : 'ok [S1]';
    const a = await pipeline.ask(QUESTION, {});
    expect(generator.prompts).toHaveLength(3);
    const counts = generator.prompts.map((p) => [...p[1]!.content.matchAll(/<source /g)].length);
    expect(counts[0]).toBe(4);
    expect(counts[1]).toBe(3);
    expect(counts[2]).toBe(2);
    expect(a.sources).toHaveLength(2);
  });

  it('after 3 retries that still overflow it refuses with context_overflow', async () => {
    const { pipeline, generator } = await opened({
      extract: async (_b, pages) => ({
        pages: pages.map((p) => ({
          page: p,
          text: Array.from(
            { length: 30 },
            (_, i) => `Paragraph ${i} on page ${p} about the sample policy. `,
          ).join(''),
        })),
        skipped: [],
        truncated: false,
      }),
    });
    generator.respond = () => new AdapterError('context_overflow', 'too long');
    await expect(pipeline.ask(QUESTION, {})).rejects.toMatchObject({ reason: 'context_overflow' });
    expect(generator.prompts).toHaveLength(4);
  });

  it('maps adapter errors to documented reasons: integrity, unsupported_profile, and an abort is not a refusal', async () => {
    const { pipeline, generator } = await opened();
    generator.respond = () => new AdapterError('integrity', 'x');
    await expect(pipeline.ask(QUESTION, {})).rejects.toMatchObject({ reason: 'integrity' });
    generator.respond = () => new AdapterError('unsupported_profile', 'x');
    await expect(pipeline.ask(QUESTION, {})).rejects.toMatchObject({
      reason: 'unsupported_profile',
    });
    generator.respond = () => new AdapterError('aborted', 'x');
    await expect(pipeline.ask(QUESTION, {})).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'aborted',
    });
  });

  // BUG-T1-S5-R2-02: Stop before the first token is the user's own choice, not a failure
  it('an abort before the first token is outcome skipped on both events, with no reason, and is rethrown as the adapter error', async () => {
    const { pipeline, generator, sink } = await opened();
    const crossRealm = Object.assign(new Error('stopped'), {
      name: 'AdapterError',
      code: 'aborted',
    });
    generator.respond = () => crossRealm;
    await expect(pipeline.ask(QUESTION, {})).rejects.toBe(crossRealm);
    const gen = sink.named('pipeline.stage').filter((e) => e.attrs['stage'] === 'generate');
    expect(gen.map((e) => [e.attrs['outcome'], e.attrs['reason']])).toEqual([['skipped', '']]);
    const ans = sink.named('pipeline.answer');
    expect(ans).toHaveLength(1);
    expect(ans[0]!.attrs).toMatchObject({ outcome: 'skipped', reason: '' });
    expect(ans[0]!.level).not.toBe('error');
  });

  it('a generate that rejects not_loaded is an error outcome and is NOT turned into model_not_cached (the controller re-loads; this is what is left when that fails)', async () => {
    const { pipeline, generator, sink } = await opened();
    generator.respond = () => new AdapterError('not_loaded', 'x');
    await expect(pipeline.ask(QUESTION, {})).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'not_loaded',
    });
    const gen = sink.named('pipeline.stage').filter((e) => e.attrs['stage'] === 'generate');
    expect(gen.map((e) => [e.attrs['outcome'], e.attrs['reason']])).toEqual([['error', '']]);
    expect(sink.named('pipeline.answer')[0]!.attrs).toMatchObject({ outcome: 'error', reason: '' });
  });

  it('a not_cached adapter error (a model file really is missing from the device) is the model_not_cached refusal', async () => {
    const { pipeline, generator } = await opened();
    generator.respond = () => new AdapterError('not_cached', 'x');
    await expect(pipeline.ask(QUESTION, {})).rejects.toMatchObject({ reason: 'model_not_cached' });
  });

  it('emits pipeline.stage for retrieve and generate and one pipeline.answer with counts only', async () => {
    const { pipeline, sink } = await opened();
    await pipeline.ask(QUESTION, {});
    const names = sink.named('pipeline.stage').map((e) => e.attrs['stage']);
    expect(names.slice(-2)).toEqual(['retrieve', 'generate']);
    const ans = sink.named('pipeline.answer');
    expect(ans).toHaveLength(1);
    expect(ans[0]!.attrs).toMatchObject({
      outcome: 'ok',
      reason: '',
      unknownCitations: 0,
      budget: 256,
      firstTokenMs: 5,
    });
    expect(typeof ans[0]!.attrs['k']).toBe('number');
    expect(typeof ans[0]!.attrs['sources']).toBe('number');
  });

  it('no event carries the file name, the page text, the question, the answer, a doc id or a namespace', async () => {
    const { pipeline, sink, doc } = await opened();
    await pipeline.ask(QUESTION, {});
    const forbidden = [
      FILE_NAME,
      'secret-client',
      QUESTION,
      'grace period',
      'The grace period is 45 days',
      doc.docId,
      ...PAGE_TEXTS.map((t) => t.slice(0, 30)),
    ];
    for (const e of sink.events) {
      const dump = JSON.stringify([e.attrs, e.name, e.source]);
      for (const f of forbidden) expect(dump, `${e.name} carries "${f}"`).not.toContain(f);
    }
  });

  it('emits pipeline.memory with the analysis worker peak, or unavailable when the worker could not measure', async () => {
    const a = await opened();
    const mem = a.sink.named('pipeline.memory');
    expect(mem[0]!.attrs).toMatchObject({ worker: 'analysis', measure: 'wasm-memory' });
    expect(mem[0]!.bytes).toBe(1_000_000);
    const b = setup({
      analysis: {
        triage: async () => ({ report: report(['native_text']), peakWasmBytes: null }),
        gate: async (t: string[]) => t.map(() => toGate(1_000_000)),
      } as never,
      extract: async (_b, pages) => ({
        pages: pages.map((p) => ({ page: p, text: 'Hello there world.' })),
        skipped: [],
        truncated: false,
      }),
    });
    await b.pipeline.open(pdf(), { keep: false });
    expect(b.sink.named('pipeline.memory')[0]!.attrs['measure']).toBe('unavailable');
    expect(b.sink.named('pipeline.memory')[0]!.bytes).toBeUndefined();
  });

  it('ask before any document is a no_index refusal', async () => {
    const { pipeline } = setup();
    await expect(pipeline.ask(QUESTION, {})).rejects.toMatchObject({ reason: 'no_index' });
  });

  it('a document whose every chunk was held has an empty index: asking is a no_index refusal', async () => {
    const { pipeline } = setup({ scores: () => 100 });
    const d = await pipeline.open(pdf(), { keep: false });
    expect(d.chunks).toBe(0);
    expect(d.held).toBeGreaterThan(0);
    await expect(pipeline.ask(QUESTION, {})).rejects.toMatchObject({ reason: 'no_index' });
  });
});

describe('pipeline: keep on this device (opt-in persistence, TD-41)', () => {
  function withPersistent() {
    const persistent = new FakeStore();
    const s = setup({ persistent: async () => asStore(persistent) } as never);
    return { ...s, persistent };
  }

  it('a kept document goes to the persistent store, an unkept one to the memory store', async () => {
    const { pipeline, store, persistent } = withPersistent();
    const kept = await pipeline.open(pdf(1), { keep: true });
    const mem = await pipeline.open(pdf(2), { keep: false });
    expect([...persistent.docs.keys()]).toEqual([`dockit.d${kept.docId}`]);
    expect([...store.docs.keys()]).toEqual([`dockit.d${mem.docId}`]);
    expect(await persistent.get('dockit.kept', kept.docId)).toEqual({
      ns: `dockit.d${kept.docId}`,
    });
    expect(store.kv.size).toBe(0);
  });

  it('asking queries the store the current document lives in', async () => {
    const { pipeline, store, persistent } = withPersistent();
    await pipeline.open(pdf(1), { keep: true });
    const a = await pipeline.ask(QUESTION, {});
    expect(a.sources.length).toBeGreaterThan(0);
    expect(store.docs.size).toBe(0);
    expect(persistent.docs.size).toBe(1);
  });

  it('remove() of a kept document clears its namespace in the persistent store and its kept entry', async () => {
    const { pipeline, persistent, store } = withPersistent();
    const d = await pipeline.open(pdf(1), { keep: true });
    await pipeline.remove(d.docId);
    expect(persistent.cleared).toEqual([`dockit.d${d.docId}`]);
    expect(store.cleared).toEqual([]);
    expect(await persistent.get('dockit.kept', d.docId)).toBeUndefined();
    expect(persistent.docs.size).toBe(0);
  });

  it('after a reload, listKept() reads the kept list and adopt() makes a saved document current without re-reading any PDF', async () => {
    const first = withPersistent();
    const d = await first.pipeline.open(pdf(1), { keep: true });
    // a new page load: a new pipeline over the same persistent store, nothing in memory
    const second = setup({ persistent: async () => asStore(first.persistent) } as never);
    expect(await second.pipeline.listKept()).toEqual([
      { docId: d.docId, ns: `dockit.d${d.docId}`, pages: 3, chunks: d.chunks },
    ]);
    const adopted = await second.pipeline.adopt(d.docId);
    expect(adopted).toMatchObject({ docId: d.docId, chunks: d.chunks, kept: true });
    expect(second.extractCalls).toEqual([]);
    const a = await second.pipeline.ask(QUESTION, {});
    expect(a.sources.length).toBeGreaterThan(0);
  });

  it('listKept() is empty without a persistent store, and adopt() of an unknown id is a no_index refusal', async () => {
    const { pipeline } = setup();
    expect(await pipeline.listKept()).toEqual([]);
    await expect(pipeline.adopt('0'.repeat(32))).rejects.toMatchObject({ reason: 'no_index' });
  });
});
