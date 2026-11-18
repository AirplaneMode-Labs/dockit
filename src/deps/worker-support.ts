/**
 * The two runtime exports a worker may use, from the small worker-support entry (not the whole runtime index, so a worker bundle
 * holds no asset manager or adapters). Every worker of dockit calls installEgressGuard() as the first statement it runs.
 */
import * as ws from 'virtual:dockit-deps/runtime/worker-support.js';

export interface EgressGuardOptions {
  /** Same-origin path prefixes the worker may still fetch from; everything else is refused. Each starts and ends with '/'. */
  allowPathPrefixes: readonly string[];
}

export interface ModuleWorker {
  readonly worker: Worker;
  /** Terminates the worker and revokes its blob URL. */
  terminate(): void;
}

interface WorkerSupport {
  installEgressGuard(opts: EgressGuardOptions): void;
  /**
   * Starts a module worker through the runtime's blob bootstrap (one static import of an exact same-origin URL; anything else is
   * refused before createObjectURL). The worker inherits the page CSP.
   */
  startModuleWorker(url: string, opts: { policyName: string; name?: string }): ModuleWorker;
}

const api = ws as unknown as WorkerSupport;

export const installEgressGuard: WorkerSupport['installEgressGuard'] = (o) =>
  api.installEgressGuard(o);
export const startModuleWorker: WorkerSupport['startModuleWorker'] = (u, o) =>
  api.startModuleWorker(u, o);
