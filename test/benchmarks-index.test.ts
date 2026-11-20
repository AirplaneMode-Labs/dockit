import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../scripts/bench-readme.mjs';

// docs/benchmarks/README.md indexes every file and folder of docs/benchmarks (owner decision, 20 Nov 2026). This test fails when a file or a folder there is
// missing from the index, when the index names one that does not exist, when the date, commit, machine or row count the index states for a CSV is not what
// the CSV holds, when a leg's runner or limit is not what its env.txt and job-summary.json say, and when a figure the index lists as quoted without a raw row
// is no longer quoted where the index says, or has lost its mark.
const root = join(import.meta.dirname, '..');
const dir = join(root, 'docs', 'benchmarks');
const INDEX = 'README.md';
const norm = (s: string) => s.replace(/\r\n/gu, '\n');
const flat = (s: string) => norm(s).replace(/\s+/gu, ' ');
const indexText = norm(readFileSync(join(dir, INDEX), 'utf8'));

/** Every file and folder under `base` as a posix path relative to it, folders with a trailing slash, the index itself left out. */
function listTree(base: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(base, rel)).sort()) {
    const path = rel === '' ? name : `${rel}/${name}`;
    if (path === INDEX) continue;
    if (statSync(join(base, path)).isDirectory()) out.push(`${path}/`, ...listTree(base, path));
    else out.push(path);
  }
  return out;
}

interface Table {
  header: string[];
  rows: string[][];
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/gu, '')
    .split('|')
    .map((c) => c.trim());

/** Every markdown table of the page: its header cells and its body rows, as cell texts. */
function tables(md: string): Table[] {
  const lines = md.split('\n');
  const out: Table[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const sep = lines[i + 1] ?? '';
    if (lines[i]!.startsWith('|') && /^\|[\s:|-]+\|$/u.test(sep.trim())) {
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.startsWith('|')) rows.push(cells(lines[j++]!));
      out.push({ header: cells(lines[i]!), rows });
      i = j;
    }
  }
  return out;
}

const unspan = (c: string): string => /^`([^`]+)`$/u.exec(c)?.[1] ?? c;
const spans = (c: string): string[] => [...c.matchAll(/`([^`]+)`/gu)].map((m) => m[1]!);

/** The paths the index names: the first cell of every row of a table whose first header cell is Path. */
function entries(md: string): string[] {
  return tables(md)
    .filter((t) => t.header[0] === 'Path')
    .flatMap((t) => t.rows.map((r) => unspan(r[0] ?? '')));
}

/** The problems between what is on disk and what the index names (both directions, and a name listed twice). */
function coverage(onDisk: string[], md: string): string[] {
  const named = entries(md);
  const disk = new Set(onDisk);
  const problems: string[] = [];
  for (const p of onDisk) if (!named.includes(p)) problems.push(`missing from the index: ${p}`);
  for (const p of named)
    if (!disk.has(p)) problems.push(`the index names something that does not exist: ${p}`);
  for (const p of new Set(named))
    if (named.filter((n) => n === p).length > 1) problems.push(`listed twice: ${p}`);
  return problems;
}

const onDisk = listTree(dir);
const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');
const column = (t: Table, name: string): number => {
  const i = t.header.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return i;
};
const filesTable = tables(indexText).find((t) => t.header.includes('Commit'))!;
const legsTable = tables(indexText).find((t) => t.header.includes('Runner (from `env.txt`)'))!;
const quotedTable = tables(indexText).find((t) => t.header[0] === 'File')!;

