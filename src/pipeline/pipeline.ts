import {
  AdapterError,
  type AdapterErrorCode,
  type BackendAdapter,
  type GenerateResult,
} from '../contracts/backend-adapter.ts';
import type { ModelPool } from '../model/model-pool.ts';
import type { EventSink } from '../contracts/event.ts';
import type { ChunkInput, StorageApi } from '../contracts/storage-api.ts';
import { StorageError } from '../contracts/storage-api.ts';
import type { ExtractResult } from '../workers/pdf-extract.ts';
import { chunkPages, type Chunk } from './chunk.ts';
import {
  buildSourcesPanel,
  parseCitations,
  type CitedSource,
  type RetrievedSource,
  type SourceRow,
} from './citations.ts';
import { newEvent } from './events.ts';
import { gateChunks, type GatedChunk, type GateVerdict, type WorkerGate } from './gate.ts';
import { CONTEXT_RETRIES, EMBED_BATCH, MAX_TOKENS, TOP_K } from './limits.ts';
import { buildPrompt } from './prompt.ts';
import { readPdf, sha256Hex } from './read.ts';
import { Refusal, isRefusal, type PipelineReason, type PipelineStage } from './reasons.ts';
import { routePages, type StructureReport } from './route.ts';

export const EVENT_SOURCE = 'dockit';
export const NS_PREFIX = 'dockit.d';
export const KEPT_NS = 'dockit.kept';
export const DOC_TITLE = 'document';

export interface AnalysisPort {
  /**
   * pagetriage in the analysis worker: the parsed structure report, and the worker's peak wasm memory when it could be measured. The bytes
   * are TRANSFERRED to the worker (not copied) and handed back in `bytes`: the caller must not use its own reference afterwards, and the
   * pipeline checks that what comes back is what was read (B1 M3).
   */
  triage(
    bytes: Uint8Array,
  ): Promise<{ report: StructureReport; peakWasmBytes: number | null; bytes: Uint8Array }>;
  /** glyphsift gate() in the analysis worker: one verdict per text, or null where the gate refused or failed. */
  gate(texts: string[]): Promise<(WorkerGate | null)[]>;
}

export interface PipelineDeps {
  events: EventSink;
  /** The in-memory store: where every document lives unless the user opts in to keeping it. */
  store: StorageApi;
  /** The OPFS-backed store, opened only when a document is kept ('Keep on this device'). */
  persistent?: () => Promise<StorageApi>;
  /**
   * The engines (B1 M1, TD-66): one at a time. An ingest holds one embedder lease across its batches; a question leases the embedder for the
   * question and then the generator for the answer, and each lease ends (the engine is unloaded) before the next begins. The special tokens
   * for the prompt sanitiser come with the generator lease (the tokenizer that was just loaded).
   */
  models: ModelPool;
  analysis: AnalysisPort;
  extract: (bytes: Uint8Array, pages: number[]) => Promise<ExtractResult>;
  now?: () => number;
}

/**
 * A passage that is not searched. held_low_score: the glyph gate held it (ppm and threshold say how far below). not_analysed: the embedder or
 * the store refused this one passage (BUG-T2-S5-10), so it was set aside and the rest of the document went on; ppm and threshold are null.
 */
export interface HeldChunk {
  ordinal: number;
  pages: string;
  reason: 'held_low_score' | 'not_analysed';
  ppm: number | null;
  threshold: number | null;
  message: string;
}

export const NOT_EMBEDDED_MESSAGE = 'This passage could not be embedded, so it is not searched.';
export const NOT_STORED_MESSAGE = 'This passage could not be stored, so it is not searched.';

/** The storage API's per-chunk refusals (details.reason, with details.row = the chunk's position in the call). */
const CHUNK_REASONS = new Set(['text', 'vector', 'gate', 'page', 'ordinal', 'reserved_key']);

/** The row a storage refusal blames, or undefined when it is not a refusal of one chunk. */
function rejectedRow(e: unknown): number | undefined {
  if (!(e instanceof StorageError || (e instanceof Error && e.name === 'StorageError')))
    return undefined;
  const { code, details } = e as StorageError;
  if (code !== 'invalid_value' || details === undefined) return undefined;
  const { reason, row } = details;
  return typeof reason === 'string' && CHUNK_REASONS.has(reason) && Number.isInteger(row)
    ? (row as number)
    : undefined;
}

