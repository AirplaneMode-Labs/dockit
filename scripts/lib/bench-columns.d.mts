export const LAPTOP_8GB: 'not measured on 8 GB';
export const E2E_COLUMNS: readonly string[];
export const Q_COLUMNS: readonly string[];
export function cell(v: unknown): string;
export function csv(cols: readonly string[], rows: readonly Record<string, unknown>[]): string;
export function pageChecks(
  q: { expectPage: number | null | undefined },
  a: { ok: boolean; sources: { id: string; pages: string; cited: boolean }[] },
): { correct_source_page: boolean | ''; top_retrieved_page_ok: boolean | '' };