describe('docs/benchmarks/README.md: every file and folder is in the index, and the index names nothing that is absent', () => {
  it('the folder holds what this test expects to find (a tripwire for the walk itself)', () => {
    expect(onDisk).toContain('e2e.csv');
    expect(onDisk).toContain('history/');
    expect(onDisk).toContain('emulated-win-vm-run-44666921454/2GiB/job-summary.json');
    expect(onDisk.filter((p) => !p.endsWith('/')).length).toBeGreaterThanOrEqual(18);
  });

  it('has no problem on the real folder', () => {
    expect(coverage(onDisk, indexText)).toEqual([]);
  });

  it('fails for a file that is on disk and not in the index', () => {
    expect(coverage([...onDisk, 'e2e-new-run.csv'], indexText)).toEqual([
      'missing from the index: e2e-new-run.csv',
    ]);
    expect(coverage([...onDisk, 'history/notes.txt'], indexText)).toEqual([
      'missing from the index: history/notes.txt',
    ]);
  });

  it('fails for a folder that is on disk and not in the index', () => {
    expect(coverage([...onDisk, 'emulated-win-vm-run-1/'], indexText)).toEqual([
      'missing from the index: emulated-win-vm-run-1/',
    ]);
  });

  it('fails for an index that names a file that does not exist', () => {
    expect(
      coverage(
        onDisk.filter((p) => p !== 'e2e-questions.csv'),
        indexText,
      ),
    ).toEqual(['the index names something that does not exist: e2e-questions.csv']);
    expect(
      coverage(
        onDisk.filter((p) => !p.startsWith('history/')),
        indexText,
      ),
    ).toContain('the index names something that does not exist: history/');
  });

  it('fails for a path listed twice', () => {
    const doubled = indexText.replace(/^(\| `e2e\.csv`\s+\|.*)$/mu, (row) => `${row}\n${row}`);
    expect(doubled).not.toBe(indexText);
    expect(coverage(onDisk, doubled)).toEqual(['listed twice: e2e.csv']);
  });

  it('a path in a table that is not an index table is not an entry (the quoted-figures table names files of the repository)', () => {
    expect(entries(indexText)).not.toContain('README.md');
    expect(entries(indexText)).not.toContain('CHANGELOG.md');
  });
});

