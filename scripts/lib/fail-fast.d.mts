export const FAILURE_REASONS: readonly [
  'renderer_crash',
  'browser_disconnected',
  'worker_crash',
  'out_of_memory',
];
export class BenchFailure extends Error {
  constructor(reason: string, detail?: string);
  reason: (typeof FAILURE_REASONS)[number];
}
export interface Guard {
  readonly pollMs: number;
  readonly failure: BenchFailure | null;
  race<T>(promise: Promise<T>): Promise<T>;
  checkRefusal(reason: string | null | undefined): void;
  trip(reason: string, detail?: string): BenchFailure | null;
  dispose(): void;
}
export function createGuard(o?: {
  page?: any;
  context?: any;
  cdp?: { onFailure(cb: (f: { kind: string; targetType?: string }) => void): () => void };
  pollOutOfMemory?: () => Promise<boolean>;
  pollMs?: number;
  workerGraceMs?: number;
}): Guard;
