import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const ignored = (p: string) =>
  spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', p]).status;

describe('gitignore: the Windows benchmark output folder is never committed (the committed emulated CSVs are copied out of it by hand)', () => {
  it.each(['bench-out/e2e-emulated-win-vm.csv', 'bench-out/job-summary.json', 'dist-SHA256SUMS'])(
    '%s is ignored',
    (p) => {
      expect(ignored(p)).toBe(0);
    },
  );
  it('the committed emulated CSV names are not ignored', () => {
    expect(ignored('docs/benchmarks/e2e-emulated-win-vm.csv')).toBe(1);
    expect(ignored('docs/benchmarks/e2e-emulated-win-vm-questions.csv')).toBe(1);
  });
});
