export const CAPS: Readonly<Record<string, number | null>>;
/** The job columns, and (from a version 2 summary) the six limit-evidence columns; an older summary gives empty evidence cells. */
export function summaryCells(summary: unknown): {
  job_commit_limit_bytes: number | '';
  job_commit_peak_bytes: number | '';
  job_escapes: number;
  job_limit_readback_bytes: number | '';
  job_limit_flags_readback: '' | '0x2000' | '0x2200';
  limit_probe_refused: '' | 'true' | 'false';
  job_peak_after_probe_bytes: number | '';
  job_memory_limit_messages: number | '';
  control_leg: '' | 'true' | 'false';
};
export function merge(csvText: string, summary: unknown): string;
