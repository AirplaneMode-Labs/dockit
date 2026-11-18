import { describe, expect, it } from 'vitest';
import { Refusal, UNPACK_LIMIT_MESSAGE } from '../../src/pipeline/reasons.ts';
import { routePages } from '../../src/pipeline/route.ts';

type State =
  'native_text' | 'raster_only' | 'invisible_ocr_under_image' | 'mixed' | 'vector_only' | 'empty';
const page = (index: number, state: State | null, reliable: boolean | null = true) => ({
  index,
  text_layer: state === null ? null : { state, reliable, confidence: 0.9, evidence: [] },
});
const report = (pages: ReturnType<typeof page>[], encrypted = false, pageCount = pages.length) => ({
  schema: 'pagetriage.structure/0.1',
  degraded: false,
  document: {
    pages: pageCount,
    sha256: 'x',
    source: 'pdf',
    producer: null,
    incremental_updates: null,
  },
  structure: { encrypted },
  pages,
  warnings: [],
});

describe('route stage: pages are routed by pagetriage text_layer.state', () => {
  it('native_text with reliable true or null is extracted', () => {
    const r = routePages(report([page(0, 'native_text', true), page(1, 'native_text', null)]));
    expect(r.pages.map((p) => [p.page, p.action, p.flag])).toEqual([
      [1, 'extract', null],
      [2, 'extract', null],
    ]);
    expect(r.extract).toEqual([1, 2]);
  });

  it('invisible_ocr_under_image and mixed are extracted and flagged', () => {
    const r = routePages(
      report([page(0, 'invisible_ocr_under_image'), page(1, 'mixed'), page(2, 'native_text')]),
    );
    expect(r.pages.map((p) => [p.action, p.flag])).toEqual([
      ['extract', 'invisible_ocr_under_image'],
      ['extract', 'mixed'],
      ['extract', null],
    ]);
  });

  it('raster_only, vector_only and empty are ocr_not_yet and not extracted', () => {
    const r = routePages(
      report([
        page(0, 'raster_only'),
        page(1, 'vector_only'),
        page(2, 'empty'),
        page(3, 'native_text'),
      ]),
    );
    expect(r.pages.map((p) => [p.action, p.reason])).toEqual([
      ['skip', 'ocr_not_yet'],
      ['skip', 'ocr_not_yet'],
      ['skip', 'ocr_not_yet'],
      ['extract', null],
    ]);
    expect(r.extract).toEqual([4]);
  });

  it('a null text_layer is not_analysed; native_text with reliable false is legacy_encoding', () => {
    const r = routePages(
      report([page(0, null), page(1, 'native_text', false), page(2, 'native_text')]),
    );
    expect(r.pages.map((p) => p.reason)).toEqual(['not_analysed', 'legacy_encoding', null]);
    expect(r.extract).toEqual([3]);
  });

  it('zero extractable pages is a no_text_layer refusal that keeps the per-page reasons', () => {
    try {
      routePages(report([page(0, 'raster_only'), page(1, 'empty')]));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Refusal);
      expect((e as Refusal).reason).toBe('no_text_layer');
      expect((e as Refusal).message).toBe(
        'This PDF has no text layer (it looks scanned). OCR is not yet supported.',
      );
      expect((e as Refusal).detail).toMatchObject({
        pages: [
          { page: 1, reason: 'ocr_not_yet' },
          { page: 2, reason: 'ocr_not_yet' },
        ],
      });
    }
  });

  it('an encrypted document is refused before any page is routed', () => {
    expect(() => routePages(report([page(0, 'native_text')], true))).toThrowError(
      expect.objectContaining({ reason: 'encrypted' }),
    );
  });

  it('more than 300 pages is too_many_pages, using the document page count', () => {
    expect(() => routePages(report([page(0, 'native_text')], false, 301))).toThrowError(
      expect.objectContaining({ reason: 'too_many_pages' }),
    );
    expect(() => routePages(report([page(0, 'native_text')], false, 300))).not.toThrow();
  });

  it('a report that does not look like a structure report is corrupt', () => {
    expect(() => routePages({} as never)).toThrowError(
      expect.objectContaining({ reason: 'corrupt' }),
    );
    expect(() => routePages({ pages: 'x', document: {}, structure: {} } as never)).toThrowError(
      expect.objectContaining({ reason: 'corrupt' }),
    );
  });

  // BUG-T1-S5-09: a page cut short by a stream limit looks like an empty page (no_text_layer, 'it looks scanned'),
  // which is the wrong thing to tell the user about a hostile or oversize file.
  describe('a page cut short by a stream limit is too_large, not no_text_layer (BUG-T1-S5-09)', () => {
    const truncatedPage = (index: number, state: State = 'empty', notes: string[] = []) => ({
      index,
      text_layer: { state, reliable: true, confidence: 0.9, evidence: [] },
      features: { truncated: true },
      notes,
    });
    const refusal = (r: unknown) => {
      try {
        routePages(r as never);
      } catch (e) {
        return e as Refusal;
      }
      return undefined;
    };

    it('the decompression-bomb shape (one empty page whose features.truncated is true) is too_large with the plain message', () => {
      const r = refusal({
        ...report([
          truncatedPage(0, 'empty', ['a content stream exceeds the decompression limit']),
        ]),
        degraded: true,
      });
      expect(r).toBeInstanceOf(Refusal);
      expect(r!.reason).toBe('too_large');
      expect(r!.message).toBe(
        'A part of this PDF is larger than dockit will unpack, so it was not read.',
      );
      expect(r!.message).toBe(UNPACK_LIMIT_MESSAGE);
      expect(r!.message).not.toMatch(/scanned|OCR|20 MiB/);
    });

    it('one truncated page among readable native_text pages refuses the whole document', () => {
      const r = refusal(report([page(0, 'native_text'), truncatedPage(1, 'native_text')]));
      expect(r?.reason).toBe('too_large');
    });

    it('a page note that names the decompression limit or the byte budget is enough, even without features', () => {
      for (const note of [
        'a content stream exceeds the decompression limit',
        'content byte budget exhausted; page content cut short',
        'document content budget exhausted',
      ]) {
        const p = { ...page(0, 'raster_only'), notes: ['unrelated', note] };
        expect(refusal(report([page(1, 'native_text'), p]))?.reason, note).toBe('too_large');
      }
    });

    it('a warning that names the document-wide content budget or a page tree cut short is too_large', () => {
      for (const w of [
        'document-wide content budget exhausted; later pages may be incomplete',
        'page tree cut short at 100000 pages or depth 48',
      ]) {
        const r = refusal({ ...report([page(0, 'native_text')]), degraded: true, warnings: [w] });
        expect(r?.reason, w).toBe('too_large');
      }
    });

    it('too_many_pages and encrypted keep precedence over a truncated page', () => {
      expect(refusal(report([truncatedPage(0)], true))?.reason).toBe('encrypted');
      expect(refusal(report([truncatedPage(0)], false, 301))?.reason).toBe('too_many_pages');
    });

    it('a document that is merely degraded (a repaired cross-reference table) is still routed, not refused', () => {
      const r = routePages({
        ...report([page(0, 'native_text')]),
        degraded: true,
        warnings: ['the cross-reference data was damaged and was repaired (Rebuilt)'],
      } as never);
      expect(r.extract).toEqual([1]);
    });

    it('features.truncated false or absent, and ordinary notes, never refuse', () => {
      const p = {
        ...page(0, 'native_text'),
        features: { truncated: false },
        notes: ['page box missing or empty; US Letter assumed'],
      };
      expect(routePages(report([p]) as never).extract).toEqual([1]);
    });

    it('a scanned page that is not truncated is still no_text_layer (the scanned-PDF refusal is unchanged)', () => {
      const r = refusal(report([page(0, 'raster_only')]));
      expect(r?.reason).toBe('no_text_layer');
    });
  });
});
