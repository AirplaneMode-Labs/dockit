// Loose declarations: the harness is plain ESM shared with scripts/bench-e2e.mjs.
export const ROOT: string;
export const DIST: string;
export const PREFIX: string;
export function machineLabel(): string;
export function gitCommit(): string;
export function newProfileDir(base?: string): string;
export function startServer(o: { dist?: string; port: number; prefix?: string }): Promise<{
  server: any;
  requests: { path: string; status: number; at: number }[];
  base: string;
  close(): Promise<void>;
}>;
export function launch(
  playwright: any,
  o: { profileDir: string; headless?: boolean; watch?: boolean },
): Promise<{ ctx: any; page: any; cdp: any; ledger: any; close(): Promise<void> }>;
export function goOffline(ctx: any): Promise<void>;
export function chromeVersion(page: any): Promise<string>;
export function waitReady(page: any, base: string, o?: { timeout?: number }): Promise<void>;
export function downloadModel(
  page: any,
  o?: { timeout?: number },
): Promise<{ status: string | null; refusal: string }>;
export function openPdf(
  page: any,
  file: string,
  o?: { timeout?: number },
): Promise<{ ok: boolean; refusal: string; reason: string | null; summary: string }>;
export function ask(
  page: any,
  question: string,
  o?: { timeout?: number },
): Promise<{
  ok: boolean;
  refusal: string;
  reason: string | null;
  text: string;
  sources: { id: string; pages: string; cited: boolean }[];
  firstTokenMs: number | null;
  totalMs: number | null;
}>;
export function askThenStop(
  page: any,
  question: string,
  o?: { when?: 'streaming' | 'prefill'; afterMs?: number; timeout?: number },
): Promise<{
  stopped: boolean;
  stoppedText: string;
  partial: string;
  refusal: string;
  reason: string | null;
  modelStatus: string | null;
}>;
export function watchModelReload(page: any): Promise<void>;
export function modelReloadResult(
  page: any,
): Promise<{ sawLoading: boolean; text: string; ms: number | null; loads: number }>;
export function sampleWorkerTargets(
  cdp: any,
  o?: { intervalMs?: number },
): { stop(): Promise<{ at: number; workers: number; serviceWorkers: number }[]> };
export function readEvents(page: any): Promise<any[]>;
export function stageTimings(events: any[], sinceTs?: number): Record<string, any>;
export function wasmMemoryPeak(events: any[]): number | null;
export function sampleJsHeap(page: any, intervalMs?: number): { stop(): Promise<number | null> };
export function startRss(profileDir: string): {
  stop(): Promise<{ peakBytes: number | null; samples: number }>;
};
export function storageUsage(page: any): Promise<number | null>;
