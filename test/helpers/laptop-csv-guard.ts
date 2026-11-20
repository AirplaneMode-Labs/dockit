import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Tests that spawn scripts/bench-e2e.mjs must never leave the committed laptop CSVs changed: the script writes its CSVs in a `finally`, so a version of it
 * that got further than the test expects would overwrite docs/benchmarks/e2e.csv with a partial run (this happened once, in the red run of Sprint 7's
 * B6 tests, against the old script; the Q1 figures were restored from their scratch copy). Call this at the top of such a test file: it records both files
 * and, after the file's tests, restores them and fails if either differed.
 */
export function guardLaptopCsvs(): void {
  const files = ['e2e.csv', 'e2e-questions.csv'].map((f) =>
    join(import.meta.dirname, '..', '..', 'docs', 'benchmarks', f),
  );
  const before = files.map((f) => readFileSync(f));
  afterAll(() => {
    const changed: string[] = [];
    files.forEach((f, i) => {
      if (!readFileSync(f).equals(before[i]!)) {
        writeFileSync(f, before[i]!);
        changed.push(f);
      }
    });
    if (changed.length > 0)
      throw new Error(`a spawned bench-e2e.mjs overwrote ${changed.join(', ')} (restored)`);
  });
}
