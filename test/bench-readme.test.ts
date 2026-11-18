import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply, table } from '../scripts/bench-readme.mjs';

const root = join(import.meta.dirname, '..');

describe('README benchmark block', () => {
  it('equals what scripts/bench-readme.mjs writes from docs/benchmarks/*.csv (no figure is typed by hand)', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(apply(readme, table())).toBe(readme);
  });

  it('names the machine, the command and the commit in every row, reads not measured on 8 GB, and never says the done-when is met', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const block = readme.slice(
      readme.indexOf('<!-- bench:start -->'),
      readme.indexOf('<!-- bench:end -->'),
    );
    const rows = block
      .split('\n')
      .filter(
        (l) =>
          l.startsWith('| Apple') ||
          (l.startsWith('| ') && !l.startsWith('| Machine') && !l.startsWith('|---')),
      );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r).toContain('npm run bench:e2e');
      expect(r).toMatch(/`[0-9a-f]{12}(-dirty)?`/);
      expect(r.trimEnd().endsWith('| not measured on 8 GB |')).toBe(true);
    }
    expect(readme).toContain('8 GB Windows done-when NOT met (owner runbook step 5)');
    expect(readme.replace(/NOT met/g, '')).not.toMatch(/done-when[^.\n]*\bmet\b/);
  });

  it('the committed CSVs hold at least 5 runs and a restart run, and every run attempted 0 requests after offline', () => {
    const lines = readFileSync(join(root, 'docs', 'benchmarks', 'e2e.csv'), 'utf8')
      .trim()
      .split('\n');
    const head = lines[0]!.split(',');
    const col = (n: string) => head.indexOf(n);
    const rows = lines.slice(1).map((l) => l.split(','));
    expect(rows.filter((r) => r[col('restart')] === 'false').length).toBeGreaterThanOrEqual(5);
    expect(rows.filter((r) => r[col('restart')] === 'true').length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r[col('requests_after_offline')]).toBe('0');
      expect(r[col('machine')]).toBe('Apple M5 Pro 48 GB');
      for (const c of [
        'js_heap_peak_bytes',
        'wasm_memory_peak_bytes',
        'process_rss_peak_bytes',
        'storage_usage_bytes',
        'first_token_ms',
        'total_ms',
      ])
        expect(r[col(c)], c).not.toBe('');
    }
    const q = readFileSync(join(root, 'docs', 'benchmarks', 'e2e-questions.csv'), 'utf8')
      .trim()
      .split('\n')
      .slice(1);
    expect(q.length).toBe(rows.length * 7);
  });
});