describe('docs/benchmarks/README.md: the Files table says what each CSV holds', () => {
  const rowOf = (path: string): string[] => {
    const row = filesTable.rows.find((r) => unspan(r[0] ?? '') === path);
    expect(row, `no row for ${path}`).toBeDefined();
    return row!;
  };
  const csvs = onDisk.filter((p) => p.endsWith('.csv'));

  it('has the eight columns the owner asked for', () => {
    expect(filesTable.header).toEqual([
      'Path',
      'What it is',
      'Date (UTC)',
      'Commit',
      'Machine or environment',
      'Method',
      'Reproduce',
      'Status',
    ]);
    for (const r of filesTable.rows) {
      expect(r.length, r[0]).toBe(8);
      for (const [i, c] of r.entries())
        expect(c.length, `${r[0]} column ${filesTable.header[i]}`).toBeGreaterThan(0);
    }
  });

  it('gives every row one of three statuses', () => {
    for (const r of filesTable.rows)
      expect(['current', 'historical baseline', 'historical'], r[0]).toContain(
        r[column(filesTable, 'Status')],
      );
  });

  it('marks the second dispatch, and nothing else, as historical, and the Sprint 6 before pair as the historical baseline', () => {
    const status = (p: string) => rowOf(p)[column(filesTable, 'Status')];
    expect(status('history/')).toBe('historical');
    expect(status('history/e2e-emulated-win-vm-run-44656249868.csv')).toBe('historical');
    expect(status('history/e2e-emulated-win-vm-run-44656249868-questions.csv')).toBe('historical');
    expect(status('e2e-s6-baseline.csv')).toBe('historical baseline');
    expect(status('e2e-questions-s6-baseline.csv')).toBe('historical baseline');
    for (const p of [
      'e2e.csv',
      'e2e-questions.csv',
      'e2e-emulated-win-vm.csv',
      'e2e-emulated-win-vm-questions.csv',
    ])
      expect(status(p)).toBe('current');
  });

  for (const csv of csvs) {
    describe(csv, () => {
      const rows = parseCsv(read(csv));
      const row = () => rowOf(csv);
      const get = (name: string) => row()[column(filesTable, name)]!;

      it('states the number of rows the file holds', () => {
        expect(rows.length).toBeGreaterThan(0);
        expect(flat(get('What it is'))).toMatch(
          new RegExp(`(^|[^\\d,])${rows.length}( rows)`, 'u'),
        );
      });

      it('states the commit of every row, and no row is -dirty', () => {
        const commits = [...new Set(rows.map((r) => r['commit']!))];
        expect(commits.length, `commits in ${csv}`).toBe(1);
        for (const c of commits) {
          expect(c).toMatch(/^[0-9a-f]{12}$/u);
          expect(spans(get('Commit'))).toContain(c);
        }
      });

      it('states the day of every row (the marker row of a control leg has none)', () => {
        const days = [
          ...new Set(rows.map((r) => r['date']!.slice(0, 10)).filter((d) => d !== '')),
        ].sort();
        expect(days.length).toBeGreaterThan(0);
        expect(
          [...get('Date (UTC)').matchAll(/\d{4}-\d{2}-\d{2}/gu)].map((m) => m[0]).sort(),
        ).toEqual(days);
      });

      it('names the machine of the row: the Mac, or the start and the end of the environment label', () => {
        const machines = [...new Set(rows.map((r) => r['machine'] ?? r['environment'] ?? ''))];
        const label = get('Machine or environment');
        const emulated = machines.some((m) => m.startsWith('emulated: '));
        if (!emulated) {
          expect(machines).toEqual(['Apple M5 Pro 48 GB']);
          expect(label).toContain('`Apple M5 Pro 48 GB`');
        } else {
          const prefix = spans(label).find((s) => s.startsWith('emulated: '));
          expect(prefix, `${csv}: a code span that starts with 'emulated: '`).toBeDefined();
          for (const m of machines) {
            expect(m.startsWith(prefix!), m).toBe(true);
            expect(
              m.endsWith('; not a laptop') ||
                m.endsWith('(control leg, expected to fail); not a laptop'),
              m,
            ).toBe(true);
          }
          expect(label).toContain('; not a laptop`');
        }
      });

      it('every row reads not measured on 8 GB, and the index says so', () => {
        for (const r of rows) expect(r['laptop_8gb']).toBe('not measured on 8 GB');
      });
    });
  }

  it('names the Chrome builds of the legs of both emulated CSVs', () => {
    for (const csv of [
      'e2e-emulated-win-vm.csv',
      'history/e2e-emulated-win-vm-run-44656249868.csv',
    ]) {
      const builds = new Set(
        parseCsv(read(csv))
          .map((r) => r['chrome']!)
          .filter((c) => c !== ''),
      );
      const cell = rowOf(csv)[column(filesTable, 'Machine or environment')]!;
      for (const b of builds) expect(cell, `${csv}: ${b}`).toContain(b);
    }
  });

  it('names the run and the dispatched commit of the evidence folder, and the artefact name carries the full commit', () => {
    const row = rowOf('emulated-win-vm-run-44666921454/');
    const text = row.join(' ');
    expect(text).toContain('f6a71cab4ab1dbc06a986f05cb7affd7a844a98e');
    expect(rowOf('history/').join(' ')).toContain('44656249868');
  });
});

