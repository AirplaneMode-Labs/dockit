export const LAPTOP_8GB: 'not measured on 8 GB';
export const E2E_COLUMNS_BASE: readonly string[];
export const E2E_COLUMNS: readonly string[];
export function hostLoad(v: number): string;
export const Q_COLUMNS: readonly string[];
export function cell(v: unknown): string;
export function csv(cols: readonly string[], rows: readonly Record<string, unknown>[]): string;
export function pageChecks(
  q: { expectPage: number | null | undefined },
  a: { ok: boolean; sources: { id: string; pages: string; cited: boolean }[] },
): { correct_source_page: boolean | ''; top_retrieved_page_ok: boolean | '' };
export function hostLoadCell(v: number, platform?: string): string;
export const EMULATED_E2E_FILE: 'e2e-emulated-win-vm.csv';
export const EMULATED_Q_FILE: 'e2e-emulated-win-vm-questions.csv';
export const FAILURE_REASONS: readonly [
  'renderer_crash',
  'browser_disconnected',
  'worker_crash',
  'out_of_memory',
];
export const ENVIRONMENT_LABEL_RE: RegExp;
export function validateEnvironmentLabel(label: string): string;
export const E2E_EMULATED_COLUMNS: readonly string[];
export const Q_EMULATED_COLUMNS: readonly string[];

export const MACHINE_8GB_OR_LAPTOP_RE: RegExp;
export function runZeroRows(a: {
  date: string;
  label: string;
  commit: string;
  reason: string;
  loadStart?: string;
  loadEnd?: string;
}): { e2e: Record<string, unknown>; q: Record<string, unknown> };