const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

export interface OpenedDocument {
  docId: string;
  ns: string;
  pages: number;
  chunks: number;
  held: number;
  heldChunks: HeldChunk[];
  skippedPages: { page: number; reason: PipelineReason }[];
  kept: boolean;
  truncated: boolean;
}

export interface Answer {
  text: string;
  sources: SourceRow[];
  cited: CitedSource[];
  unknownCitations: number;
  firstTokenMs: number | null;
  totalMs: number;
  outTokens: number | null;
  tokensPerSecond: number | null;
  finishReason: GenerateResult['finishReason'];
  budget: number;
}

export interface AskOptions {
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export interface KeptDocument {
  docId: string;
  ns: string;
  pages: number;
  chunks: number;
}

export interface Pipeline {
  open(file: Blob, opts: { keep: boolean }): Promise<OpenedDocument>;
  /** Documents the user chose to keep on this device (the 'dockit.kept' list of the persistent store). */
  listKept(): Promise<KeptDocument[]>;
  /** Makes a kept document current without reading any PDF. */
  adopt(docId: string): Promise<OpenedDocument>;
  ask(question: string, opts: AskOptions): Promise<Answer>;
  remove(docId: string): Promise<void>;
  current(): OpenedDocument | undefined;
}

/**
 * An AdapterError from ANY copy of the runtime: the page holds the runtime's own AdapterError class, not the one vendored in src/contracts, so
 * `instanceof` alone misses it. Recognised by name and a string code (BUG-T1-S5-R2-02: an abort was shown as a failure because the class differed).
 */
export function isAdapterError(e: unknown, code?: AdapterErrorCode): e is AdapterError {
  if (!(e instanceof AdapterError || (e instanceof Error && e.name === 'AdapterError')))
    return false;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' && (code === undefined || c === code);
}

/** What dockit does with an adapter error: a documented refusal, the user's own Stop, or a plain failure that is not a refusal. */
export type AdapterOutcome =
  { kind: 'refusal'; reason: PipelineReason } | { kind: 'stopped' } | { kind: 'failed' };

/**
 * Every AdapterErrorCode and its intended outcome, in one place. A Record over the contract's union: a new code does not compile until it is
 * placed here, and test/pipeline/adapter-outcomes.test.ts pins each entry. Nothing falls through to an unrelated reason such as 'corrupt'.
 * - not_loaded is NOT model_not_cached: the adapter was ended (a Stop, a crash), which says nothing about the files. The controller re-loads once
 *   before this can reach the user; model_not_cached is shown only when that load says a file is really missing (not_cached below, or no stored
 *   manifest).
 * - aborted is the user's own Stop: neither a refusal nor an error.
 * - out_of_memory is its own plain refusal (B1, backend adapter R18): the engine could not allocate, its worker was ended and nothing is retried.
 */
export const ADAPTER_OUTCOMES: Readonly<Record<AdapterErrorCode, AdapterOutcome>> = Object.freeze({
  not_loaded: { kind: 'failed' },
  unsupported_profile: { kind: 'refusal', reason: 'unsupported_profile' },
  unsupported_operation: { kind: 'failed' },
  aborted: { kind: 'stopped' },
  backend: { kind: 'failed' },
  unavailable: { kind: 'refusal', reason: 'unsupported_profile' },
  bad_descriptor: { kind: 'failed' },
  egress_refused: { kind: 'failed' },
  integrity: { kind: 'refusal', reason: 'integrity' },
  context_overflow: { kind: 'refusal', reason: 'context_overflow' },
  not_cached: { kind: 'refusal', reason: 'model_not_cached' },
  out_of_memory: { kind: 'refusal', reason: 'out_of_memory' },
});

/** The outcome of an adapter error, or undefined when `e` is not one (or carries a code this build does not know). */
export function adapterOutcome(e: unknown): AdapterOutcome | undefined {
  if (!isAdapterError(e)) return undefined;
  return Object.hasOwn(ADAPTER_OUTCOMES, e.code) ? ADAPTER_OUTCOMES[e.code] : undefined;
}

/** AdapterError codes with a documented plain-language reason become a Refusal; anything else is rethrown untouched. */
export function mapAdapterError(e: unknown): unknown {
  const o = adapterOutcome(e);
  return o?.kind === 'refusal' ? new Refusal(o.reason) : e;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const now = deps.now ?? (() => performance.now());
  const { events } = deps;
  const memory = deps.store;
  memory.redactNamespacePrefix(NS_PREFIX);
  let persistentOnce: Promise<StorageApi> | undefined;
  const persistentStore = (): Promise<StorageApi> => {
    if (deps.persistent === undefined) return Promise.reject(new Refusal('no_index'));
    persistentOnce ??= deps.persistent().then((s) => {
      s.redactNamespacePrefix(NS_PREFIX);
      return s;
    });
    return persistentOnce;
  };
  /** Where each opened document lives. */
  const homes = new Map<string, StorageApi>();
  let current: OpenedDocument | undefined;

  type Counts = Partial<{ pages: number; chunks: number; held: number; bytes: number }>;
  function emitStage(
    stage: PipelineStage,
    outcome: 'ok' | 'refused' | 'error' | 'skipped',
    reason: PipelineReason | '',
    ms: number,
    c: Counts = {},
  ): void {
    events.emit(
      newEvent({
        source: EVENT_SOURCE,
        kind: 'timing',
        name: 'pipeline.stage',
        level: outcome === 'ok' ? 'debug' : 'warn',
        durationMs: ms,
        ...(c.bytes === undefined ? {} : { bytes: c.bytes }),
        attrs: {
          stage,
          outcome,
          reason,
          pages: c.pages ?? 0,
          chunks: c.chunks ?? 0,
          held: c.held ?? 0,
        },
      }),
    );
  }

  /** Runs one stage with timing and one pipeline.stage event; a refusal is recorded as such and rethrown. */
  async function stage<T>(
    name: PipelineStage,
    fn: () => Promise<T>,
    counts: (r: T) => Counts,
    asCorrupt = false,
  ): Promise<T> {
    const t0 = now();
    try {
      const r = await fn();
      emitStage(name, 'ok', '', now() - t0, counts(r));
      return r;
    } catch (raw) {
      let e = mapAdapterError(raw);
      if (asCorrupt && !isRefusal(e)) e = new Refusal('corrupt');
      if (isRefusal(e)) emitStage(name, 'refused', e.reason, now() - t0);
      else emitStage(name, 'error', '', now() - t0);
      throw e;
    }
  }

  /**
   * Embeds in batches. A batch the embedder refuses is retried one text at a time, so that one bad passage costs only itself: its entry is null
   * and the caller holds it. A failure that is not about one text (a refusal such as integrity or an unsupported profile, an abort) stops
   * everything, and when no text at all could be embedded the first error is rethrown rather than returning an empty index.
   */
  async function embedAll(
    embedder: Pick<BackendAdapter, 'embed'>,
    texts: string[],
  ): Promise<(Float32Array | null)[]> {
    const out: (Float32Array | null)[] = [];
    let first: unknown;
    const one = async (batch: string[]): Promise<Float32Array[]> => {
      const r = await embedder.embed(batch);
      if (r.vectors.length !== batch.length) throw new Error('embed: one vector per text expected');
      return r.vectors;
    };
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      try {
        out.push(...(await one(batch)));
      } catch (raw) {
        if (isAbort(raw) || isRefusal(mapAdapterError(raw))) throw mapAdapterError(raw);
        first ??= raw;
        for (const t of batch) {
          try {
            out.push(...(await one([t])));
          } catch (raw2) {
            if (isAbort(raw2) || isRefusal(mapAdapterError(raw2))) throw mapAdapterError(raw2);
            out.push(null);
          }
        }
      }
    }
    if (texts.length > 0 && out.every((v) => v === null)) throw first;
    return out;
  }