describe('docs/benchmarks/README.md: the evidence folder, leg by leg', () => {
  const legs = ['none', '8GiB', '6GiB', '5GiB', '2GiB'];
  const run = 'emulated-win-vm-run-44666921454';
  const limit = (l: string) =>
    l === 'none' ? 0 : Number(JSON.parse(read(`${run}/${l}/job-summary.json`)).limitBytes);

  it('has a folder row, an env.txt row and a job-summary.json row for each of the five legs, and nothing else', () => {
    const paths = legsTable.rows.map((r) => unspan(r[0]!));
    expect(paths).toEqual(
      legs.flatMap((l) => [`${run}/${l}/`, `${run}/${l}/env.txt`, `${run}/${l}/job-summary.json`]),
    );
  });

  for (const leg of legs) {
    it(`leg ${leg}: the runner and the Chrome build are the ones of its env.txt, and the limit is the one of its summary`, () => {
      const env = read(`${run}/${leg}/env.txt`);
      const cpu = /^Processor: (.*)$/mu.exec(env)![1]!.trim();
      const chrome = /^Chrome: (.*)$/mu.exec(env)![1]!.trim();
      const row = legsTable.rows.find((r) => unspan(r[0]!) === `${run}/${leg}/`)!;
      expect(row[2], leg).toBe(`${cpu}, Chrome ${chrome}`);
      const bytes = limit(leg);
      if (bytes === 0) {
        expect(row[1]).toContain('no job limit');
        expect(JSON.parse(read(`${run}/${leg}/job-summary.json`)).readBack.equal).toBe(true);
      } else {
        expect(row[1]).toContain(`${bytes.toLocaleString('en-US')} bytes`);
        expect(JSON.parse(read(`${run}/${leg}/job-summary.json`)).limitFlags).toBe('0x2200');
      }
      expect(row[1]!.includes('control'), leg).toBe(leg === '2GiB');
      expect(JSON.parse(read(`${run}/${leg}/job-summary.json`)).controlLeg, leg).toBe(
        leg === '2GiB',
      );
    });
  }
});

describe('docs/benchmarks/README.md: the standing lines and the folder links', () => {
  const text = flat(indexText);

  it('says the Mac is one Apple M5 Pro with 48 GB', () => {
    expect(text).toContain('Every Mac figure is from one machine, an Apple M5 Pro with 48 GB.');
  });

  it('says the Windows files are emulated on a GitHub-hosted VM under a job commit limit and are not a laptop', () => {
    expect(text).toContain(
      'The Windows files are emulated: one GitHub-hosted Windows Server VM with 4 vCPU and 16 GB RAM, with the pwsh, node and Chrome process tree under a job commit limit. They are not a laptop.',
    );
  });

  it('says nothing is measured on an 8 GB laptop and the 8 GB done-when stays not met', () => {
    expect(text).toContain('Nothing is measured on an 8 GB laptop.');
    expect(text).toContain('the 8 GB Windows done-when stays NOT met');
  });

  it('has a Reproduce section with the dispatch of bench-windows and the bench:e2e command, and both are used by the table', () => {
    expect(text).toContain('npm run bench:e2e');
    expect(text).toContain('gh workflow run bench-windows.yml --repo AirplaneMode-Labs/dockit');
    for (const r of filesTable.rows) {
      const reproduce = r[column(filesTable, 'Reproduce')]!;
      expect(reproduce, r[0]).toMatch(/bench:e2e|R1|R2|bench-windows|As /u);
    }
  });

  it('is linked from the README Benchmarks section', () => {
    const readme = norm(readFileSync(join(root, 'README.md'), 'utf8'));
    const bench = /^## Benchmarks\n([\s\S]*?)(?=^## )/mu.exec(readme)?.[1] ?? '';
    expect(bench).toContain('](docs/benchmarks/README.md)');
  });

  it('is linked from the demo footer as a plain link to the GitHub folder, in an element that already held text', () => {
    const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8');
    const footer = /<footer className="foot">([\s\S]*?)<\/footer>/u.exec(app)?.[1] ?? '';
    expect(footer).toContain(
      'href="https://github.com/AirplaneMode-Labs/dockit/tree/main/docs/benchmarks"',
    );
    expect(footer).toMatch(/Raw benchmark results/u);
    expect(footer).toContain('dockit on GitHub');
  });
});

