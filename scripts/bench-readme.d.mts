export function parseCsv(text: string): Record<string, string>[];
/** The README block: the before and after comparison (when a baseline pair is given or found), then the per-CSV table. `null` leaves the comparison out. */
export function table(
  e2eText?: string,
  questionsText?: string,
  baseline?: [string, string] | null,
): string;
/** The before and after table of the memory hardening and the computed outcome of the TD-66 target, from the two CSV pairs' text. */
export function memoryComparison(
  baseE2e: string,
  baseQuestions: string,
  afterE2e: string,
  afterQuestions: string,
): string;
export const TARGET: Readonly<{
  rssMedianMiB: number;
  totalMedianMs: number;
  questionAllMin: number;
  questionFirstRunMin: number;
}>;
export function apply(readme: string, block: string): string;
/** The README subsection for the emulated Windows run, from the emulated runs CSV text; '' when there is no text or no row. */
/** The README subsection for the emulated Windows run; the questions CSV text (optional) gives each leg's question set. */
export function emulatedBlock(text: string | undefined, questionsText?: string): string;
/** Puts the emulated block after the benchmark block, or removes it when the block is empty. */
export function applyEmulated(readme: string, block: string): string;
