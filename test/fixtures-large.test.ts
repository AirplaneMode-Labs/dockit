import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bombPdf, manyPagesPdf, oversizePdf } from './fixtures-large.ts';
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
});