  /**
   * One all-or-nothing commit. When the store refuses a single chunk (invalid_value, details.row) that chunk is dropped and the commit is retried
   * without it; nothing was written by the refused call. A refusal that names no chunk, or names a systemic reason, is rethrown, and so is the
   * refusal of the last chunk left (an index of zero passages is not a result).
   */
  async function putHolding(
    home: StorageApi,
    ns: string,
    doc: Parameters<StorageApi['putDocument']>[1],
    items: { chunk: GatedChunk; vector: Float32Array }[],
  ): Promise<{ stored: typeof items; dropped: typeof items }> {
    let rest = items;
    const dropped: typeof items = [];
    for (;;) {
      const rows: ChunkInput[] = rest.map(({ chunk: c, vector }) => ({
        ordinal: c.ordinal,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        text: c.text,
        vector,
        gate: c.gate,
      }));
      try {
        await home.putDocument(ns, doc, rows);
        return { stored: rest, dropped };
      } catch (e) {
        const row = rejectedRow(e);
        if (row === undefined || row < 0 || row >= rest.length || rest.length === 1) throw e;
        dropped.push(rest[row]!);
        rest = rest.filter((_, i) => i !== row);
      }
    }
  }

  async function open(file: Blob, opts: { keep: boolean }): Promise<OpenedDocument> {
    const read = await stage(
      'read',
      () => readPdf(file),
      () => ({ bytes: file.size }),
    );
    // The bytes are read once. Their length and sha256 are recorded here; the one buffer goes to the analysis worker by transfer and comes back,
    // and the extract stage re-checks it, so what pagetriage judged is what pdf.js opens (B1 M3). The File is never read again.
    const readLength = read.bytes.byteLength;
    let held: Uint8Array | undefined = read.bytes;
    const emitAnalysisMemory = (peakWasmBytes: number | null): void =>
      events.emit(
        newEvent({
          source: EVENT_SOURCE,
          kind: 'memory',
          name: 'pipeline.memory',
          level: 'info',
          ...(peakWasmBytes === null ? {} : { bytes: peakWasmBytes }),
          attrs: {
            worker: 'analysis',
            stage: 'triage',
            measure: peakWasmBytes === null ? 'unavailable' : 'wasm-memory',
          },
        }),
      );
    const tri = await stage(
      'triage',
      async () => {
        let r: Awaited<ReturnType<AnalysisPort['triage']>>;
        try {
          r = await deps.analysis.triage(held!);
        } catch (e) {
          // a file the stream accounting refused (S1-107) still tells how much memory the worker needed to say so
          if (isRefusal(e) && e.detail !== undefined && 'peakWasmBytes' in e.detail) {
            const peak = e.detail['peakWasmBytes'];
            emitAnalysisMemory(typeof peak === 'number' ? peak : null);
          }
          throw e;
        }
        held = r.bytes;
        return { ...r, route: routePages(r.report) };
      },
      (r) => ({ pages: r.report.document.pages }),
      true,
    );
    emitAnalysisMemory(tri.peakWasmBytes);
    const pageCount = tri.report.document.pages;
    const extracted = await stage(
      'extract',
      async () => {
        if (
          held === undefined ||
          held.byteLength !== readLength ||
          (await sha256Hex(held)) !== read.sha256
        )
          throw new Refusal('corrupt'); // not the bytes that were read and judged
        const bytes = held;
        held = undefined; // dropped once handed on; nothing keeps the PDF after its text is out
        return deps.extract(bytes, tri.route.extract);
      },
      (r) => ({ pages: r.pages.length }),
      true,
    );
    const skippedPages: OpenedDocument['skippedPages'] = [
      ...tri.route.pages
        .filter((p) => p.action === 'skip')
        .map((p) => ({ page: p.page, reason: p.reason as PipelineReason })),
      ...extracted.skipped.map((s) => ({ page: s.page, reason: s.reason as PipelineReason })),
    ].sort((a, b) => a.page - b.page);
    if (extracted.pages.length === 0) {
      emitStage('extract', 'refused', 'no_text_layer', 0);
      throw new Refusal('no_text_layer', undefined, { pages: skippedPages });
    }

    const chunks: Chunk[] = await stage(
      'chunk',
      async () => chunkPages(extracted.pages),
      (c) => ({ chunks: c.length }),
    );
    const gated = await stage(
      'gate',
      async () => gateChunks(chunks, await deps.analysis.gate(chunks.map((c) => c.text))),
      (g) => ({ chunks: g.kept.length, held: g.held }),
    );
    const heldChunks: HeldChunk[] = gated.verdicts
      .filter((v): v is GateVerdict & { ordinal: number; verdict: 'hold' } => v.verdict === 'hold')
      .map((v) => {
        const c = chunks.find((x) => x.ordinal === v.ordinal)!;
        return {
          ordinal: v.ordinal,
          pages: c.pageStart === c.pageEnd ? String(c.pageStart) : `${c.pageStart} to ${c.pageEnd}`,
          reason: v.reason,
          ppm: v.ppm,
          threshold: v.threshold,
          message: v.message,
        };
      });

    const vectors = await stage(
      'embed',
      () =>
        deps.models.useEmbedder((embedder) =>
          embedAll(
            embedder,
            gated.kept.map((c) => `passage: ${c.text}`),
          ),
        ),
      (v) => ({ chunks: v.filter((x) => x !== null).length }),
    );
    // a passage the embedder refused on its own is set aside (not indexed) and reported; the document goes on
    const embedded: { chunk: GatedChunk; vector: Float32Array }[] = [];
    const setAside: HeldChunk[] = [];
    const pagesOf = (c: Chunk) =>
      c.pageStart === c.pageEnd ? String(c.pageStart) : `${c.pageStart} to ${c.pageEnd}`;
    const asideChunk = (c: Chunk, message: string): HeldChunk => ({
      ordinal: c.ordinal,
      pages: pagesOf(c),
      reason: 'not_analysed',
      ppm: null,
      threshold: null,
      message,
    });
    gated.kept.forEach((c, i) => {
      const vector = vectors[i] ?? null;
      if (vector === null) setAside.push(asideChunk(c, NOT_EMBEDDED_MESSAGE));
      else embedded.push({ chunk: c, vector });
    });
    const ns = `${NS_PREFIX}${read.docId}`;
    const home = opts.keep && deps.persistent !== undefined ? await persistentStore() : memory;
    homes.set(read.docId, home);
    const stored = await stage(
      'index',
      async () => {
        const r = await putHolding(
          home,
          ns,
          {
            docId: read.docId,
            title: DOC_TITLE,
            sha256: read.sha256,
            bytes: readLength,
            pages: pageCount,
          },
          embedded,
        );
        for (const d of r.dropped) setAside.push(asideChunk(d.chunk, NOT_STORED_MESSAGE));
        if (opts.keep && deps.persistent !== undefined) await home.set(KEPT_NS, read.docId, { ns });
        return r.stored;
      },
      (r) => ({ pages: pageCount, chunks: r.length, held: gated.held + setAside.length }),
    );
    heldChunks.push(...setAside);
    heldChunks.sort((a, b) => a.ordinal - b.ordinal);

    current = {
      docId: read.docId,
      ns,
      pages: pageCount,
      chunks: stored.length,
      held: gated.held + setAside.length,
      heldChunks,
      skippedPages,
      kept: opts.keep && deps.persistent !== undefined,
      truncated: extracted.truncated,
    };
    return current;
  }

