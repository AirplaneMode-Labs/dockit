import type { AnalysisPort } from '../pipeline/pipeline.ts';
import { PDF_TIMEOUT_MS } from '../pipeline/limits.ts';
import { Refusal } from '../pipeline/reasons.ts';
import {
  STREAMS_UNCHECKED_MESSAGE,
  STREAM_LIMIT_REASONS,
  streamLimitMessage,
  type StreamLimits,
} from '../pipeline/streams.ts';
import type { StructureReport } from '../pipeline/route.ts';
import type { AnalysisRequest, AnalysisResponse } from './analysis-core.ts';

interface WorkerLike {
  postMessage(msg: AnalysisRequest, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: string, listener: (e: never) => void): void;
  removeEventListener(type: string, listener: (e: never) => void): void;
}

export interface AnalysisClient extends AnalysisPort {
  dispose(): void;
}

const isWorkerGate = (x: unknown): boolean => {
  if (x === null) return true;
  const g = x as { verdict?: unknown; ppm?: unknown; threshold?: unknown } | undefined;
  if (typeof g !== 'object' || g === undefined) return false;
  if (typeof g.threshold !== 'number' || !Number.isInteger(g.threshold)) return false;
  if (g.verdict === 'not_scored') return g.ppm === null;
  return (
    (g.verdict === 'pass' || g.verdict === 'hold') &&
    typeof g.ppm === 'number' &&
    Number.isInteger(g.ppm)
  );
};

const LIMIT_KEYS = [
  'font_decoded_max',
  'image_decoded_max',
  'image_raster_max',
  'content_decoded_max',
  'other_decoded_max',
  'total_decoded_max',
  'streams_max',
] as const;
const isLimits = (x: unknown): x is StreamLimits =>
  x !== null &&
  typeof x === 'object' &&
  LIMIT_KEYS.every((k) => {
    const v = (x as Record<string, unknown>)[k];
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  });

const isResponse = (m: unknown): m is AnalysisResponse => {
  const r = m as {
    v?: unknown;
    id?: unknown;
    type?: unknown;
    report?: unknown;
    results?: unknown;
    peakWasmBytes?: unknown;
    bytes?: unknown;
    code?: unknown;
    reason?: unknown;
    limits?: unknown;
  } | null;
  if (r === null || typeof r !== 'object' || r.v !== 1 || typeof r.id !== 'number') return false;
  if (r.type === 'triage')
    return (
      typeof r.report === 'object' &&
      r.report !== null &&
      r.bytes instanceof ArrayBuffer &&
      (r.peakWasmBytes === null || typeof r.peakWasmBytes === 'number')
    );
  if (r.type === 'gate') return Array.isArray(r.results) && r.results.every(isWorkerGate);
  const peakOk = r.peakWasmBytes === null || typeof r.peakWasmBytes === 'number';
  if (r.type === 'streams_refused')
    return STREAM_LIMIT_REASONS.some((x) => x === r.reason) && isLimits(r.limits) && peakOk;
  if (r.type === 'streams_unchecked') return peakOk;
  if (r.type === 'error') return r.code === 'corrupt';
  return false;
};

/**
 * The main-thread side of the analysis worker. A worker lives for ONE call (B1 M3): it holds two WebAssembly modules, and that memory goes back
 * to the system only when the worker ends, so it is terminated as soon as its call settles and the next call starts a fresh one. After a
 * timeout, an 'error' or a 'messageerror' it is terminated too, so the page stays usable. The worker is untrusted: a response that is not exactly
 * the documented shape is corrupt.
 */
export function createAnalysisClient(opts: {
  startWorker: () => WorkerLike;
  timeoutMs?: number;
}): AnalysisClient {
  const timeoutMs = opts.timeoutMs ?? PDF_TIMEOUT_MS;
  let worker: WorkerLike | undefined;
  let nextId = 1;

  const call = <T extends AnalysisResponse['type']>(
    build: (id: number) => AnalysisRequest,
    transfer: (r: AnalysisRequest) => Transferable[],
    want: T,
  ): Promise<Extract<AnalysisResponse, { type: T }>> =>
    new Promise((resolve, reject) => {
      const w = (worker ??= opts.startWorker());
      const id = nextId++;
      const cleanup = () => {
        clearTimeout(timer);
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onFail);
        w.removeEventListener('messageerror', onFail);
      };
      const kill = () => {
        cleanup();
        if (worker === w) worker = undefined;
        w.terminate();
      };
      const onMessage = (e: { data: unknown }) => {
        const m = e.data;
        if ((m as { id?: unknown } | null)?.id !== id) return; // not ours
        kill(); // the call is over: end the worker, whatever the answer is
        if (!isResponse(m)) return reject(new Refusal('corrupt'));
        if (m.type === 'error') return reject(new Refusal(m.code));
        // S1-107: the stream accounting refused the file before it was read further (the triage call is the one that asks it)
        if (m.type === 'streams_refused')
          return reject(
            new Refusal('stream_limit', streamLimitMessage(m.reason, m.limits), {
              limit: m.reason,
              peakWasmBytes: m.peakWasmBytes,
            }),
          );
        if (m.type === 'streams_unchecked')
          return reject(
            new Refusal('corrupt', STREAMS_UNCHECKED_MESSAGE, { peakWasmBytes: m.peakWasmBytes }),
          );
        if (m.type !== want) return reject(new Refusal('corrupt'));
        resolve(m as Extract<AnalysisResponse, { type: T }>);
      };
      const onFail = () => {
        kill();
        reject(new Refusal('corrupt'));
      };
      const timer = setTimeout(() => {
        kill();
        reject(new Refusal('timeout'));
      }, timeoutMs);
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onFail);
      w.addEventListener('messageerror', onFail);
      const req = build(id);
      w.postMessage(req, transfer(req));
    });

  return {
    async triage(bytes) {
      // the buffer itself is transferred to the worker (no copy) and comes back in the response: the caller must use the returned bytes
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      const buffer = (
        whole
          ? bytes.buffer
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      ) as ArrayBuffer;
      const r = await call(
        (id) => ({ v: 1, id, type: 'triage', bytes: buffer }),
        (q) => [(q as { bytes: ArrayBuffer }).bytes],
        'triage',
      );
      return {
        report: r.report as StructureReport,
        peakWasmBytes: r.peakWasmBytes,
        bytes: new Uint8Array(r.bytes),
      };
    },
    async gate(texts) {
      const r = await call(
        (id) => ({ v: 1, id, type: 'gate', texts }),
        () => [],
        'gate',
      );
      return r.results;
    },
    dispose() {
      worker?.terminate();
      worker = undefined;
    },
  };
}
