import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MEMORY_UNKNOWN_TEXT,
  REPORTED_GB_MAX,
  assessMemory,
  memoryBelowText,
  memoryLineText,
  memoryRefusalMessage,
} from '../src/pipeline/memory-line.ts';

// B1 M6 (TD-67, TD-84): the memory line is a usability guard read from the verified manifest, never a UI constant. A web page cannot read
// free memory; it reads navigator.deviceMemory, which Chrome rounds to a power of two and reports up to 8, and which a user can override.
describe('memory line: assessMemory', () => {
  it('a reported value at or above the line meets it', () => {
    expect(assessMemory(8, 4)).toEqual({ kind: 'meets', reportedGb: 8, requiredGb: 4 });
    expect(assessMemory(4, 4)).toEqual({ kind: 'meets', reportedGb: 4, requiredGb: 4 });
  });

  it('a reported value below the line is below', () => {
    expect(assessMemory(2, 4)).toEqual({ kind: 'below', reportedGb: 2, requiredGb: 4 });
    expect(assessMemory(0.5, 4)).toEqual({ kind: 'below', reportedGb: 0.5, requiredGb: 4 });
  });

  it('the line comes from the manifest: a manifest that says 2 lets a device that reports 2 meet it', () => {
    expect(assessMemory(2, 2).kind).toBe('meets');
    expect(assessMemory(2, 3).kind).toBe('below');
  });

  it('an unknown value (ramGb 0: the browser does not expose navigator.deviceMemory) is NOT below the line (TD-84)', () => {
    expect(assessMemory(0, 4)).toEqual({ kind: 'unknown', requiredGb: 4 });
    expect(assessMemory(Number.NaN, 4).kind).toBe('unknown');
    expect(assessMemory(-1, 4).kind).toBe('unknown');
  });

  it('what is reported is clamped to 8 for display and for the comparison', () => {
    expect(REPORTED_GB_MAX).toBe(8);
    expect(assessMemory(32, 4)).toEqual({ kind: 'meets', reportedGb: 8, requiredGb: 4 });
  });

  it('no line in the manifest (no verified manifest yet, or no ramGb in minProfile) gives no verdict', () => {
    expect(assessMemory(8, undefined)).toEqual({ kind: 'no_line' });
    expect(assessMemory(2, 0)).toEqual({ kind: 'no_line' });
    expect(assessMemory(2, Number.NaN)).toEqual({ kind: 'no_line' });
  });
});

describe('memory line: the words', () => {
  it('the card line for a device at or above the line states the line, the reported value and that a page cannot read free memory', () => {
    expect(memoryLineText(8, 4)).toBe(
      'Memory line: the answer model needs a device that reports at least 4 GB to the browser. This device reports 8 GB (navigator.deviceMemory, rounded, at most 8). A web page cannot read free memory.',
    );
  });

  it('the refusal below the line is the documented sentence', () => {
    expect(memoryRefusalMessage(2, 4)).toBe(
      'This device reports 2 GB of memory to the browser; the answer model needs at least 4 GB. Nothing was loaded.',
    );
  });

  it('the unknown case says that the browser does not report its memory and that the model may not fit', () => {
    expect(MEMORY_UNKNOWN_TEXT).toBe(
      'This browser does not report its memory; the answer model may not fit.',
    );
  });

  it('no wording says "free RAM", and the card never claims the figure is free memory', () => {
    for (const t of [
      memoryLineText(8, 4),
      memoryBelowText(2, 4),
      memoryRefusalMessage(2, 4),
      MEMORY_UNKNOWN_TEXT,
    ]) {
      expect(t).not.toMatch(/free RAM/i);
      expect(t).not.toMatch(/\bfree memory is\b/i);
    }
    expect(memoryBelowText(2, 4)).toContain('2 GB');
    expect(memoryBelowText(2, 4)).toContain('4 GB');
  });
});

// TD-84, BUG-T1-S6-02 follow-up: runtime release 0.6.0 (fix round 1) makes satisfies() read ramGb 0 as unknown, never below a minimum, so the engine
// adapter is given the REAL capability profile and the runtime decides. dockit substitutes nothing: the profileForAdapter workaround is gone.
describe('memory line: the engine adapter gets the real profile (TD-84, no substitution)', () => {
  const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

  it('memory-line.ts no longer exports a profile substitution and adapters.ts does not use one', () => {
    expect(read('pipeline/memory-line.ts')).not.toMatch(/profileForAdapter/);
    expect(read('app/adapters.ts')).not.toMatch(/profileForAdapter/);
  });

  it('adapters.ts hands the detected profile to the adapter as it is', () => {
    const src = read('app/adapters.ts');
    expect(src).toMatch(/const profile = await rt\.detectCapabilities\(\);/);
  });
});
