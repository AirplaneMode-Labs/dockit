import type {
  BackendAdapter,
  ChatMessage,
  EmbedResult,
  GenerateResult,
} from '../../src/contracts/backend-adapter.ts';
import type {
  ChunkHit,
  ChunkInput,
  DocumentInfo,
  DocumentInput,
  PutDocumentResult,
  StorageApi,
} from '../../src/contracts/storage-api.ts';
import type { Event, EventSink } from '../../src/contracts/event.ts';
import { StorageError } from '../../src/contracts/storage-api.ts';

export class RecordingSink implements EventSink {
  events: Event[] = [];
  emit(e: Event): void {
    this.events.push(e);
  }
  named(name: string): Event[] {
    return this.events.filter((e) => e.name === name);
  }
}

/** A hashing bag-of-words embedder: texts that share words get similar unit vectors. Deterministic. */
export function hashVector(text: string, dims = 32): Float32Array {
  const v = new Float32Array(dims);
  for (const w of text
    .toLowerCase()
    .replace(/^(passage|query): /u, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)) {
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
    v[h % dims]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export class FakeEmbedder {
  calls: string[][] = [];
  /** A text this predicate accepts is refused with a TypeError (as the adapter does for a text outside 1..8192 units). */
  reject: (text: string) => boolean = () => false;
  /** Set to make every call fail with this error (a systemic failure). */
  failWith: Error | undefined;
  async embed(texts: string[]): Promise<EmbedResult> {
    this.calls.push([...texts]);
    if (this.failWith !== undefined) throw this.failWith;
    // backend adapter R14: a string that is not well-formed is a TypeError before any work
    for (const t of texts) {
      if (!t.isWellFormed()) throw new TypeError('embed: a text is not well-formed');
      if (this.reject(t)) throw new TypeError('embed: a text was refused');
    }
    return { vectors: texts.map((t) => hashVector(t)), dims: 32, normalized: true };
  }
}

export class FakeGenerator {
  prompts: ChatMessage[][] = [];
  constructor(
    public respond: (messages: ChatMessage[], attempt: number) => string | Error = () =>
      'The grace period is 45 days [S1].',
  ) {}
  async generate(
    prompt: string | ChatMessage[],
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<GenerateResult> {
    const messages = prompt as ChatMessage[];
    this.prompts.push(messages);
    const r = this.respond(messages, this.prompts.length);
    if (r instanceof Error) throw r;
    this.lastOpts = opts;
    return {
      text: r,
      finishReason: this.finishReason,
      budget: opts?.maxTokens ?? 256,
      usage: { promptTokens: 100, completionTokens: 12 },
      timings: { firstTokenMs: 5, totalMs: 20 } as never,
    };
  }
  lastOpts: { maxTokens?: number; temperature?: number } | undefined;
  /** What generate() reports: 'abort' is a Stop after the first token (the worker host ended the engine, R8). */
  finishReason: GenerateResult['finishReason'] = 'stop';
}

/** Brute-force cosine, ordering per the 0.3.0 contract: score desc, docId asc, ordinal asc. Only the documents API is implemented. */
export class FakeStore {
  docs = new Map<string, Map<string, { info: DocumentInfo; chunks: ChunkInput[] }>>();
  kv = new Map<string, Map<string, unknown>>();
  redacted: string[] = [];
  cleared: string[] = [];
  readonly driver = 'memory' as const;
  failAtChunk: number | undefined;
  /** The chunk with this ordinal is refused the way the SDK refuses one: invalid_value, details { reason, row } (all-or-nothing, nothing is stored). */
  rejectOrdinal: number | undefined;

  redactNamespacePrefix(p: string) {
    this.redacted.push(p);
  }
  async putDocument(
    ns: string,
    doc: DocumentInput,
    chunks: Iterable<ChunkInput> | AsyncIterable<ChunkInput>,
  ): Promise<PutDocumentResult> {
    const list: ChunkInput[] = [];
    let i = 0;
    for await (const c of chunks as AsyncIterable<ChunkInput>) {
      if (this.failAtChunk === i) throw new Error('injected failure');
      // storage API 0.3.0: a text that is not well-formed is invalid_value (details.reason 'text', details.row)
      if (!c.text.isWellFormed() || this.rejectOrdinal === c.ordinal)
        throw new StorageError('invalid_value', `chunk ${i}: text`, { reason: 'text', row: i });
      i++;
      list.push(c);
    }
    const bucket = this.docs.get(ns) ?? new Map();
    const replaced = bucket.has(doc.docId);
    bucket.set(doc.docId, {
      info: { ...doc, chunks: list.length, dim: list[0]?.vector.length ?? 0, createdAt: 1 },
      chunks: list,
    });
    this.docs.set(ns, bucket);
    return {
      docId: doc.docId,
      chunks: list.length,
      replaced,
      rows: [...bucket.values()].reduce((n, d) => n + d.chunks.length, 0),
    };
  }
  async getDocument(ns: string, docId: string) {
    return this.docs.get(ns)?.get(docId)?.info;
  }
  async listDocuments(ns: string) {
    return [...(this.docs.get(ns)?.values() ?? [])].map((d) => d.info);
  }
  async deleteDocument(ns: string, docId: string) {
    return this.docs.get(ns)?.delete(docId) ?? false;
  }
  async queryChunks(
    ns: string,
    vector: Float32Array,
    k: number,
    opts?: { docId?: string },
  ): Promise<ChunkHit[]> {
    const hits: ChunkHit[] = [];
    for (const [docId, d] of this.docs.get(ns) ?? []) {
      if (opts?.docId !== undefined && opts.docId !== docId) continue;
      for (const c of d.chunks) {
        let dot = 0;
        for (let j = 0; j < vector.length; j++) dot += vector[j]! * c.vector[j]!;
        hits.push({
          docId,
          title: d.info.title,
          ordinal: c.ordinal,
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
          text: c.text,
          score: dot,
        });
      }
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) ||
        a.ordinal - b.ordinal,
    );
    return hits.slice(0, k);
  }
  async set(ns: string, key: string, value: unknown) {
    const b = this.kv.get(ns) ?? new Map();
    b.set(key, value);
    this.kv.set(ns, b);
  }
  async get(ns: string, key: string) {
    return this.kv.get(ns)?.get(key);
  }
  async delete(ns: string, key: string) {
    return this.kv.get(ns)?.delete(key) ?? false;
  }
  async list(ns: string) {
    return { keys: [...(this.kv.get(ns)?.keys() ?? [])].sort() };
  }
  async clear(ns: string) {
    this.cleared.push(ns);
    this.docs.delete(ns);
    this.kv.delete(ns);
  }
  async close() {}
}

/**
 * A model pool whose engines are the fakes above. It records every lease ('embedder:start', 'embedder:end', ...) and how many leases were held at
 * once, so a test can prove the pipeline never holds two engines and fixes the order of the loads (B1 M1).
 */
export class FakeModels {
  leases: string[] = [];
  active = 0;
  maxActive = 0;
  constructor(
    readonly embedder: FakeEmbedder,
    readonly generator: FakeGenerator,
    readonly specialTokens: readonly string[] = [],
  ) {}
  private async lease<T>(kind: 'embedder' | 'generator', run: () => Promise<T>): Promise<T> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.leases.push(`${kind}:start`);
    try {
      return await run();
    } finally {
      this.leases.push(`${kind}:end`);
      this.active--;
    }
  }
  useEmbedder<T>(
    fn: (e: Pick<BackendAdapter, 'embed'>, ctx: { specialTokens: readonly string[] }) => Promise<T>,
  ): Promise<T> {
    return this.lease('embedder', () => fn(this.embedder as never, { specialTokens: [] }));
  }
  useGenerator<T>(
    fn: (
      g: Pick<BackendAdapter, 'generate'>,
      ctx: { specialTokens: readonly string[] },
    ) => Promise<T>,
  ): Promise<T> {
    return this.lease('generator', () =>
      fn(this.generator as never, { specialTokens: this.specialTokens }),
    );
  }
}

export const asStore = (s: FakeStore): StorageApi => s as unknown as StorageApi;
export const asAdapter = (a: unknown): Pick<BackendAdapter, 'embed' | 'generate'> => a as never;