  async function ask(question: string, opts: AskOptions): Promise<Answer> {
    const t0 = now();
    const answerEvent = (
      outcome: 'ok' | 'refused' | 'error' | 'aborted',
      reason: PipelineReason | '',
      extra: {
        k?: number;
        sources?: number;
        budget?: number;
        firstTokenMs?: number | null;
        unknownCitations?: number;
      },
    ) =>
      events.emit(
        newEvent({
          source: EVENT_SOURCE,
          kind: 'timing',
          name: 'pipeline.answer',
          level: outcome === 'ok' || outcome === 'aborted' ? 'info' : 'warn',
          durationMs: now() - t0,
          attrs: {
            outcome,
            reason,
            k: extra.k ?? TOP_K,
            sources: extra.sources ?? 0,
            budget: extra.budget ?? MAX_TOKENS,
            firstTokenMs: extra.firstTokenMs ?? null,
            unknownCitations: extra.unknownCitations ?? 0,
          },
        }),
      );
    const doc = current;
    if (doc === undefined || doc.chunks === 0) {
      emitStage('retrieve', 'refused', 'no_index', 0);
      answerEvent('refused', 'no_index', {});
      throw new Refusal('no_index');
    }
    try {
      const hits = await stage(
        'retrieve',
        async () => {
          const { vectors } = await deps.models.useEmbedder((embedder) =>
            embedder.embed([`query: ${question}`]),
          );
          return (homes.get(doc.docId) ?? memory).queryChunks(doc.ns, vectors[0]!, TOP_K, {
            docId: doc.docId,
          });
        },
        (h) => ({ chunks: h.length }),
      );
      let sources: RetrievedSource[] = hits.map((h, i) => ({
        id: `S${i + 1}`,
        docId: h.docId,
        ordinal: h.ordinal,
        pageStart: h.pageStart,
        pageEnd: h.pageEnd,
        text: h.text,
      }));
      const g0 = now();
      const result = await deps.models
        .useGenerator(async (generator, ctx) => {
          for (let attempt = 0; ; attempt++) {
            const { messages } = buildPrompt({
              question,
              sources: sources.map((s) => ({ id: s.id, page: s.pageStart, text: s.text })),
              specialTokens: ctx.specialTokens,
            });
            try {
              return await generator.generate(messages, {
                maxTokens: MAX_TOKENS,
                temperature: 0,
                ...(opts.signal === undefined ? {} : { signal: opts.signal }),
                ...(opts.onToken === undefined ? {} : { onToken: opts.onToken }),
              });
            } catch (e) {
              const overflow = isAdapterError(e, 'context_overflow');
              if (!overflow) throw e;
              if (attempt >= CONTEXT_RETRIES || sources.length <= 1)
                throw new Refusal('context_overflow');
              sources = sources.slice(0, -1); // drop the lowest-ranked source and retry
            }
          }
        })
        .then(
          (r) => {
            emitStage('generate', 'ok', '', now() - g0, { chunks: sources.length });
            return r;
          },
          (e) => {
            const m = mapAdapterError(e);
            if (isRefusal(m)) emitStage('generate', 'refused', m.reason, now() - g0);
            else if (isAdapterError(m, 'aborted')) emitStage('generate', 'skipped', '', now() - g0);
            else emitStage('generate', 'error', '', now() - g0);
            throw m;
          },
        );
      const { cited, unknownCitations } = parseCitations(result.text, sources);
      const answer: Answer = {
        text: result.text,
        sources: buildSourcesPanel(sources, new Set(cited.map((c) => c.id))),
        cited,
        unknownCitations,
        firstTokenMs: result.timings?.firstTokenMs ?? null,
        totalMs: now() - t0,
        outTokens: result.usage?.completionTokens ?? null,
        tokensPerSecond: result.timings?.tokensPerSecond ?? null,
        finishReason: result.finishReason,
        budget: result.budget ?? MAX_TOKENS,
      };
      // S1-119: a Stop after the first token is the user's choice (event 0.1.5 outcome 'aborted'), not a completed answer
      answerEvent(result.finishReason === 'abort' ? 'aborted' : 'ok', '', {
        sources: sources.length,
        budget: answer.budget,
        firstTokenMs: answer.firstTokenMs,
        unknownCitations,
      });
      return answer;
    } catch (e) {
      if (isRefusal(e)) answerEvent('refused', e.reason, {});
      else if (isAdapterError(e, 'aborted'))
        answerEvent('aborted', '', {}); // BUG-T1-S6-03: the user's own Stop before the first token: 'aborted' (in PIPELINE_ANSWER_OUTCOMES), never 'skipped'; no firstTokenMs
      else answerEvent('error', '', {});
      throw e;
    }
  }