describe('docs/benchmarks/README.md: figures quoted without a committed raw row', () => {
  const MARK = 'raw data not kept';
  const WINDOW = 1500;
  const status = (r: string[]) => r[2]!;

  it('has the figures of the audit: one row for each quote, from three files of the repository', () => {
    expect(quotedTable.header).toEqual(['File', 'Quoted (verbatim)', 'Status']);
    expect(quotedTable.rows.length).toBeGreaterThanOrEqual(14);
    expect(new Set(quotedTable.rows.map((r) => unspan(r[0]!)))).toEqual(
      new Set(['README.md', 'CHANGELOG.md', 'scripts/win/README.md']),
    );
  });

  for (const [i, r] of quotedTable.rows.entries()) {
    const file = unspan(r[0]!);
    const quote = flat(r[1]!);
    it(`row ${i + 1} (${file}: ${quote.slice(0, 60)}): is quoted where the index says, with its mark near`, () => {
      expect(quote.includes('`'), 'a quote with markup cannot be found verbatim').toBe(false);
      const body = flat(readFileSync(join(root, file), 'utf8'));
      const at = body.indexOf(quote);
      expect(at, `the quote is no longer in ${file}`).toBeGreaterThanOrEqual(0);
      expect(body.indexOf(quote, at + 1), `the quote is ambiguous in ${file}`).toBe(-1);
      const near = body.slice(Math.max(0, at - WINDOW), at + quote.length + WINDOW);
      const s = status(r);
      if (s.startsWith(MARK)) {
        expect(near.toLowerCase(), `${file}: no "${MARK}" near the quote`).toContain(MARK);
      } else if (s.startsWith('row: ')) {
        const target = spans(s)[0]!;
        expect(existsSync(join(dir, target)), `${target} is not a file here`).toBe(true);
        expect(near, `${file}: no mention of ${target} near the quote`).toContain(
          target.split('/').at(-1)!,
        );
      } else if (s.startsWith('git history: ')) {
        const sha = spans(s)[0]!;
        expect(sha).toMatch(/^[0-9a-f]{7,12}$/u);
        expect(near, `${file}: no mention of ${sha} near the quote`).toContain(sha);
      } else {
        throw new Error(
          `row ${i + 1}: the status must start with "${MARK}", "row: " or "git history: "`,
        );
      }
    });
  }

  it('a figure that gains a committed row can leave the table: nothing here is exempt from being found in its file', () => {
    // the 2,241 MiB row: the figure is a row, so the test follows it to the CSV
    const row = quotedTable.rows.find((r) => r[1]!.includes('2,241 MiB'))!;
    expect(row).toBeDefined();
    const rows = parseCsv(read('e2e.csv'));
    for (const r of rows)
      expect(Math.round(Number(r['wasm_memory_peak_bytes']) / 1048576)).toBe(2241);
  });

  it('the CHANGELOG correction: 87 to 107 MB was not what the rows say (91.6 to 106.8 MB), and the files say 92 to 107 MB now', () => {
    const rows = parseCsv(read('e2e-emulated-win-vm.csv')).filter(
      (r) => r['job_commit_limit_bytes'] !== '',
    );
    const held = new Set<number>();
    for (const r of rows) {
      if (r['job_peak_after_probe_bytes'] === '') continue;
      held.add(
        Number(r['job_peak_after_probe_bytes']) -
          Number(r['job_commit_limit_bytes']) -
          256 * 1048576,
      );
    }
    expect(held.size).toBe(4);
    expect(Math.round(Math.min(...held) / 1e6)).toBe(92);
    expect(Math.round(Math.max(...held) / 1e6)).toBe(107);
    for (const f of ['CHANGELOG.md', 'scripts/win/README.md']) {
      const body = flat(readFileSync(join(root, f), 'utf8'));
      expect(body, f).not.toContain('plus 87 to 107 MB');
      expect(body, f).toContain('plus 92 to 107 MB');
    }
  });
});
