import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { memoryFigures, memoryWords, exactMedian } from '../scripts/memory-figures.mjs';
import { statusLine, fileText } from '../scripts/status-line.mjs';
import { SPRINT_STATUS_LINE } from '../src/status-line-text.ts';

const rd = (f: string): string =>
  readFileSync(new URL(`../docs/benchmarks/${f}`, import.meta.url), 'utf8');
const csv = {
  b: rd('e2e-s6-baseline.csv'),
  bq: rd('e2e-questions-s6-baseline.csv'),
  a: rd('e2e.csv'),
  aq: rd('e2e-questions.csv'),
};

// BUG-T1-S6-04: one rounding rule, no hand-typed figure
describe('memory figures are derived from the committed CSVs with one rounding rule', () => {
  it('exactMedian averages the two middle values and refuses a missing one', () => {
    expect(exactMedian([3, 1, 2])).toBe(2);
    expect(exactMedian([4, 1, 2, 3])).toBe(2.5);
    expect(exactMedian([1, null])).toBeNull();
  });

  it('the fall is computed from the exact medians, then rounded (not from two rounded medians)', () => {
    const f = memoryFigures(csv.b, csv.bq, csv.a, csv.aq);
    const rss = (text: string): number[] =>
      text
        .trim()
        .split('\n')
        .slice(1)
        .map((l) => l.split(','))
        .filter((c) => c[5] !== 'true')
        .map((c) => Number(c[22]));
    const med = (v: number[]): number => {
      const s = [...v].sort((x, y) => x - y);
      return s[s.length >> 1]!;
    };
    expect(rss(csv.a)).toHaveLength(5);
    const exact = (med(rss(csv.b)) - med(rss(csv.a))) / 1048576;
    expect(f.fallMiB).toBeCloseTo(exact, 9);
    const w = memoryWords(f);
    expect(w.fall).toBe(`${Math.round(exact).toLocaleString('en-US')} MiB`);
    expect(w.fallPercent).toBe(((exact / (med(rss(csv.b)) / 1048576)) * 100).toFixed(1));
    expect(w.runsNote).toContain('in-session runs');
  });

  it('the README block states the same fall and the 5-run definition of the median', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    const w = memoryWords(memoryFigures(csv.b, csv.bq, csv.a, csv.aq));
    expect(readme).toContain(`a fall of ${w.fall} (${w.fallPercent} percent)`);
    expect(readme).toContain('median of the 5 in-session runs');
    expect(readme).toContain(
      `computed from the exact medians (the exact fall is ${w.fallExact1}, shown as ${w.fall}) and then rounded`,
    );
  });

  it('the status line equals the generated line, with the same medians and the 5-run definition', () => {
    const emulated = readFileSync(
      new URL('../docs/benchmarks/e2e-emulated-win-vm.csv', import.meta.url),
      'utf8',
    );
    const line = statusLine(csv.b, csv.bq, csv.a, csv.aq, emulated);
    expect(SPRINT_STATUS_LINE).toBe(line);
    const w = memoryWords(memoryFigures(csv.b, csv.bq, csv.a, csv.aq));
    expect(line).toContain(`a median of ${w.afterMedian}, down from ${w.beforeMedian}`);
    expect(line).toContain(`down from ${w.beforeMedian}`);
    expect(line).toContain('in-session runs');
    expect(fileText(line)).toContain(JSON.stringify(line));
  });
});
