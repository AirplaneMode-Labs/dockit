// A crashed or out-of-memory benchmark run must fail within seconds with a RECORDED REASON, not sit in ask()'s 10 minute timeout (B6, TD-113).
//
// createGuard() watches one browser session and turns each way the run can die into a rejection that races with every long wait of the harness
// (waitReady, downloadModel, openPdf, ask): `await guard.race(promise)` settles with the promise, or rejects with a BenchFailure the moment the guard trips.
//
//   renderer_crash        the page crashed (Playwright page 'crash', or a CDP target of type page that crashed)
//   browser_disconnected  the browser closed or the debugging socket went away (context 'close', CDP socket closed)
//   worker_crash          a worker, service worker or shared worker target crashed (CDP Target.targetCrashed)
//   out_of_memory         the app itself reported out_of_memory (an event or a refusal reason), found by polling every `pollMs` (at most 2 s: within 5 s)
//
// The first failure wins. A worker crash is held for a short grace period so that the crash of the renderer that owns the worker (which may be reported
// first) is recorded as what it is. Nothing here changes a measurement: the guard only listens, and the poll is one cheap in-page string search.
import { FAILURE_REASONS } from './bench-columns.mjs';

export { FAILURE_REASONS };

export class BenchFailure extends Error {
  constructor(reason, detail = '') {
    if (!FAILURE_REASONS.includes(reason)) throw new Error(`unknown failure reason ${reason}`);
    super(`${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'BenchFailure';
    this.reason = reason;
  }
}

const WORKER_TYPES = new Set(['worker', 'service_worker', 'shared_worker']);

/**
 * @param {object} o
 * @param {{on: Function, off?: Function, removeListener?: Function}} [o.page]  Playwright page ('crash')
 * @param {{on: Function, off?: Function, removeListener?: Function}} [o.context]  Playwright browser context ('close')
 * @param {{onFailure: (cb: (f: {kind: string, targetType?: string}) => void) => () => void}} [o.cdp]  scripts/lib/cdp-counter.mjs connection
 * @param {() => Promise<boolean>} [o.pollOutOfMemory]  resolves true once the app has reported out_of_memory
 * @param {number} [o.pollMs]  poll interval, default 1000
 * @param {number} [o.workerGraceMs]  how long a worker crash waits for a renderer or browser failure to supersede it, default 250
 */
export function createGuard({
  page,
  context,
  cdp,
  pollOutOfMemory,
  pollMs = 1000,
  workerGraceMs = 250,
} = {}) {
  let failure = null;
  let reject = () => undefined;
  const tripped = new Promise((_resolve, rej) => {
    reject = rej;
  });
  tripped.catch(() => undefined); // a failure with nobody racing is not an unhandled rejection
  let workerTimer;
  let pollTimer;
  let stopped = false;

  const commit = (reason, detail) => {
    if (failure) return failure;
    clearTimeout(workerTimer);
    failure = new BenchFailure(reason, detail);
    reject(failure);
    return failure;
  };
  const trip = (reason, detail) => {
    if (reason === 'worker_crash' && !failure) {
      if (workerTimer === undefined)
        workerTimer = setTimeout(() => commit('worker_crash', detail), workerGraceMs);
      return failure;
    }
    return commit(reason, detail);
  };

  const cleanups = [];
  const listen = (emitter, event, fn) => {
    if (typeof emitter?.on !== 'function') return;
    emitter.on(event, fn);
    cleanups.push(() => (emitter.off ?? emitter.removeListener)?.call(emitter, event, fn));
  };
  listen(page, 'crash', () => trip('renderer_crash', 'the page crashed'));
  listen(context, 'close', () => trip('browser_disconnected', 'the browser closed'));
  if (typeof cdp?.onFailure === 'function') {
    const off = cdp.onFailure((f) => {
      if (f.kind === 'closed') trip('browser_disconnected', 'the debugging connection closed');
      else if (f.kind === 'target_crashed')
        WORKER_TYPES.has(f.targetType)
          ? trip('worker_crash', `a ${f.targetType} crashed`)
          : trip('renderer_crash', `a ${f.targetType ?? 'target'} crashed`);
    });
    if (typeof off === 'function') cleanups.push(off);
  }
  if (typeof pollOutOfMemory === 'function') {
    const loop = async () => {
      if (stopped || failure) return;
      try {
        if (await pollOutOfMemory()) {
          trip('out_of_memory', 'the app reported out_of_memory');
          return;
        }
      } catch {
        // the page is gone or busy: that is not a verdict, and the crash listeners say what happened
      }
      if (!stopped && !failure) pollTimer = setTimeout(loop, pollMs);
    };
    pollTimer = setTimeout(loop, pollMs);
  }

  return {
    pollMs,
    get failure() {
      return failure;
    },
    /** Settles with `promise`, or rejects with the BenchFailure as soon as the guard has tripped. */
    race: (promise) => Promise.race([promise, tripped]),
    /** The app refused with this reason: out_of_memory is a failure of the run, any other refusal is data and is returned to the caller as before. */
    checkRefusal(reason) {
      if (reason === 'out_of_memory')
        throw trip('out_of_memory', 'the app refused with out_of_memory');
    },
    trip,
    dispose() {
      stopped = true;
      clearTimeout(pollTimer);
      clearTimeout(workerTimer);
      for (const c of cleanups.splice(0)) c();
    },
  };
}
