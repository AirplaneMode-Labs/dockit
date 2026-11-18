import analysisWorkerUrl from './analysis-worker.ts?worker&url';
import pdfWorkerUrl from './pdf-worker.ts?worker&url';
import { startModuleWorker } from '../deps/worker-support.ts';

/** The one Trusted Types policy both of dockit's own workers are started through (CSP: trusted-types ... dockit-workers). */
export const WORKERS_POLICY = 'dockit-workers';

/** What the clients use of a started worker. terminate() is the runtime's: it terminates the worker AND revokes its blob URL. */
export interface StartedWorker {
  /** What pdf.js talks to. */
  readonly port: Worker;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: string, listener: (e: never) => void): void;
  removeEventListener(type: string, listener: (e: never) => void): void;
}

function start(url: string, name: string): StartedWorker {
  const mw = startModuleWorker(url, { policyName: WORKERS_POLICY, name });
  const w = mw.worker;
  return {
    port: w,
    postMessage: (msg, transfer) => w.postMessage(msg, transfer ?? []),
    terminate: () => mw.terminate(),
    addEventListener: (type, listener) => w.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) => w.removeEventListener(type, listener as EventListener),
  };
}

/** A FRESH pdf worker (one per document). */
export const startPdfWorker = (): StartedWorker => start(pdfWorkerUrl, 'dockit-pdf');
export const startAnalysisWorker = (): StartedWorker => start(analysisWorkerUrl, 'dockit-analysis');
