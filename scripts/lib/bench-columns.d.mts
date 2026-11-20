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
/** The header of the emulated runs CSV before the limit evidence existed (the first run, kept under docs/benchmarks/history/, has it). */
export const E2E_EMULATED_COLUMNS_V1: readonly string[];
/** The header the first limit-evidence dispatch wrote (V1 plus six evidence columns); the merge step accepts it as input and upgrades it. */
export const E2E_EMULATED_COLUMNS_V2: readonly string[];
/** The two headers a committed emulated runs CSV may have, as comma-joined lines: the current one and the first (V2 is only ever a dispatch's output). */
export const EMULATED_HEADERS: readonly string[];
/** The legs and the job commit limit of each in bytes (null: none). */
export const LEG_CAPS: Readonly<Record<string, number | null>>;
/** The legs that are controls: the benchmark must not complete under their limit. */
export const CONTROL_CAPS: readonly string[];
/** What the probe commits above the limit: 256 MiB. */
export const PROBE_OVER_LIMIT_BYTES: 268435456;
export const LIMIT_FLAGS_READBACK: readonly string[];
export type LimitProof = 'no_limit' | 'proven' | 'not_enforced' | 'readback_mismatch' | 'unproven';
/** What one leg's evidence cells say about its commit limit; 'proven' needs the read-back equal AND the probe refused. */
export function limitProof(row: Record<string, string | undefined>): LimitProof;
export const LIMIT_PROOF_TEXT: Readonly<Record<LimitProof, string>>;
/** The job's memory-limit messages of one leg: the whole run, the probe's own, and (the difference) those posted while the benchmark ran; null where not known. */
export function limitMessages(row: Record<string, string | undefined>): {
  total: number | null;
  probe: number | null;
  benchmark: number | null;
};
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
