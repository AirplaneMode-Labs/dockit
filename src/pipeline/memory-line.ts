/**
 * The minimum memory line (B1 M6, TD-67, TD-84). A web page cannot read free memory. What it can read is navigator.deviceMemory, a coarse
 * power of two that Chrome rounds and reports up to 8 (the runtime clamps it to 8 and gives 0 when the browser does not expose it). The line is
 * the answer model's signed minProfile.ramGb in the verified manifest: dockit holds no memory constant of its own, so the number the owner
 * re-decides after an 8 GB measurement changes in one place, the manifest.
 *
 * The line is a usability guard, not a security control: deviceMemory is user-controlled and can be overridden. The plain refusal that an
 * out-of-memory failure in the engine produces is the backstop. Nothing here says "free RAM".
 */

/** The most the browser reports through navigator.deviceMemory (capability profile 0.1.1: ramGb is clamped to at most 8). */
export const REPORTED_GB_MAX = 8;

export type MemoryVerdict =
  | { kind: 'meets'; reportedGb: number; requiredGb: number }
  | { kind: 'below'; reportedGb: number; requiredGb: number }
  /** ramGb 0: the browser does not report its memory. TD-84: unknown is NOT below the line; the out-of-memory refusal is the backstop. */
  | { kind: 'unknown'; requiredGb: number }
  /** The manifest holds no line (not verified yet, or no ramGb in the answer entry's minProfile): nothing to assess. */
  | { kind: 'no_line' };

/** `ramGb` is the capability profile's value (0 = unknown); `requiredGb` is the verified manifest's minProfile.ramGb of the answer model. */
export function assessMemory(ramGb: number, requiredGb: number | undefined): MemoryVerdict {
  if (typeof requiredGb !== 'number' || !Number.isFinite(requiredGb) || requiredGb <= 0)
    return { kind: 'no_line' };
  if (typeof ramGb !== 'number' || !Number.isFinite(ramGb) || ramGb <= 0)
    return { kind: 'unknown', requiredGb };
  const reportedGb = Math.min(ramGb, REPORTED_GB_MAX);
  return { kind: reportedGb >= requiredGb ? 'meets' : 'below', reportedGb, requiredGb };
}

/** The capability card's line for a device at or above the line. */
export const memoryLineText = (reportedGb: number, requiredGb: number): string =>
  `Memory line: the answer model needs a device that reports at least ${requiredGb} GB to the browser. This device reports ${reportedGb} GB (navigator.deviceMemory, rounded, at most ${REPORTED_GB_MAX}). A web page cannot read free memory.`;

/** The capability card's line for a device below the line (the load is refused with memoryRefusalMessage). */
export const memoryBelowText = (reportedGb: number, requiredGb: number): string =>
  `Memory line: the answer model needs a device that reports at least ${requiredGb} GB to the browser. This device reports ${reportedGb} GB (navigator.deviceMemory, rounded, at most ${REPORTED_GB_MAX}), so loading the model will be refused. A web page cannot read free memory.`;

/** The refusal text (unsupported_profile) when the reported value is below the line: shown before any model byte is read. */
export const memoryRefusalMessage = (reportedGb: number, requiredGb: number): string =>
  `This device reports ${reportedGb} GB of memory to the browser; the answer model needs at least ${requiredGb} GB. Nothing was loaded.`;

/** The capability card's line when the browser reports no memory figure (TD-84). */
export const MEMORY_UNKNOWN_TEXT =
  'This browser does not report its memory; the answer model may not fit.';
