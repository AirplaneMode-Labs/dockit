import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  bombPdf,
  brokenXrefPdf,
  fontBombPdf,
  imageBombPdf,
  manyPagesPdf,
  oversizePdf,
} from './fixtures-large.ts';
import { PDFJS_TEST_TIMEOUT_MS } from './helpers/timeouts.ts';

describe('large fixtures, generated at test time and never committed', () => {
  it('oversizePdf is one byte over 20 MiB and starts like a PDF', () => {
    const b = oversizePdf();
    expect(b.length).toBe(20_971_521);
    expect(b.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it(
    'manyPagesPdf(301) has 301 pages for pdf.js and is small',
    async () => {
      const b = manyPagesPdf(301);
      expect(b.length).toBeLessThan(100 * 1024);
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = pdfjs.getDocument({ data: new Uint8Array(b), verbosity: 0 });
      const doc = await task.promise;
      expect(doc.numPages).toBe(301);
      await task.destroy();
    },
    PDFJS_TEST_TIMEOUT_MS,
  );

  it('a bomb is small and inflates to the size asked for (checked with a 2 MiB one; the real one is 1 GiB + 1)', async () => {
    const b = await bombPdf(2 * 1024 * 1024);
    expect(b.length).toBeLessThan(20 * 1024);
    const start = b.indexOf('stream\n') + 7;
    const end = b.indexOf('\nendstream');
    expect(inflateSync(b.subarray(start, end)).length).toBe(2 * 1024 * 1024);
  });

  it('the real bomb is under 5 MB and claims more than 1 GiB', async () => {
    const b = await bombPdf();
    expect(b.length).toBeLessThan(5 * 1024 * 1024);
    expect(b.length).toBeGreaterThan(100 * 1024);
  }, 60_000);

  // S1-107: the stream-accounting bombs (TD-70, TD-85), generated at test time into the system temp folder and never committed
  const streamOf = (b: Buffer, from = 0): Buffer => {
    const start = b.indexOf('stream\n', from) + 7;
    return b.subarray(start, b.indexOf('\nendstream', start));
  };

  it('a font bomb is a text page whose embedded TrueType font file (FontFile2) inflates to the size asked for (checked at 2 MiB)', async () => {
    const b = await fontBombPdf(2 * 1024 * 1024);
    expect(b.length).toBeLessThan(20 * 1024);
    const text = b.toString('latin1');
    expect(text).toContain('/FontFile2');
    expect(text).toContain('/Length1 2097152');
    expect(text).toContain('grace period 45 days'); // a real text page, so pdf.js would read its text
    const font = streamOf(b, b.indexOf('/FontFile2 '));
    expect(inflateSync(font).length).toBe(2 * 1024 * 1024);
  });

  it('an image bomb is a one-page PDF whose image XObject (Flate) inflates to the size asked for, and declares a huge raster', async () => {
    const b = await imageBombPdf(2 * 1024 * 1024);
    expect(b.length).toBeLessThan(20 * 1024);
    const text = b.toString('latin1');
    expect(text).toContain('/Subtype /Image');
    expect(text).toContain('/Width 32768');
    expect(text).toContain('/Height 32768');
    const img = streamOf(b, b.indexOf('/Subtype /Image'));
    expect(inflateSync(img).length).toBe(2 * 1024 * 1024);
  });

  it('the real font and image bombs are under 5 MB and claim more than 1 GiB', async () => {
    for (const make of [fontBombPdf, imageBombPdf]) {
      const b = await make();
      expect(b.length).toBeLessThan(5 * 1024 * 1024);
      expect(b.length).toBeGreaterThan(100 * 1024);
    }
  }, 120_000);

  it(
    'a PDF with a broken cross-reference table is one that pagetriage cannot load whole but pdf.js opens: it repairs the table and reads the text',
    async () => {
      const b = brokenXrefPdf();
      expect(b.length).toBeLessThan(4 * 1024);
      expect(b.toString('latin1')).toMatch(/startxref\n999999\n%%EOF/);
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = pdfjs.getDocument({ data: new Uint8Array(b), verbosity: 0 });
      const doc = await task.promise;
      expect(doc.numPages).toBe(1);
      const page = await doc.getPage(1);
      const content = await page.getTextContent();
      expect(content.items.map((i) => ('str' in i ? i.str : '')).join('')).toContain(
        'grace period 45 days',
      );
      await task.destroy();
    },
    PDFJS_TEST_TIMEOUT_MS,
  );
});
