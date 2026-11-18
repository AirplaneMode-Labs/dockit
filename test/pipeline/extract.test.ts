import { describe, expect, it, vi } from 'vitest';
import { extractPdfText, type PdfJsLike } from '../../src/workers/pdf-extract.ts';
import { DOC_UNITS_MAX, PAGE_UNITS_MAX } from '../../src/pipeline/limits.ts';

interface FakeOpts {
  pages?: Record<number, { str: string; hasEOL?: boolean }[]>;
  numPages?: number;
  failWith?: { name: string; message?: string };
  askPassword?: boolean;
  hang?: boolean;
  textFails?: number[];
}

/** A fake pdfjs-dist: records the getDocument params, the worker port and which methods were called. */
function fakePdfJs(o: FakeOpts = {}) {
  const calls = {
    getDocument: [] as Record<string, unknown>[],
    fromPort: [] as unknown[],
    destroyed: 0,
    methods: new Set<string>(),
    updatePassword: vi.fn(),
  };
  const lib: PdfJsLike = {
    PDFWorker: {
      create: ({ port }) => {
        calls.fromPort.push(port);
        return { destroy() {} };
      },
    },
    getDocument(params) {
      calls.getDocument.push(params);
      const task: any = {
        onPassword: undefined as
          undefined | ((update: (pw: string) => void, reason: number) => void),
        destroy: vi.fn(async () => {
          calls.destroyed++;
        }),
      };
      task.promise = (async () => {
        await Promise.resolve(); // the caller assigns onPassword right after getDocument returns
        if (o.askPassword) {
          task.onPassword?.(calls.updatePassword, 1);
          return new Promise(() => {});
        }
        if (o.hang) return new Promise(() => {});
        if (o.failWith) {
          const e = new Error(o.failWith.message ?? 'x');
          e.name = o.failWith.name;
          throw e;
        }
        const numPages = o.numPages ?? Object.keys(o.pages ?? {}).length;
        return {
          numPages,
          getPage: async (n: number) => {
            calls.methods.add('getPage');
            return {
              getTextContent: async () => {
                calls.methods.add('getTextContent');
                if (o.textFails?.includes(n)) throw new Error('bad page');
                return { items: o.pages?.[n] ?? [] };
              },
              cleanup() {},
            };
          },
          destroy: async () => {
            calls.destroyed++;
          },
        };
      })();
      return task;
    },
  };
  return { lib, calls };
}

