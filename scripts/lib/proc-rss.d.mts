export interface Proc {
  pid: number;
  ppid: number;
  rssBytes: number;
  commitBytes?: number;
  command: string;
}
export interface SampleResult {
  peakBytes: number | null;
  commitPeakBytes: number | null;
  samples: number;
  ticks: number;
  medianIntervalMs: number | null;
}
export function psCommand(): { cmd: string; args: string[] };
export function winCommand(intervalMs?: number): { cmd: string; args: string[] };
export function parsePs(text: string): Proc[];
export function parseWin(text: string): Proc[];
export function sumTreeRss(
  procs: Proc[],
  userDataDir: string,
  field?: 'rssBytes' | 'commitBytes',
): number;
export function createPeakTracker(): {
  add(v: number): void;
  peak(): number | null;
  count(): number;
};
export function createSampleTracker(): {
  add(figures: { rss: number; commit: number | null }, nowMs: number): void;
  result(): SampleResult;
};
export function startRssSampler(o: {
  userDataDir: string;
  platform?: string;
  spawn?: (cmd: string, args: string[], opts?: unknown) => any;
  now?: () => number;
}): {
  stop(): Promise<SampleResult>;
};
