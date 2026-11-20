import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusLine } from '../src/status-line.tsx';
import { SPRINT_STATUS_LINE } from '../src/status-line-text.ts';
import { windowsClause } from '../scripts/status-line.mjs';
import { csv, E2E_EMULATED_COLUMNS, LAPTOP_8GB } from '../scripts/lib/bench-columns.mjs';

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

  it('is a Sprint 7 line: Working and Not yet, the re-measured memory result with its target outcome, 8 GB not measured, the Windows benchmark as it ran, and no claim that a done-when is met', () => {
    expect(SPRINT_STATUS_LINE).toMatch(/^Sprint 7 \(20 Nov 2026\): Working: .* Not yet: .*\.$/);
    expect(SPRINT_STATUS_LINE).toContain('nothing about the page changed in Sprint 7');
    expect(SPRINT_STATUS_LINE).toContain(
      're-measured on a quiet machine on the committed Sprint 6 build',
    );
    expect(SPRINT_STATUS_LINE).toContain('still short of the 5,120 MiB target');
    expect(SPRINT_STATUS_LINE).toContain('one model in memory at a time');
    // the emulated Windows run has happened (bench-windows run 44666921454): the line says what it showed, from the committed rows, and not a word of 'has not run' or 'pending'
    expect(SPRINT_STATUS_LINE).toContain(
      'a Windows benchmark under an emulated memory cap (a GitHub-hosted virtual machine with 4 vCPU and 16 GB RAM, never a laptop) has run',
    );
    expect(SPRINT_STATUS_LINE).toContain(
      'the commit limit of its 8 GiB, 6 GiB and 5 GiB legs is proven in force',
    );
    expect(SPRINT_STATUS_LINE).toContain(
      'commits were refused while the benchmark ran on the 5 GiB leg and it still finished',
    );
    expect(SPRINT_STATUS_LINE).toContain(
      'the 2 GiB control leg, which must not finish, did not finish',
    );
    expect(SPRINT_STATUS_LINE).toContain(
      'it limits committed memory on one virtual machine, so it is not a laptop figure and fills no 8 GB cell',
    );
    expect(SPRINT_STATUS_LINE).toContain(
      'a Windows or 8 GB laptop figure (the emulated Windows run is not one)',
    );
    expect(SPRINT_STATUS_LINE).not.toMatch(/has not run|is written and|pending its first run/u);
    expect(SPRINT_STATUS_LINE).toContain('not measured on 8 GB');
    expect(SPRINT_STATUS_LINE).toContain('OCR');
    expect(SPRINT_STATUS_LINE).toContain('WebLLM (cut)');
    expect(SPRINT_STATUS_LINE).toContain('emulated');
    expect(SPRINT_STATUS_LINE).toContain("live since the owner's push of 18 Nov 2026");
    expect(SPRINT_STATUS_LINE).not.toMatch(/\bmet\b/);
    expect(SPRINT_STATUS_LINE).not.toMatch(/compliance|cheaper|cost|published|audited|compliant/i);
    // the line never calls an emulated figure a laptop figure and every 8 GB mention is the negative
    expect(SPRINT_STATUS_LINE).not.toMatch(/(?<!not )measured on 8 GB/);
  });

  it('the Sprint 7 not-yet box says what the emulated Windows figures are and are not: committed memory on one virtual machine, no 8 GB cell, nothing pending', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(app).toContain(
      'The emulated Windows figures (one run of the manual benchmark on a GitHub-hosted virtual machine with 4 vCPU and 16 GB RAM, not a laptop) limit committed memory only:',
    );
    expect(app).toContain(
      "they do not model an 8 GB machine's operating system and other apps, integrated graphics, heat or disk. They say what they are on every row and fill no 8 GB laptop cell.",
    );
    expect(app).toContain('A Windows or 8 GB laptop figure');
    expect(app).not.toMatch(/is pending the first run|written and has not run/u);
  });

  describe('the Windows clause is computed from the emulated rows and claims nothing the rows do not give', () => {
    const LABEL = (gib: number | null, control = false) =>
      `emulated: GitHub-hosted Windows Server 2025 Datacenter VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree ${gib === null ? 'with no job limit' : `under a job commit limit of ${gib * 1073741824} bytes${control ? ' (control leg, expected to fail)' : ''}`}; not a laptop`;
    const legRows = (
      gib: number | null,
      o: {
        control?: boolean;
        total?: string;
        probe?: string;
        probeRefused?: string;
        runs?: number;
      } = {},
    ) =>
      Array.from({ length: o.control ? 1 : (o.runs ?? 6) }, (_, i) => ({
        ...Object.fromEntries(E2E_EMULATED_COLUMNS.map((c) => [c, ''])),
        run: o.control ? '0' : String(i + 1),
        restart: i === 5 ? 'true' : 'false',
        laptop_8gb: LAPTOP_8GB,
        environment: LABEL(gib, o.control),
        machine: LABEL(gib, o.control),
        job_commit_limit_bytes: gib === null ? '' : String(gib * 1073741824),
        control_leg: o.control ? 'true' : 'false',
        ...(gib === null
          ? {
              job_limit_readback_bytes: '0',
              job_limit_flags_readback: '0x2000',
              job_memory_limit_messages: '0',
            }
          : {
              job_limit_readback_bytes: String(gib * 1073741824),
              job_limit_flags_readback: '0x2200',
              limit_probe_refused: o.probeRefused ?? 'true',
              job_memory_limit_messages: o.total ?? '1',
              probe_memory_limit_messages: o.probe ?? '1',
            }),
      }));
    const clause = (...legs: ReturnType<typeof legRows>[]) =>
      windowsClause(csv(E2E_EMULATED_COLUMNS, legs.flat()));

    it('with no emulated CSV it says the benchmark has not run', () => {
      expect(windowsClause(undefined)).toBe(
        'a Windows benchmark under an emulated memory cap (a GitHub-hosted virtual machine, never a laptop) is written and has not run',
      );
    });
    it('names the capped legs, the leg that had refusals while the benchmark ran, and the control that did not finish', () => {
      const c = clause(
        legRows(null),
        legRows(8),
        legRows(5, { total: '3' }),
        legRows(2, { control: true, total: '2' }),
      );
      expect(c).toContain('the commit limit of its 8 GiB and 5 GiB legs is proven in force');
      expect(c).toContain('all 3 legs finished');
      expect(c).toContain(
        'commits were refused while the benchmark ran on the 5 GiB leg and it still finished',
      );
      expect(c).toContain('the 2 GiB control leg, which must not finish, did not finish');
    });
    it('says no commit was refused when none was, and leaves the control out when there is none', () => {
      const c = clause(legRows(null), legRows(8), legRows(6));
      expect(c).toContain('no commit was refused while the benchmark ran');
      expect(c).not.toContain('control');
    });
    it('claims nothing about a cap when a limit is not proven, a leg did not finish or there is no capped leg', () => {
      for (const c of [
        clause(legRows(null), legRows(8, { probeRefused: '' })),
        clause(legRows(null), legRows(8, { probeRefused: 'false' })),
        clause(legRows(null), legRows(8, { runs: 3 })),
        clause(legRows(null)),
      ]) {
        expect(c).toContain('has run (its rows are in the repository');
        expect(c).not.toMatch(/proven in force|refused/u);
      }
    });
    it('never calls the run a laptop figure or an 8 GB result', () => {
      const c = clause(legRows(null), legRows(8));
      expect(c.replace('not a laptop figure', '')).not.toMatch(/laptop figure|8 GB result/iu);
    });
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