const makeWorker = () => {
  const worker = { terminate: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  return worker;
};

const run = (
  o: FakeOpts,
  over: Partial<Parameters<typeof extractPdfText>[0]> = {},
  pagesWanted = [1],
) => {
  const f = fakePdfJs(o);
  const worker = makeWorker();
  const started = vi.fn(() => worker);
  const p = extractPdfText({
    lib: f.lib,
    startWorker: started as never,
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    pages: pagesWanted,
    assetBase: 'https://example.invalid/dockit/pdfjs/',
    timeoutMs: 60_000,
    ...over,
  });
  return { p, f, worker, started };
};

describe('pdf extraction (pdfjs-dist, hardened)', () => {
  it('passes the exact hardening options to getDocument, supplies data and a fromPort worker, and never a url', async () => {
    const { p, f, worker } = run({ pages: { 1: [{ str: 'Hello' }] } });
    await p;
    const params = f.calls.getDocument[0]!;
    expect(params).toMatchObject({
      isEvalSupported: false,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      isOffscreenCanvasSupported: false,
      cMapUrl: 'https://example.invalid/dockit/pdfjs/cmaps/',
      standardFontDataUrl: 'https://example.invalid/dockit/pdfjs/standard_fonts/',
    });
    expect(params['cMapPacked']).toBe(true);
    expect(params['data']).toBeInstanceOf(Uint8Array);
    expect('url' in params).toBe(false);
    expect('password' in params).toBe(false);
    expect(f.calls.fromPort).toEqual([worker]);
  });

  it('falls back to PDFWorker.fromPort where an older pdfjs-dist has no create', async () => {
    const f = fakePdfJs({ pages: { 1: [{ str: 'Hello' }] } });
    const ports: unknown[] = [];
    f.lib.PDFWorker = { fromPort: ({ port }) => (ports.push(port), { destroy() {} }) };
    const worker = makeWorker();
    await extractPdfText({
      lib: f.lib,
      startWorker: (() => worker) as never,
      bytes: new Uint8Array(4),
      pages: [1],
      assetBase: 'https://e.invalid/p/',
      timeoutMs: 1000,
    });
    expect(ports).toEqual([worker]);
  });

  it('calls only getPage and getTextContent: never render, getAnnotations, getOperatorList, saveDocument or getJavaScript', async () => {
    const { p, f } = run({ pages: { 1: [{ str: 'x' }] } });
    await p;
    expect([...f.calls.methods].sort()).toEqual(['getPage', 'getTextContent']);
  });

  it('joins text items, keeps line ends, then NFC-normalises and collapses whitespace', async () => {
    const { p } = run({
      pages: {
        1: [
          { str: 'The grace', hasEOL: false },
          { str: '  period  ', hasEOL: true },
          { str: 'é', hasEOL: false },
        ],
      },
    });
    const r = await p;
    expect(r.pages).toEqual([{ page: 1, text: 'The grace period\né' }]);
  });

  it('extracts only the requested pages, in order, with their real numbers', async () => {
    const { p } = run(
      { numPages: 5, pages: { 2: [{ str: 'two' }], 4: [{ str: 'four' }], 1: [{ str: 'one' }] } },
      {},
      [2, 4],
    );
    expect((await p).pages).toEqual([
      { page: 2, text: 'two' },
      { page: 4, text: 'four' },
    ]);
  });

  it('terminates the fresh worker and destroys the loading task after a successful extraction', async () => {
    const { p, worker, f } = run({ pages: { 1: [{ str: 'x' }] } });
    await p;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(f.calls.destroyed).toBeGreaterThanOrEqual(1);
  });

  it('starts one fresh worker per call', async () => {
    const f = fakePdfJs({ pages: { 1: [{ str: 'x' }] } });
    const starts: unknown[] = [];
    const startWorker = () => {
      const w = makeWorker();
      starts.push(w);
      return w as never;
    };
    const base = {
      lib: f.lib,
      startWorker,
      bytes: new Uint8Array(4),
      pages: [1],
      assetBase: 'https://e.invalid/p/',
      timeoutMs: 1000,
    };
    await extractPdfText(base);
    await extractPdfText(base);
    expect(starts).toHaveLength(2);
    expect(starts[0]).not.toBe(starts[1]);
  });

  it('an onPassword request is refused at once as encrypted and the password callback is never answered', async () => {
    const { p, f, worker } = run({ askPassword: true });
    await expect(p).rejects.toMatchObject({ reason: 'encrypted' });
    expect(f.calls.updatePassword).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('PasswordException is encrypted; InvalidPDFException, FormatError and other failures are corrupt', async () => {
    await expect(run({ failWith: { name: 'PasswordException' } }).p).rejects.toMatchObject({
      reason: 'encrypted',
    });
    await expect(run({ failWith: { name: 'InvalidPDFException' } }).p).rejects.toMatchObject({
      reason: 'corrupt',
    });
    await expect(run({ failWith: { name: 'FormatError' } }).p).rejects.toMatchObject({
      reason: 'corrupt',
    });
    await expect(run({ failWith: { name: 'Error', message: 'anything' } }).p).rejects.toMatchObject(
      { reason: 'corrupt' },
    );
  });

  it('a page whose text cannot be read is skipped as not_analysed, the rest still extracted', async () => {
    const { p } = run({ numPages: 2, pages: { 2: [{ str: 'two' }] }, textFails: [1] }, {}, [1, 2]);
    const r = await p;
    expect(r.pages).toEqual([{ page: 2, text: 'two' }]);
    expect(r.skipped).toEqual([{ page: 1, reason: 'not_analysed' }]);
  });

  it('a hung extraction is stopped at the timeout: the worker is terminated and the reason is timeout', async () => {
    vi.useFakeTimers();
    try {
      const { p, worker } = run({ hang: true }, { timeoutMs: 60_000 });
      const assertion = expect(p).rejects.toMatchObject({ reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(60_001);
      await assertion;
      expect(worker.terminate).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a worker 'error' or 'messageerror' event is corrupt and the worker is terminated", async () => {
    for (const type of ['error', 'messageerror']) {
      const f = fakePdfJs({ hang: true });
      const listeners = new Map<string, (e: unknown) => void>();
      const worker = {
        terminate: vi.fn(),
        addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
        removeEventListener: vi.fn(),
      };
      const p = extractPdfText({
        lib: f.lib,
        startWorker: (() => worker) as never,
        bytes: new Uint8Array(4),
        pages: [1],
        assetBase: 'https://e.invalid/p/',
        timeoutMs: 60_000,
      });
      await Promise.resolve();
      listeners.get(type)!({});
      await expect(p).rejects.toMatchObject({ reason: 'corrupt' });
      expect(worker.terminate).toHaveBeenCalled();
    }
  });

  it('caps a page at 200,000 units and the document at 2,000,000, re-checked here on the main thread', async () => {
    const big = 'x'.repeat(PAGE_UNITS_MAX + 5000);
    const { p } = run({ numPages: 1, pages: { 1: [{ str: big }] } });
    const r = await p;
    expect(r.pages[0]!.text.length).toBe(PAGE_UNITS_MAX);
    expect(r.truncated).toBe(true);

    const pages: Record<number, { str: string }[]> = {};
    const want: number[] = [];
    for (let i = 1; i <= 12; i++) {
      pages[i] = [{ str: `${i}`.repeat(PAGE_UNITS_MAX) }];
      want.push(i);
    }
    const r2 = await run({ numPages: 12, pages }, {}, want).p;
    const total = r2.pages.reduce((n, x) => n + x.text.length, 0);
    expect(total).toBeLessThanOrEqual(DOC_UNITS_MAX);
    expect(r2.pages.length).toBe(10);
    expect(r2.truncated).toBe(true);
  });

  it('never leaves globalThis.pdfjsWorker defined (no main-thread fake worker)', async () => {
    await run({ pages: { 1: [{ str: 'x' }] } }).p;
    expect((globalThis as { pdfjsWorker?: unknown }).pdfjsWorker).toBeUndefined();
  });
});
