export interface Proc {
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
}
export function psCommand(): { cmd: string; args: string[] };
export function winCommand(intervalMs?: number): { cmd: string; args: string[] };
export function parsePs(text: string): Proc[];
export function parseWin(text: string): Proc[];
export function sumTreeRss(procs: Proc[], userDataDir: string): number;
export function createPeakTracker(): {
  add(v: number): void;
  peak(): number | null;
  count(): number;
};
export function startRssSampler(o: { userDataDir: string; platform?: string }): {
  stop(): Promise<{ peakBytes: number | null; samples: number }>;
};
