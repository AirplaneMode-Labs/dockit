export const CAPS: Readonly<Record<string, number | null>>;
export function summaryCells(summary: unknown): {
  job_commit_limit_bytes: number | '';
  job_commit_peak_bytes: number;
  job_escapes: number;
};
export function merge(csvText: string, summary: unknown): string;
