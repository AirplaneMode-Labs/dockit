import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply, parseCsv, table } from '../scripts/bench-readme.mjs';
import * as cols from '../scripts/lib/bench-columns.mjs';

// BUG-T1-S5-07: every row of both benchmark CSVs says 'not measured on 8 GB' in a column of its own (laptop_8gb), like the
// pagetriage and localdata CSVs do, so a CSV read without the README still says what the figures are not.
const root = join(import.meta.dirname, '..');
const PHRASE = 'not measured on 8 GB';
const read = (f: string) => readFileSync(join(root, 'docs', 'benchmarks', f), 'utf8');

describe('laptop_8gb column (BUG-T1-S5-07)', () => {
  it('the phrase constant is exactly the wording used everywhere', () => {
    expect(cols.LAPTOP_8GB).toBe(PHRASE);
  });

  it('both column lists end with laptop_8gb', () => {
    expect(cols.E2E_COLUMNS.at(-1)).toBe('laptop_8gb');
    expect(cols.Q_COLUMNS.at(-1)).toBe('laptop_8gb');
    expect(new Set(cols.E2E_COLUMNS).size).toBe(cols.E2E_COLUMNS.length);
    expect(new Set(cols.Q_COLUMNS).size).toBe(cols.Q_COLUMNS.length);
  });

  it.each(['e2e.csv', 'e2e-questions.csv'])(
    '%s has the laptop_8gb header and every row reads not measured on 8 GB',
    (f) => {
      const text = read(f);
      const header = text.split('\n')[0]!.split(',');
      expect(header.at(-1)).toBe('laptop_8gb');
      const rows = parseCsv(text) as Record<string, string>[];
      expect(rows.length).toBeGreaterThanOrEqual(6);
      const missing = rows.filter((r) => r['laptop_8gb'] !== PHRASE);
      expect(missing, `${missing.length} row(s) lack the phrase`).toEqual([]);
    },
  );

  it('the CSV headers equal the column lists the benchmark writes', () => {
    expect(read('e2e.csv').split('\n')[0]).toBe(cols.E2E_COLUMNS.join(','));
    expect(read('e2e-questions.csv').split('\n')[0]).toBe(cols.Q_COLUMNS.join(','));
  });

  it('csv() refuses to write a row without the phrase, and writes one with it', () => {
    const ok = { a: '1', laptop_8gb: PHRASE };
    expect(cols.csv(['a', 'laptop_8gb'], [ok])).toBe(`a,laptop_8gb\n1,${PHRASE}\n`);
    expect(() => cols.csv(['a', 'laptop_8gb'], [{ a: '1' }])).toThrow(/laptop_8gb/);
    expect(() => cols.csv(['a', 'laptop_8gb'], [{ a: '1', laptop_8gb: '' }])).toThrow(/laptop_8gb/);
    expect(() => cols.csv(['a', 'laptop_8gb'], [{ a: '1', laptop_8gb: 'measured' }])).toThrow(
      /laptop_8gb/,
    );
  });

  it('bench-e2e.mjs takes its columns from the library and stamps the phrase on both kinds of row', () => {
    const src = readFileSync(join(root, 'scripts', 'bench-e2e.mjs'), 'utf8');
    expect(src).toContain("from './lib/bench-columns.mjs'");
    expect(src.match(/laptop_8gb: LAPTOP_8GB/g)?.length).toBe(2); // one per row builder
    expect(src).not.toMatch(/const E2E_COLUMNS = \[/);
  });

  it('the README table is built from the CSV column, and fails when a row lacks the phrase', () => {
    const e2e = read('e2e.csv');
    const q = read('e2e-questions.csv');
    expect(table(e2e, q).split('\n')[2]).toContain(`| ${PHRASE} |`);
    const broken = e2e.replace(new RegExp(`,${PHRASE}(\\n|$)`), ',\n');
    expect(() => table(broken, q)).toThrow(/laptop_8gb/);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(apply(readme, table(e2e, q))).toBe(readme);
  });
});