  async function remove(docId: string): Promise<void> {
    const ns = `${NS_PREFIX}${docId}`;
    // A document opened in this page lives where it was put; one that was never opened here can only be a kept one.
    const home =
      homes.get(docId) ?? (deps.persistent !== undefined ? await persistentStore() : memory);
    await home.clear(ns); // physically removes every file or record of the document namespace (S-REST-1)
    await home.delete(KEPT_NS, docId);
    homes.delete(docId);
    if (current?.docId === docId) current = undefined;
  }

  async function listKept(): Promise<KeptDocument[]> {
    if (deps.persistent === undefined) return [];
    const home = await persistentStore();
    const out: KeptDocument[] = [];
    for (const docId of (await home.list(KEPT_NS)).keys) {
      const ns = `${NS_PREFIX}${docId}`;
      const info = await home.getDocument(ns, docId);
      if (info !== undefined) out.push({ docId, ns, pages: info.pages, chunks: info.chunks });
    }
    return out;
  }

  async function adopt(docId: string): Promise<OpenedDocument> {
    if (deps.persistent === undefined) throw new Refusal('no_index');
    const home = await persistentStore();
    const ns = `${NS_PREFIX}${docId}`;
    const info = await home.getDocument(ns, docId);
    if (info === undefined) throw new Refusal('no_index');
    homes.set(docId, home);
    current = {
      docId,
      ns,
      pages: info.pages,
      chunks: info.chunks,
      held: 0,
      heldChunks: [],
      skippedPages: [],
      kept: true,
      truncated: false,
    };
    return current;
  }

  return { open, ask, remove, listKept, adopt, current: () => current };
}
