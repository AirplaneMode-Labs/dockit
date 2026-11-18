// Loose declarations for the plain ESM script, so the tests can import it without inferring its whole shape.
export const DEP_NAMES: string[];
export const DOCKIT_ROOT: string;
export class AssembleError extends Error {
  exitCode: number;
  constructor(message: string, exitCode?: number);
}
export function parseLock(lock: unknown): any;
export function parseArgs(argv: string[]): { mode: string; dir: string; allowDirty: boolean };
export function depDir(mode: string, dir: string, dep: string): string;
export function buildPlan(opts?: { dockitRoot?: string }): any;
export function defaultExec(
  cwd: string,
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): void;
export function assembleDeps(opts: any): Promise<any>;
