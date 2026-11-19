import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply, memoryComparison, table } from '../scripts/bench-readme.mjs';

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
          (l.startsWith('| ') &&
            !l.startsWith('| Machine') &&
            !l.startsWith('| Run ') &&
            !l.startsWith('|---')),
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

// B1 (TD-66, TD-77): the README states the before and after, from the two CSV pairs, with the outcome of the target worded as reached or missed
describe('README memory comparison: before (e2e-s6-baseline*.csv) and after (e2e*.csv)', () => {
  const E2E_HEAD =
    'date,machine,chrome,commit,run,restart,pdf,pages,chunks,held,triage_ms,extract_ms,gate_ms,embed_ms,index_ms,retrieve_ms,first_token_ms,total_ms,out_tokens,tokens_per_s,js_heap_peak_bytes,wasm_memory_peak_bytes,process_rss_peak_bytes,storage_usage_bytes,requests_after_offline,model,backend,answer_ok,laptop_8gb';
  const Q_HEAD =
    'date,machine,commit,run,restart,qid,answer_ok,correct_source_page,top_retrieved_page_ok,first_token_ms,total_ms,laptop_8gb';
  const MiB = 1048576;
  const e2eRow = (run: number, restart: boolean, rssMiB: number, commit: string) =>
    `2026-11-19T00:00:00.000Z,Apple M5 Pro 48 GB,Chrome/157.0,${commit},${run},${restart},policy-3p.pdf,3,3,0,1,1,1,1,1,1,7000,9000,10,5,${11 * MiB},${2574 * MiB},${rssMiB * MiB},1,0,m,b,true,not measured on 8 GB`;
  const set = (rss: number[], commit: string, totalMs: number, questionsOk: boolean) => {
    const e2e = [
      E2E_HEAD,
      ...rss.map((m, i) => e2eRow(i + 1, false, m, commit)),
      e2eRow(rss.length + 1, true, rss[0]!, commit),
    ].join('\n');
    const qids = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];
    const q = [Q_HEAD];
    for (let run = 1; run <= rss.length + 1; run++)
      for (const id of qids) {
        const answerable = id !== 'q7';
        const ok = questionsOk || !['q2', 'q3', 'q4'].includes(id);
        q.push(
          `2026-11-19T00:00:00.000Z,Apple M5 Pro 48 GB,${commit},${run},${run > rss.length},${id},${ok},${answerable ? ok : ''},${answerable ? 'true' : ''},5000,${totalMs},not measured on 8 GB`,
        );
      }
    return { e2e, q: q.join('\n') };
  };
  const before = set([6300, 6310, 6320, 6330, 6340], 'aaaaaaaaaaaa', 9400, true);

  it('states the before and after median and worst peak in MiB, and says the target was reached when the median is at or under 5,120 MiB', () => {
    const after = set([5000, 5010, 5020, 5030, 5040], 'bbbbbbbbbbbb-dirty', 10200, true);
    const t = memoryComparison(before.e2e, before.q, after.e2e, after.q);
    expect(t).toContain('| Before');
    expect(t).toContain('| After');
    expect(t).toContain('6,320 MiB / 6,340 MiB');
    expect(t).toContain('5,020 MiB / 5,040 MiB');
    expect(t).toContain('5,120 MiB');
    expect(t).toContain('The median peak went from 6,320 MiB to 5,020 MiB');
    expect(t).toContain('The target was reached for memory');
    expect(t).toContain('10,200 ms');
    expect(t).toContain('the time guard was reached');
    for (const r of t.split('\n').filter((l) => /^\| (Before|After)/.test(l)))
      expect(r.trimEnd().endsWith('| not measured on 8 GB |')).toBe(true);
    expect(t).not.toMatch(/\bmet\b|free RAM/);
  });

  it('says the target was missed when the median is over 5,120 MiB, and that the question set or the time guard fell short when it did', () => {
    const after = set([5300, 5310, 5320, 5330, 5340], 'bbbbbbbbbbbb', 13000, false);
    const t = memoryComparison(before.e2e, before.q, after.e2e, after.q);
    expect(t).toContain('The target was missed for memory');
    expect(t).toContain('the time guard was missed');
    expect(t).toMatch(/question set was worse than the floor/);
  });

  it('refuses a CSV whose 8 GB column is not the phrase', () => {
    const after = set([5000, 5010, 5020, 5030, 5040], 'bbbbbbbbbbbb', 10000, true);
    expect(() =>
      memoryComparison(
        before.e2e.replaceAll('not measured on 8 GB', 'x'),
        before.q,
        after.e2e,
        after.q,
      ),
    ).toThrow(/laptop_8gb/);
  });

  it('the README block holds it, built from docs/benchmarks/*.csv, and the repository holds both CSV pairs', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const block = readme.slice(
      readme.indexOf('<!-- bench:start -->'),
      readme.indexOf('<!-- bench:end -->'),
    );
    expect(block).toContain('Memory hardening, before and after');
    expect(block).toMatch(/\| Before[^\n]*\| not measured on 8 GB \|/);
    expect(block).toMatch(/\| After[^\n]*\| not measured on 8 GB \|/);
    expect(block).toMatch(/The target was (reached|missed) for memory/);
    for (const f of [
      'e2e-s6-baseline.csv',
      'e2e-questions-s6-baseline.csv',
      'e2e.csv',
      'e2e-questions.csv',
    ])
      expect(readFileSync(join(root, 'docs', 'benchmarks', f), 'utf8').length).toBeGreaterThan(500);
    const base = readFileSync(join(root, 'docs', 'benchmarks', 'e2e-s6-baseline.csv'), 'utf8')
      .trim()
      .split('\n');
    const head = base[0]!.split(',');
    expect(
      base.slice(1).filter((l) => l.split(',')[head.indexOf('restart')] === 'false').length,
    ).toBeGreaterThanOrEqual(5);
    for (const l of base.slice(1)) {
      expect(l.split(',')[head.indexOf('requests_after_offline')]).toBe('0');
      expect(l.trimEnd().endsWith(',not measured on 8 GB')).toBe(true);
    }
  });
});
