import { describe, expect, it } from 'vitest';
import {
  CHUNK_MAX,
  CHUNK_OVERLAP,
  CHUNK_PAGE_BREAK_MIN,
  CHUNK_TARGET,
} from '../src/pipeline/limits.ts';
import { chunkPages, normaliseText } from '../src/pipeline/chunk.ts';

const sentence = (i: number) =>
  `Sentence number ${i} says something about the sample policy and nothing else. `;
const prose = (n: number) => Array.from({ length: n }, (_, i) => sentence(i)).join('');

describe('chunker: constants', () => {
  it('target 700, max 1000, overlap 100', () => {
    expect([CHUNK_TARGET, CHUNK_MAX, CHUNK_OVERLAP]).toEqual([700, 1000, 100]);
  });
});

describe('normaliseText: NFC and collapsed whitespace', () => {
  it('composes to NFC, collapses runs of spaces and tabs, keeps at most one blank line, trims', () => {
    expect(normaliseText('  é  \t x \n\n\n\n y  ')).toBe('é x\n\ny');
  });
  it('keeps U+200C and U+200D (Devanagari needs them)', () => {
    expect(normaliseText('क्‍ष क‌ा')).toBe('क्‍ष क‌ा');
  });
  it('turns CRLF and lone CR into newlines', () => {
    expect(normaliseText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('chunker: shape', () => {
  const pages = [
    { page: 1, text: prose(30) },
    { page: 2, text: prose(30) },
    { page: 3, text: prose(30) },
  ];
  const chunks = chunkPages(pages);

  it('is deterministic', () => {
    expect(chunkPages(pages)).toEqual(chunks);
  });

  it('ordinals are 0..n-1 and every chunk is non-empty and at most 1000 units', () => {
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
    }
  });

  it('a chunk spans at most 2 pages, and its page range is recorded', () => {
    for (const c of chunks) {
      expect(c.pageStart).toBeLessThanOrEqual(c.pageEnd);
      expect(c.pageEnd - c.pageStart).toBeLessThanOrEqual(1);
    }
    expect(chunks[0]!.pageStart).toBe(1);
    expect(chunks.at(-1)!.pageEnd).toBe(3);
  });

  it('chunks reach the 700-unit target, except where a page boundary closes a chunk of at least 200 units', () => {
    for (const [i, c] of chunks.slice(0, -1).entries()) {
      const closedByPage = chunks[i + 1]!.pageStart > c.pageEnd;
      expect(c.text.length).toBeGreaterThanOrEqual(
        closedByPage ? CHUNK_PAGE_BREAK_MIN : CHUNK_TARGET - 100,
      );
    }
  });

  it('consecutive chunks on the same page overlap by up to 100 units of the previous chunk tail', () => {
    let checked = 0;
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i - 1]!.pageEnd !== chunks[i]!.pageStart) continue; // no overlap across a page boundary (see the page-break tests)
      checked++;
      const prev = chunks[i - 1]!.text;
      const cur = chunks[i]!.text;
      // some tail of prev (at most 100 units) starts cur
      let k = Math.min(CHUNK_OVERLAP, prev.length);
      let found = 0;
      for (; k > 0; k--)
        if (cur.startsWith(prev.slice(prev.length - k))) {
          found = k;
          break;
        }
      expect(found, `chunk ${i} does not start with a tail of chunk ${i - 1}`).toBeGreaterThan(0);
      expect(found).toBeLessThanOrEqual(CHUNK_OVERLAP);
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('every sentence of the input appears whole in some chunk (nothing is dropped)', () => {
    const all = chunks.map((c) => c.text).join('\n');
    for (let i = 0; i < 30; i++) expect(all).toContain(sentence(i).trim());
  });

  it('a page boundary is recorded: text only from page 3 starts a chunk whose pageStart is 3 or 2 via overlap', () => {
    const last = chunks.at(-1)!;
    expect(last.pageEnd).toBe(3);
  });
});

describe('chunker: page-precise citations', () => {
  it('constants: a chunk of at least 200 units is closed at a page boundary', () => {
    expect(CHUNK_PAGE_BREAK_MIN).toBe(200);
  });

  it('three short pages of about 300 units give one chunk per page, each citing exactly its own page', () => {
    const page = (n: number) =>
      `Page ${n} fact one is stated here in a plain sentence of its own. Page ${n} fact two follows it, again in one plain sentence. ` +
      `Page ${n} fact three closes the page with a third plain sentence. `.repeat(2);
    const cs = chunkPages([1, 2, 3].map((n) => ({ page: n, text: page(n) })));
    expect(cs.map((c) => [c.pageStart, c.pageEnd])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    for (const [i, c] of cs.entries())
      expect(c.text).not.toContain(`Page ${((i + 1) % 3) + 1} fact`);
  });

  it('a chunk shorter than the minimum is merged with the next page, so tiny pages are not each their own chunk', () => {
    const cs = chunkPages([
      { page: 1, text: 'Short page one.' },
      { page: 2, text: 'Short page two.' },
    ]);
    expect(cs.map((c) => [c.pageStart, c.pageEnd])).toEqual([[1, 2]]);
  });

  it('no overlap is carried across a page boundary: every chunk text lies on the pages it names', () => {
    const pages = [1, 2, 3, 4].map((n) => ({
      page: n,
      text: Array.from(
        { length: 14 },
        (_, i) => `Page ${n} sentence ${i} belongs only to page ${n}. `,
      ).join(''),
    }));
    for (const c of chunkPages(pages)) {
      const pagesSeen = new Set(
        [...c.text.matchAll(/Page (\d) sentence/g)].map((m) => Number(m[1])),
      );
      for (const p of pagesSeen)
        expect(
          p >= c.pageStart && p <= c.pageEnd,
          `${c.pageStart}-${c.pageEnd} cites a text of page ${p}`,
        ).toBe(true);
      expect(pagesSeen.size).toBeGreaterThan(0);
    }
  });
});

describe('chunker: split points', () => {
  it('splits at the Devanagari danda', () => {
    const danda = Array.from(
      { length: 60 },
      (_, i) => `यह वाक्य संख्या ${i} नमूना नीति के बारे में है।`,
    ).join(' ');
    const cs = chunkPages([{ page: 1, text: danda }]);
    expect(cs.length).toBeGreaterThan(1);
    for (const c of cs.slice(0, -1)) expect(c.text.trimEnd().endsWith('।')).toBe(true);
  });

  it('prefers a blank line, then a sentence end, then a newline', () => {
    const para = (n: number) => `${'word '.repeat(60)}end of paragraph ${n}.`;
    const text = Array.from({ length: 8 }, (_, i) => para(i)).join('\n\n');
    const cs = chunkPages([{ page: 1, text }]);
    for (const c of cs.slice(0, -1)) expect(c.text.trimEnd()).toMatch(/paragraph \d\.$/);
  });

  it('a single unbroken run longer than the max is hard-split at the max, never above it', () => {
    const cs = chunkPages([{ page: 4, text: 'x'.repeat(2500) }]);
    expect(cs.length).toBeGreaterThanOrEqual(3);
    for (const c of cs) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
      expect(c.pageStart).toBe(4);
      expect(c.pageEnd).toBe(4);
    }
  });

  it('does not split a surrogate pair at a hard split', () => {
    const cs = chunkPages([{ page: 1, text: '😀'.repeat(900) }]);
    for (const c of cs) expect(c.text.isWellFormed()).toBe(true);
  });

  it('empty and whitespace-only pages produce no chunk; an empty document produces none', () => {
    expect(chunkPages([])).toEqual([]);
    expect(chunkPages([{ page: 1, text: '  \n\n ' }])).toEqual([]);
  });

  it('skips pages with no text and keeps real page numbers (pages 1 and 5)', () => {
    const cs = chunkPages([
      { page: 1, text: 'Alpha beta.' },
      { page: 5, text: 'Gamma delta.' },
    ]);
    expect(cs.map((c) => [c.pageStart, c.pageEnd])).toEqual([[1, 5]]);
  });
});

// BUG-T2-S5-10: pdf.js can emit an unpaired surrogate from a broken ToUnicode map. NFC keeps it, the gate then cannot score the chunk (it
// treats a TypeError as 'not scored'), embed() refuses it (R14) and putDocument() refuses it (invalid_value, text): one bad glyph used to
// end the whole document. The text is made well-formed (U+FFFD) before it is chunked.
describe('well-formed text (BUG-T2-S5-10)', () => {
  const LONE = ['\ud800', '\udc00', '\udbff', '\udfff'];

  it.each(LONE)('normaliseText replaces the unpaired surrogate U+%s with U+FFFD', (c) => {
    const out = normaliseText(`The grace period is 45 days. ${c} broken glyph.`);
    expect(out.isWellFormed()).toBe(true);
    expect(out).toBe('The grace period is 45 days. \ufffd broken glyph.');
  });

  it('a valid surrogate pair is kept; a reversed pair (low then high) is two replacement characters', () => {
    expect(normaliseText('grin \u{1F600} end')).toBe('grin \u{1F600} end');
    expect(normaliseText('x\udc00\ud800y')).toBe('x\ufffd\ufffdy');
  });

  it('every chunk of a page with a lone surrogate is well-formed, and the rest of the text is unchanged', () => {
    const chunks = chunkPages([
      {
        page: 1,
        text: 'The grace period is 45 days. \ud800 broken glyph. Claims are paid within 30 days.',
      },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text.isWellFormed()).toBe(true);
    expect(chunks[0]!.text).toBe(
      'The grace period is 45 days. \ufffd broken glyph. Claims are paid within 30 days.',
    );
  });

  it('lone surrogates sprinkled through a long multi-page text never leave an ill-formed chunk', () => {
    const noisy = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        i % 7 === 3
          ? `${sentence(i)}\ud800\udc00\udc00 `
          : i % 11 === 5
            ? `${sentence(i)}\ud83d `
            : sentence(i),
      ).join('');
    const chunks = chunkPages([
      { page: 1, text: noisy(40) },
      { page: 2, text: noisy(40) },
    ]);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.text.isWellFormed(), `chunk ${c.ordinal}`).toBe(true);
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
    }
  });

  it('ZWJ and ZWNJ in Devanagari text survive chunking untouched next to a lone surrogate', () => {
    const deva = 'क्‍ष क‌ा \udc00 हिन्दी';
    const chunks = chunkPages([{ page: 1, text: deva }]);
    expect(chunks[0]!.text).toBe('क्‍ष क‌ा \ufffd हिन्दी');
    expect(chunks[0]!.text).toContain('\u200d');
    expect(chunks[0]!.text).toContain('\u200c');
  });

  it('text that is already well-formed is returned exactly as before', () => {
    const t = prose(5).trim();
    expect(normaliseText(t)).toBe(t);
  });
});
