import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusLine } from '../src/status-line.tsx';
import { SPRINT_STATUS_LINE } from '../src/status-line-text.ts';

const unescape = (s: string) =>
  s
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"');

describe('dockit #sprint-status element (T1-S4-R1-05)', () => {
  it('renders id="sprint-status" whose text node equals the constant', () => {
    const html = renderToStaticMarkup(createElement(StatusLine));
    const m = /^<p [^>]*id="sprint-status"[^>]*>([\s\S]*)<\/p>$/.exec(html);
    expect(m).not.toBeNull();
    expect(unescape(m![1]!)).toBe(SPRINT_STATUS_LINE);
  });

  it('App renders the component, and index.html and offline.html carry no status text', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<StatusLine />');
    expect(readFileSync(new URL('../src/status-line.tsx', import.meta.url), 'utf8')).not.toMatch(
      /innerHTML|dangerouslySetInnerHTML/,
    );
    for (const f of ['../index.html', '../public/offline.html']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).not.toContain('sprint-status');
    }
  });

  it("is a Sprint 6 line: Working and Not yet, the memory result with its target outcome, 8 GB not measured, live since the owner's push, and no claim that a done-when is met", () => {
    expect(SPRINT_STATUS_LINE).toMatch(/^Sprint 6 \(19 Nov 2026\): Working: .* Not yet: .*\.$/);
    expect(SPRINT_STATUS_LINE).toContain('short of the 5,120 MiB target');
    expect(SPRINT_STATUS_LINE).toContain('one model in memory at a time');
    expect(SPRINT_STATUS_LINE).toContain('memory line');
    expect(SPRINT_STATUS_LINE).toContain('before pdf.js opens it');
    expect(SPRINT_STATUS_LINE).toContain('not measured on 8 GB');
    expect(SPRINT_STATUS_LINE).toContain('OCR');
    expect(SPRINT_STATUS_LINE).toContain('WebLLM (cut)');
    expect(SPRINT_STATUS_LINE).toContain("live since the owner's push of 18 Nov 2026");
    expect(SPRINT_STATUS_LINE).not.toMatch(/\bmet\b/);
    expect(SPRINT_STATUS_LINE).not.toMatch(/compliance|cheaper|cost/i);
  });

  // Sprint 6 Part A (D5-01): the live page is live; no dockit text may still say the owner has not pushed.
  it("no dockit source or README text says the live page 'changes only after the owner pushes'", () => {
    const files = ['../src/App.tsx', '../src/status-line-text.ts', '../README.md'];
    for (const f of files) {
      const text = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\s+/g, ' ');
      expect(text, f).not.toMatch(/changes only after the owner\s+pushes/i);
    }
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(readme).toContain("live since the owner's push of 18 Nov 2026");
  });

  // Sprint 6 (D5-10): the not-yet box says what the memory line and the stream accounting are not
  it('the not-yet box on the page says the memory line is a usability guard, not a security control, and that a PDF whose structure cannot be checked is refused', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(app).toContain('The memory line is a usability guard, not a security control');
    expect(app).toContain(
      'the browser reports memory in coarse steps and a user can change what it reports',
    );
    expect(app).toContain('a PDF whose structure cannot be checked is refused before it is opened');
    expect(app).toContain('Every question loads the models again from this device');
    expect(app).not.toMatch(/free RAM/i);
  });

  // B1: the figures in the status line are the CSVs' own. If a later bench:e2e run changes them, this test fails until the line, the README table
  // (node scripts/bench-readme.mjs) and site/data/demos.json are brought up to date from the same files.
  it('the memory figures in the status line are the median peaks of the two committed CSV pairs, and the target outcome is the one they give', () => {
    const rss = (f: string): number[] => {
      const lines = readFileSync(new URL(`../docs/benchmarks/${f}`, import.meta.url), 'utf8')
        .trim()
        .split('\n');
      const head = lines[0]!.split(',');
      return lines
        .slice(1)
        .map((l) => l.split(','))
        .filter((c) => c[head.indexOf('restart')] === 'false')
        .map((c) => Number(c[head.indexOf('process_rss_peak_bytes')]));
    };
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]!;
    const mib = (b: number) => Math.round(b / 1048576).toLocaleString('en-US');
    const after = median(rss('e2e.csv'));
    expect(SPRINT_STATUS_LINE).toContain(
      `a median of ${mib(after)} MiB, down from ${mib(median(rss('e2e-s6-baseline.csv')))} MiB`,
    );
    expect(SPRINT_STATUS_LINE.includes('short of the 5,120 MiB target')).toBe(
      after / 1048576 > 5120,
    );
  });
});
