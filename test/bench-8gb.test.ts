import { existsSync, readFileSync } from 'node:fs';
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

  it('the question list ends with laptop_8gb and the run list has laptop_8gb then the two host-load columns (BUG-T1-S6-05)', () => {
    expect(cols.E2E_COLUMNS.slice(-3)).toEqual([
      'laptop_8gb',
      'host_load_1m_start',
      'host_load_1m_end',
    ]);
    expect(cols.E2E_COLUMNS_BASE.at(-1)).toBe('laptop_8gb');
    expect(cols.E2E_COLUMNS.slice(0, cols.E2E_COLUMNS_BASE.length)).toEqual(cols.E2E_COLUMNS_BASE);
    expect(cols.Q_COLUMNS.at(-1)).toBe('laptop_8gb');
    expect(new Set(cols.E2E_COLUMNS).size).toBe(cols.E2E_COLUMNS.length);
    expect(new Set(cols.Q_COLUMNS).size).toBe(cols.Q_COLUMNS.length);
  });

  it.each(['e2e.csv', 'e2e-questions.csv'])(
    '%s has the laptop_8gb header and every row reads not measured on 8 GB',
    (f) => {
      const text = read(f);
      const header = text.split('\n')[0]!.split(',');
      // e2e.csv may carry the two trailing host-load columns (a CSV taken before BUG-T1-S6-05 does not)
      const own = f === 'e2e.csv' ? header.filter((c) => !c.startsWith('host_load_1m_')) : header;
      expect(own.at(-1)).toBe('laptop_8gb');
      const rows = parseCsv(text) as Record<string, string>[];
      expect(rows.length).toBeGreaterThanOrEqual(6);
      const missing = rows.filter((r) => r['laptop_8gb'] !== PHRASE);
      expect(missing, `${missing.length} row(s) lack the phrase`).toEqual([]);
    },
  );

  it('the CSV headers equal the column lists the benchmark writes', () => {
    const head = read('e2e.csv').split('\n')[0];
    expect([cols.E2E_COLUMNS.join(','), cols.E2E_COLUMNS_BASE.join(',')]).toContain(head);
    expect(read('e2e-questions.csv').split('\n')[0]).toBe(cols.Q_COLUMNS.join(','));
  });

  it('bench-e2e.mjs records the 1-minute load average at the start and end of every run, with two decimals (BUG-T1-S6-05)', () => {
    const src = readFileSync(join(root, 'scripts', 'bench-e2e.mjs'), 'utf8');
    expect(src).toMatch(/loadavg\(\)\[0\]/);
    expect(src).toContain('host_load_1m_start');
    expect(src).toContain('host_load_1m_end');
    expect(cols.hostLoad(2.4)).toBe('2.40');
    expect(cols.hostLoad(11.567)).toBe('11.57');
    const row: Record<string, string> = {
      laptop_8gb: PHRASE,
      host_load_1m_start: '1.00',
      host_load_1m_end: '2.00',
    };
    const lines = cols
      .csv(cols.E2E_COLUMNS, [Object.fromEntries(cols.E2E_COLUMNS.map((c) => [c, row[c] ?? 'x']))])
      .split('\n');
    expect(lines[0]!.endsWith(',laptop_8gb,host_load_1m_start,host_load_1m_end')).toBe(true);
    expect(lines[1]!.endsWith(`,${PHRASE},1.00,2.00`)).toBe(true);
  });

  it('the README says peaks are comparable only on a quiet host, and names the exact fall (BUG-T1-S6-05)', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toMatch(/Process-tree peaks are comparable only between runs on a quiet host/);
    expect(readme).toContain('The stated figure is the quiet-host one');
    expect(readme).toMatch(
      /computed from the exact medians \(the exact fall is \d[\d,]*\.\d MiB, shown as [\d,]+ MiB\)/,
    );
    // no tester load figure in the README: those numbers live in B1-result.md only
    expect(readme).not.toMatch(/load average of 7/);
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
    // without the baseline pair the block starts with the per-CSV table; with it (the README) the comparison table comes first and carries the phrase too
    expect(table(e2e, q, null).split('\n')[2]).toContain(`| ${PHRASE} |`);
    const withBaseline = table(e2e, q).split('\n');
    expect(withBaseline.filter((l) => /^\| (Before|After)/.test(l))).toHaveLength(2);
    for (const l of withBaseline.filter((l) => /^\| (Before|After)/.test(l)))
      expect(l).toContain(`| ${PHRASE} |`);
    // the phrase is followed by the two host-load columns in a CSV taken since BUG-T1-S6-05, and ends the line in an older one
    const broken = e2e.replace(new RegExp(`,${PHRASE}(,|\\n|$)`), ',$1');
    expect(() => table(broken, q)).toThrow(/laptop_8gb/);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(apply(readme, table(e2e, q))).toBe(readme);
  });

  // B6 / TD-113: the emulated Windows results are separate files; when they are committed they obey the same rule and name what they are
  it.each([
    ['e2e-emulated-win-vm.csv', cols.E2E_EMULATED_COLUMNS],
    ['e2e-emulated-win-vm-questions.csv', cols.Q_EMULATED_COLUMNS],
  ])(
    '%s, when it is committed, has its own header, an environment on every row and the 8 GB phrase on every row',
    (f, columns) => {
      const file = join(root, 'docs', 'benchmarks', f);
      if (!existsSync(file)) return; // nothing to check until the first dispatch of bench-windows has been imported
      const text = readFileSync(file, 'utf8');
      expect(text.split('\n')[0]).toBe(columns.join(','));
      for (const r of parseCsv(text) as Record<string, string>[]) {
        expect(r['laptop_8gb']).toBe(PHRASE);
        expect(() => cols.validateEnvironmentLabel(r['environment']!)).not.toThrow();
      }
    },
  );

  it('the laptop CSVs never carry an environment column (an emulated figure is never written into them)', () => {
    for (const f of ['e2e.csv', 'e2e-questions.csv'])
      expect(read(f).split('\n')[0]!.split(',')).not.toContain('environment');
  });
});
