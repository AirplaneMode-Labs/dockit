import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPRINT_STATUS_LINE } from '../src/status-line-text.ts';

// What the README promises about the benchmark, the by-hand sampler and the limits of the page, pinned so the wording cannot drift
// (BUG-T1-S5-08, BUG-T1-S5-09 / S1-107, T3-S5-07, S1-112 c).
const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8').replace(
  /\r\n/gu,
  '\n',
);
const flat = readme.replace(/\s+/g, ' ');
const section = (title: string): string => {
  const m = new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=^## )`, 'mu').exec(readme);
  return m?.[1] ?? '';
};

describe('README: the by-hand memory sampler (T3-S5-07)', () => {
  const line =
    readme
      .split('\n')
      .find((l) => l.startsWith('powershell.exe') && l.includes('Get-CimInstance')) ?? '';

  it('has one powershell.exe sampler line', () => {
    expect(line).not.toBe('');
  });

  it('hands the loop to the child in single quotes, so the outer PowerShell never expands $true', () => {
    expect(line).toMatch(/-Command '/u);
    expect(line).not.toMatch(/-Command "/u);
    // no double-quoted string anywhere on the line holds a $ variable
    expect([...line.matchAll(/"([^"]*)"/gu)].filter((m) => m[1]!.includes('$'))).toEqual([]);
    expect(line).toContain('while ($true)');
  });

  it('filters on the test profile folder like bench-e2e does, samples every 500 ms and reads WorkingSetSize', () => {
    expect(line).toContain('--user-data-dir=');
    expect(line).toContain('chrome-profile-');
    expect(line).toContain('Start-Sleep -Milliseconds 500');
    expect(line).toContain('WorkingSetSize');
  });

  it('says it has never run on Windows (next to the line)', () => {
    const i = readme.indexOf(line);
    const near = readme.slice(Math.max(0, i - 1500), i + 1500).replace(/\s+/g, ' ');
    expect(near).toMatch(/has never run on Windows/iu);
  });
});

describe("README: what 'requests after offline = 0' counts (BUG-T1-S5-08)", () => {
  it('says the count is of application requests from the page, its workers and its service worker', () => {
    expect(flat).toMatch(/requests after offline.{0,60}counts? application requests/iu);
    expect(flat).toContain('the page, its workers and its service worker');
  });

  it('says the browser itself may still check /dockit/sw.js for an update and fetch the favicon, which the count does not include', () => {
    expect(flat).toContain('/dockit/sw.js');
    expect(flat).toMatch(/favicon/iu);
    expect(flat).toMatch(/does not include/iu);
  });
});

describe('README Limitations (BUG-T1-S5-09 / S1-107, S1-112 c)', () => {
  const lim = section('Limitations').replace(/\s+/g, ' ');

  it("carries the S1-107 sentence: a hostile PDF can still exhaust the tab's memory; stream accounting is planned for Sprint 6", () => {
    expect(lim).toContain(
      "A hostile PDF that hides a very large compressed font or image can still exhaust the tab's memory; stream accounting across fonts and images is planned (Sprint 6).",
    );
  });

  it("records what the font-bomb fixture did in Chrome: the outcome, the peak RSS, and 'not measured on 8 GB'", () => {
    expect(lim).toMatch(/font-bomb/iu);
    expect(lim).toMatch(/Observed/u);
    expect(lim).toMatch(/peak[^.]{0,40}resident size[\s\S]{0,200}\d[\d,]* MiB/iu);
    expect(lim).toMatch(/refus|accepted|crash|success/iu);
  });

  it('a page cut short by a stream limit is refused as too large, not as scanned (BUG-T1-S5-09)', () => {
    expect(flat).toContain(
      'A part of this PDF is larger than dockit will unpack, so it was not read.',
    );
  });

  it("says what a kept document stores: chunk text, embeddings, page numbers and the file's SHA-256, unencrypted, and what the hash can confirm", () => {
    expect(lim).toMatch(/chunk text, embeddings, page numbers and the (?:source )?file's SHA-256/u);
    expect(lim).toContain('unencrypted');
    expect(lim).toContain('confirm whether a known document was processed');
  });
});

describe('README: section 1 is the status line', () => {
  it('the first paragraph of ## Status is the Sprint 5 status line of the page (and of site/data/demos.json), word for word', () => {
    const m = /^## Status\n\n([\s\S]*?)\n\n/mu.exec(readme);
    expect(m, 'no ## Status section').not.toBeNull();
    expect(m![1]!.replace(/\s+/gu, ' ')).toBe(SPRINT_STATUS_LINE);
  });
});

describe('README: what the pipeline does with ill-formed text and with one refused passage (BUG-T2-S5-10)', () => {
  it('says that an unpaired surrogate becomes U+FFFD before chunking, and that one refused passage is set aside while the document goes on', () => {
    expect(flat).toMatch(/unpaired surrogate[\s\S]{0,120}U\+FFFD/u);
    expect(flat).toMatch(
      /refuses a single passage[\s\S]{0,120}set aside[\s\S]{0,120}not_analysed/u,
    );
    expect(flat).toContain('the rest of the document goes on');
  });
});

// T3-R1-05: an earlier sprint's 'committed, not pushed' history is dated, so no current-looking sentence says Sprint 4 is unpushed.
describe('CHANGELOG: earlier history is dated (T3-R1-05)', () => {
  it("every earlier 'committed, not pushed' item starts with the as-of prefix", () => {
    const changelog = readFileSync(join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8').replace(
      /\r\n/gu,
      '\n',
    );
    const items = changelog.split(/^- /mu).slice(1);
    const history = items.filter(
      (it) => /not pushed/u.test(it) && !it.startsWith('Sprint 5 (18 Nov 2026'),
    );
    expect(history.length).toBeGreaterThanOrEqual(1);
    for (const it of history)
      expect(
        it.startsWith("As of 14 Nov 2026, before the owner's push on 15 Nov:"),
        it.slice(0, 80),
      ).toBe(true);
  });
});
