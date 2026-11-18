import { describe, expect, it } from 'vitest';
import { buildSourcesPanel, parseCitations } from '../src/pipeline/citations.ts';

const retrieved = [
  {
    id: 'S1',
    docId: 'd',
    ordinal: 3,
    pageStart: 2,
    pageEnd: 2,
    text: 'The grace period for the sample policy is 45 days.',
  },
  {
    id: 'S2',
    docId: 'd',
    ordinal: 4,
    pageStart: 2,
    pageEnd: 3,
    text: 'Claims must be filed within 30 days.',
  },
  {
    id: 'S3',
    docId: 'd',
    ordinal: 0,
    pageStart: 1,
    pageEnd: 1,
    text: 'This sample policy covers a sample vehicle.',
  },
];

describe('citations', () => {
  it('known ids map to the retrieved chunk metadata; the page comes from metadata, not from the answer text', () => {
    const r = parseCitations(
      'The grace period is 45 days [S1]. Page 99 says otherwise [S2].',
      retrieved,
    );
    expect(r.cited.map((c) => [c.id, c.pageStart, c.pageEnd])).toEqual([
      ['S1', 2, 2],
      ['S2', 2, 3],
    ]);
    expect(r.unknownCitations).toBe(0);
  });

  it('a model-invented [S9] is dropped and counted, and shows no page', () => {
    const r = parseCitations('Answer [S9] and [S1] and [S7].', retrieved);
    expect(r.cited.map((c) => c.id)).toEqual(['S1']);
    expect(r.unknownCitations).toBe(2);
    expect(JSON.stringify(r.cited)).not.toMatch(/S9|S7/);
  });

  it('repeats are shown once and not counted as unknown', () => {
    const r = parseCitations('[S1] and again [S1] [S1]', retrieved);
    expect(r.cited).toHaveLength(1);
    expect(r.unknownCitations).toBe(0);
  });

  it('only the exact form [S<digits>] counts; look-alikes do not', () => {
    const r = parseCitations('[s1] (S1) [ S1 ] [S1a] [S01] [S٣]', retrieved);
    expect(r.cited).toEqual([]);
    expect(r.unknownCitations).toBe(1); // [S01] is a digit id the retrieval did not issue
  });

  it('an answer with no citation cites nothing', () => {
    expect(parseCitations('I could not find this in the document.', retrieved)).toEqual({
      cited: [],
      unknownCitations: 0,
    });
  });
});

describe('sources panel', () => {
  it('lists every retrieved chunk from its own metadata, with its page range, its text, and whether the answer cited it', () => {
    const rows = buildSourcesPanel(retrieved, new Set(['S1']));
    expect(rows.map((r) => [r.id, r.pages, r.cited])).toEqual([
      ['S1', '2', true],
      ['S2', '2 to 3', false],
      ['S3', '1', false],
    ]);
    for (const [i, row] of rows.entries()) expect(row.text).toBe(retrieved[i]!.text);
  });

  it('a page shown always contains that chunk: the row text is the chunk text, never answer text', () => {
    const rows = buildSourcesPanel(retrieved, new Set(['S2']));
    expect(rows.every((r, i) => r.text === retrieved[i]!.text)).toBe(true);
  });
});
