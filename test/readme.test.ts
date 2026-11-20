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

  it("states that S1-107 is closed: a PDF that hides a very large compressed font or image is refused before pdf.js opens it, with the measured outcome and 'not measured on 8 GB'", () => {
    expect(lim).toContain(
      'A hostile PDF that hides a very large compressed font or image is refused before pdf.js opens it',
    );
    expect(lim).not.toContain('stream accounting across fonts and images is planned');
    expect(lim).toMatch(/font-bomb/iu);
    expect(lim).toMatch(/Measured on 19 Nov 2026/u);
    expect(lim).toMatch(/peak[^.]{0,60}resident size[\s\S]{0,300}\d[\d,]* MiB/iu);
    expect(lim).toContain('8,121 MiB'); // Sprint 5's figure for the same bomb, as the comparison
    expect(lim).toMatch(/refused before it was opened/iu);
    expect(lim).toMatch(/not measured on 8 GB/iu);
  });

  it('says what the stream accounting still does not cover (pdf.js inline images, Type 3 procedures, font-parser time) and that a damaged file other readers repair is refused', () => {
    expect(lim).toMatch(/inline[- ]image/iu);
    expect(lim).toMatch(/Type 3/u);
    expect(lim).toMatch(/damaged file|repair/iu);
  });

  it('says the memory line is a usability guard and not a security control, and that every question loads the models again (the cost, measured)', () => {
    expect(lim).toContain('The memory line is a usability guard, not a security control');
    expect(lim).toMatch(/deviceMemory[^.]{0,80}(user-controlled|overrid|change)/iu);
    expect(lim).toMatch(
      /Every question loads the embedder and then the answer model again from this device/u,
    );
    expect(lim).toMatch(/\d[\d,]* ms/u);
    expect(lim).not.toMatch(/free RAM/iu);
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
  it('the first paragraph of ## Status is the Sprint 7 status line of the page (and of site/data/demos.json), word for word', () => {
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

// Sprint 7 (B6, TD-101, TD-116, TD-120): the README names its live demo on the first screen, the commit its figures were measured on, the Windows benchmark
// that has run once with its job commit limit unproven, and that dockit is never published to a registry.
describe('README, Sprint 7', () => {
  const csv = (f: string) =>
    readFileSync(new URL(`../docs/benchmarks/${f}`, import.meta.url), 'utf8')
      .trim()
      .split('\n');
  const commits = (() => {
    const lines = csv('e2e.csv');
    const i = lines[0]!.split(',').indexOf('commit');
    return [...new Set(lines.slice(1).map((l) => l.split(',')[i]!))];
  })();

  it('has the Live demo line within its first 12 lines (TD-116)', () => {
    const first = readme.split('\n').slice(0, 12);
    expect(first).toContain('Live demo: https://airplanemode-labs.github.io/dockit/');
  });

  it('e2e.csv carries one clean commit (no -dirty), and the README states the dockit commit the figures were measured on (TD-101)', () => {
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatch(/^[0-9a-f]{12}$/u);
    expect(csv('e2e-questions.csv').join('\n')).not.toContain('-dirty');
    expect(flat).toContain(`measured on dockit commit \`${commits[0]}\``);
    expect(flat).not.toMatch(/commit column reads `-dirty`/u);
    expect(flat).toMatch(/quiet host/u);
  });

  it('describes the Windows benchmark under an emulated memory cap, records its one run (44656249868) and says the limit is unproven, and keeps every 8 GB cell and the done-when as they were', () => {
    const s = section('Benchmarks').replace(/\s+/g, ' ');
    expect(s).toContain('bench-windows');
    expect(s).toContain('Windows Job Object');
    expect(s).toContain('pwsh, node and Chrome process tree');
    expect(s).toMatch(/not a laptop/u);
    expect(s).toContain('**The workflow has run once.**');
    expect(s).toContain('run 44656249868');
    expect(s).toContain('5705baab8cdf');
    expect(s).toMatch(/limit was never read back/u);
    expect(s).toMatch(/limit unproven/u);
    expect(s).not.toMatch(/has not run|written and has not|pending its first run/u);
    // the change that settles the limit: read-back, probe, control leg; written, and no Windows run has tested it
    expect(s).toContain('no Windows run has tested it yet');
    expect(s).toContain('reads the limit back from the system');
    expect(s).toContain('a 2 GiB control, is green only when the benchmark fails to complete');
    expect(s).toContain('limit proven in force (probe refused, read-back equal)');
    expect(s).toMatch(/commit limit is not a physical-memory limit/u);
    expect(s).toContain('scripts/win/README.md');
    expect(s).toMatch(/2 vCPU, 8 GB[^.]*not built/u);
    expect(flat).toContain('8 GB Windows done-when NOT met (owner runbook step 5)');
  });

  it('docs/release.md says the Windows run happened once, that it is emulated, and that its limit is unproven', () => {
    const rel = readFileSync(new URL('../docs/release.md', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(rel).toMatch(/`bench-windows` workflow ran once \(run 44656249868/u);
    expect(rel).toMatch(/emulated \(a GitHub-hosted VM, not a laptop\)/u);
    expect(rel).toMatch(/limit is unproven/u);
    expect(rel).not.toMatch(/written and has not run/u);
  });

  it('says dockit is never published to a registry and that the Pages deploy is the release (TD-120), and docs/release.md says it in one sentence', () => {
    expect(flat).toContain('never published to a registry; the Pages deploy is the release');
    const rel = readFileSync(new URL('../docs/release.md', import.meta.url), 'utf8');
    expect(rel).toContain('never published to a registry; the Pages deploy is the release');
    expect(rel).toMatch(/not tagged|no tag/u);
    expect(rel).toMatch(/not measured on 8 GB/u);
  });

  it("the Limitations section says there is no Windows laptop figure and the one emulated run has an unproven limit, and that the local Playwright launch has Chrome's sandbox off", () => {
    const lim = section('Limitations').replace(/\s+/g, ' ');
    expect(lim).toMatch(/No Windows laptop figure exists/u);
    expect(lim).toMatch(/emulated Windows run[^.]*ran once/u);
    expect(lim).toMatch(/limit was in effect is unproven/u);
    expect(lim).not.toMatch(/has not run|nothing has run on Windows/u);
    expect(lim).toMatch(/Playwright[^.]*sandbox/u);
  });
});

describe('issue forms and contribution guide (TD-117)', () => {
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  it('bug_report.yml carries the required no-real-documents checkbox and asks for redaction', () => {
    const y = read('.github/ISSUE_TEMPLATE/bug_report.yml');
    expect(y).toContain(
      'I have not attached any real, confidential or personal document (bank, legal, medical, identity). Any sample is synthetic or public.',
    );
    expect(y).toMatch(/type: checkboxes/u);
    expect(y).toMatch(/required: true/u);
    expect(y).toMatch(/redact/iu);
    expect(y).toMatch(/SECURITY\.md/u);
  });
  it('feature_request.yml exists and config.yml disables blank issues and links SECURITY.md', () => {
    expect(read('.github/ISSUE_TEMPLATE/feature_request.yml')).toMatch(/type: textarea/u);
    const c = read('.github/ISSUE_TEMPLATE/config.yml');
    expect(c).toMatch(/blank_issues_enabled: false/u);
    expect(c).toContain('https://github.com/AirplaneMode-Labs/dockit/blob/main/SECURITY.md');
    expect(c).toMatch(/contact_links:/u);
  });
  it('SECURITY.md says to report privately and never in a public issue, and CONTRIBUTING.md exists and points to the forms', () => {
    expect(read('SECURITY.md').replace(/\s+/g, ' ')).toMatch(/never in a public issue/iu);
    expect(read('CONTRIBUTING.md')).toMatch(/issue/iu);
    expect(read('CONTRIBUTING.md')).toMatch(/real document|real, confidential/iu);
  });
});

describe('README: the example environment label is the form run-capped.ps1 prints (BUG-T1-S7-10)', () => {
  it('shows the byte-limit form and the no-limit form, not the old GiB-form label', () => {
    expect(readme).toContain(
      'emulated: GitHub-hosted Windows Server 2025 VM, x64, 4 vCPU, 16 GB RAM, pwsh, node and Chrome process tree under a job commit limit of 6442450944 bytes; not a laptop',
    );
    expect(readme).toContain('with no job limit');
    expect(readme).not.toContain(['6 GiB', 'job commit'].join(' '));
  });
});
