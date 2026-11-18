import type { AnalysisPort } from '../pipeline/pipeline.ts';
import { PDF_TIMEOUT_MS } from '../pipeline/limits.ts';
import { Refusal } from '../pipeline/reasons.ts';
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

const isResponse = (m: unknown): m is AnalysisResponse => {
  const r = m as {
    v?: unknown;
    id?: unknown;
    type?: unknown;
    report?: unknown;
    results?: unknown;
    peakWasmBytes?: unknown;
    code?: unknown;
  } | null;
  if (r === null || typeof r !== 'object' || r.v !== 1 || typeof r.id !== 'number') return false;
  if (r.type === 'triage')
    return (
      typeof r.report === 'object' &&
      r.report !== null &&
      (r.peakWasmBytes === null || typeof r.peakWasmBytes === 'number')
    );
  if (r.type === 'gate') return Array.isArray(r.results) && r.results.every(isWorkerGate);
  if (r.type === 'error') return r.code === 'corrupt';
  return false;
};

/**
 * The main-thread side of the analysis worker. One long-lived worker; after a timeout, an 'error' or a 'messageerror'
 * it is terminated and the next call starts a fresh one, so the page stays usable. The worker is untrusted: a response
 * that is not exactly the documented shape is corrupt.
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
        cleanup();
        if (!isResponse(m)) return reject(new Refusal('corrupt'));
        if (m.type === 'error') return reject(new Refusal(m.code));
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
      // the buffer is transferred to the worker: callers pass a copy
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const r = await call(
        (id) => ({ v: 1, id, type: 'triage', bytes: buffer }),
        (q) => [(q as { bytes: ArrayBuffer }).bytes],
        'triage',
      );
      return { report: r.report as StructureReport, peakWasmBytes: r.peakWasmBytes };
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
