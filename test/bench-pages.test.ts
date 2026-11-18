import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsv, table } from '../scripts/bench-readme.mjs';
import * as cols from '../scripts/lib/bench-columns.mjs';

// BUG-T1-S5-R2-05 (TD-59): correct_source_page is true only when a CITED source shown to the user names the expected page; it is false when
// the model refused or cited nothing. top_retrieved_page_ok is a column of its own: is the top-ranked retrieved passage on the expected page
// (retrieval quality). The headline joint figure keeps its definition: answer_ok AND correct_source_page.
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, 'docs', 'benchmarks', f), 'utf8');

const Q2 = { id: 'q2', expectPage: 2, expectRefusal: false };
const Q7 = { id: 'q7', expectPage: null, expectRefusal: true };
const src = (id: string, pages: string, cited: boolean) => ({ id, pages, cited });
const answer = (ok: boolean, sources: ReturnType<typeof src>[]) => ({ ok, sources });

describe('page checks of one answer (TD-59)', () => {
  it('a refused answer cites nothing: correct_source_page false, even when the top-ranked passage was on the right page', () => {
    const a = answer(true, [src('S1', '2', false), src('S2', '1', false), src('S3', '3', false)]);
    expect(cols.pageChecks(Q2, a)).toEqual({
      correct_source_page: false,
      top_retrieved_page_ok: true,
    });
  });

  it('a cited source on the expected page is true in both columns when the top-ranked one is on that page too', () => {
    const a = answer(true, [src('S1', '2', true), src('S2', '1', false)]);
    expect(cols.pageChecks(Q2, a)).toEqual({
      correct_source_page: true,
      top_retrieved_page_ok: true,
    });
  });

  it('a cited source on the wrong page is false even when the top-ranked passage is right', () => {
    const a = answer(true, [src('S1', '2', false), src('S2', '1', true)]);
    expect(cols.pageChecks(Q2, a)).toEqual({
      correct_source_page: false,
      top_retrieved_page_ok: true,
    });
  });

  it('a cited source on the right page with a top-ranked passage on the wrong page: cited true, retrieval false', () => {
    const a = answer(true, [src('S1', '1', false), src('S2', '2', true)]);
    expect(cols.pageChecks(Q2, a)).toEqual({
      correct_source_page: true,
      top_retrieved_page_ok: false,
    });
  });

  it('any one cited source on the expected page counts, and a range such as 1 to 2 holds page 2', () => {
    expect(
      cols.pageChecks(Q2, answer(true, [src('S1', '3', true), src('S2', '2', true)]))
        .correct_source_page,
    ).toBe(true);
    expect(cols.pageChecks(Q2, answer(true, [src('S1', '1 to 2', true)])).correct_source_page).toBe(
      true,
    );
    expect(
      cols.pageChecks(Q2, answer(true, [src('S1', '2 to 3', false)])).top_retrieved_page_ok,
    ).toBe(true);
    expect(cols.pageChecks(Q2, answer(true, [src('S1', '3 to 4', true)])).correct_source_page).toBe(
      false,
    );
  });

  it('an answer that failed (a refusal card, no sources at all) has false in both', () => {
    expect(cols.pageChecks(Q2, answer(false, []))).toEqual({
      correct_source_page: false,
      top_retrieved_page_ok: false,
    });
    expect(cols.pageChecks(Q2, answer(true, []))).toEqual({
      correct_source_page: false,
      top_retrieved_page_ok: false,
    });
  });

  it('the question with no answer in the document has no page: both columns are blank', () => {
    expect(cols.pageChecks(Q7, answer(true, [src('S1', '2', true)]))).toEqual({
      correct_source_page: '',
      top_retrieved_page_ok: '',
    });
    expect(cols.pageChecks(Q7, answer(false, []))).toEqual({
      correct_source_page: '',
      top_retrieved_page_ok: '',
    });
  });
});

describe('the question CSV and the writer', () => {
  it('Q_COLUMNS puts top_retrieved_page_ok right after correct_source_page, and the committed header equals it', () => {
    const i = cols.Q_COLUMNS.indexOf('correct_source_page');
    expect(cols.Q_COLUMNS[i + 1]).toBe('top_retrieved_page_ok');
    expect(read('e2e-questions.csv').split('\n')[0]).toBe(cols.Q_COLUMNS.join(','));
  });

  it('bench-e2e.mjs takes the page checks from the library: no private rule that credits an uncited top-ranked source', () => {
    const text = readFileSync(join(root, 'scripts', 'bench-e2e.mjs'), 'utf8');
    expect(text).toContain('pageChecks(');
    expect(text).toContain('top_retrieved_page_ok');
    expect(text).not.toMatch(/function correctPage/);
    expect(text).not.toMatch(/a\.sources\.slice\(0, 1\)/);
  });

  it('every committed row has both columns, blank together for the unanswerable question and true or false together otherwise', () => {
    const rows = parseCsv(read('e2e-questions.csv')) as Record<string, string>[];
    expect(rows.length).toBeGreaterThanOrEqual(42);
    for (const r of rows) {
      expect(['true', 'false', ''], r['qid']).toContain(r['correct_source_page']);
      expect(['true', 'false', ''], r['qid']).toContain(r['top_retrieved_page_ok']);
      expect(r['correct_source_page'] === '', `${r['run']} ${r['qid']}`).toBe(
        r['top_retrieved_page_ok'] === '',
      );
      expect(r['qid'] === 'q7', `${r['run']} ${r['qid']}`).toBe(r['correct_source_page'] === '');
    }
  });

  it('a cited page can only be correct for an answer that was given: no row credits a source page while the answer is the refusal (answer_ok false and no cited page is false)', () => {
    // the retrieved-but-uncited case must live in the retrieval column only
    const rows = parseCsv(read('e2e-questions.csv')) as Record<string, string>[];
    const refusedRows = rows.filter(
      (r) => r['answer_ok'] === 'false' && r['correct_source_page'] !== '',
    );
    expect(refusedRows.length).toBeGreaterThan(0); // the measured data does hold refusals (q2 and q6)
    for (const r of refusedRows)
      expect(r['correct_source_page'], `${r['run']} ${r['qid']}`).toBe('false');
  });
});

describe('the README block', () => {
  it('keeps the joint headline and reports the cited-page and retrieval counts separately', () => {
    const block = table(read('e2e.csv'), read('e2e-questions.csv'));
    expect(block).toMatch(/\d+ of \d+ correct with the correct source page on the first run/);
    expect(block).toMatch(/Cited source page correct in \d+ of \d+/);
    expect(block).toMatch(/Top-ranked retrieved passage on the right page in \d+ of \d+/);
    expect(block).toMatch(/a refused answer cites nothing/);
  });

  it('counts a refused row in retrieval only', () => {
    const head = cols.Q_COLUMNS.join(',');
    const row = (qid: string, ok: string, cited: string, top: string) =>
      `2026-11-18T00:00:00.000Z,m,abc,1,false,${qid},${ok},${cited},${top},1,2,not measured on 8 GB`;
    const q = `${head}\n${[row('q1', 'true', 'true', 'true'), row('q2', 'false', 'false', 'true'), row('q7', 'true', '', '')].join('\n')}\n`;
    const e2e = read('e2e.csv');
    const block = table(e2e, q);
    expect(block).toContain('1 of 2 correct with the correct source page on the first run');
    expect(block).toContain('Cited source page correct in 1 of 2');
    expect(block).toContain('Top-ranked retrieved passage on the right page in 2 of 2');
  });
});
