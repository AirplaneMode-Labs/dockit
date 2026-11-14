import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Committed scripts, sources and tests must not point at a developer scratch directory (T3-S3-027).
// The literal is assembled here so this file does not match itself.
const SCRATCH = ['/private', '/tmp'].join('');
const root = join(import.meta.dirname, '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

describe('portability (T3-S3-027)', () => {
  it('no file under scripts, src or test names the scratch directory', () => {
    const offenders = ['scripts', 'src', 'test']
      .flatMap((d) => walk(join(root, d)))
      .filter((f) => /\.(m?[jt]sx?|json|css|html|md)$/u.test(f))
      .filter((f) => readFileSync(f, 'utf8').includes(SCRATCH))
      .map((f) => f.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});
