import { normaliseText } from '../pipeline/chunk.ts';
import { DOC_UNITS_MAX, PAGE_UNITS_MAX, PDF_TIMEOUT_MS } from '../pipeline/limits.ts';
import { Refusal } from '../pipeline/reasons.ts';

/** The slice of pdfjs-dist this module uses. The real library is loaded by pdf-loader.ts; tests pass a fake. */
export interface PdfJsLike {
  PDFWorker: {
    /** pdfjs-dist 6: PDFWorker.create({ port }). */
    create?(params: { port: unknown }): { destroy(): void };
    /** pdfjs-dist 4 and 5 named it fromPort; used when create does not exist. */
    fromPort?(params: { port: unknown }): { destroy(): void };
  };
  getDocument(params: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }>;
        cleanup?(): void;
      }>;
      destroy?(): Promise<void>;
    }>;
    onPassword: unknown;
    destroy(): Promise<void>;
  };
}

export interface WorkerLike {
  /** What pdf.js talks to: the Worker itself (PDFWorker.fromPort). Absent in tests, where the object is its own port. */
  port?: unknown;
  terminate(): void;
  addEventListener(type: string, listener: (e: unknown) => void): void;
  removeEventListener(type: string, listener: (e: unknown) => void): void;
}

export interface ExtractOptions {
  lib: PdfJsLike;
  /** Starts a FRESH pdf worker (runtime startModuleWorker with the 'dockit-workers' policy); one per document. */
  startWorker: () => WorkerLike;
  bytes: Uint8Array;
  /** 1-based page numbers to read, ascending. */
  pages: number[];
  /** Absolute URL ending in '/', under which cmaps/ and standard_fonts/ live (the egress guard allows only this prefix). */
  assetBase: string;
  timeoutMs?: number;
}

export interface ExtractResult {
  pages: { page: number; text: string }[];
  skipped: { page: number; reason: 'not_analysed' }[];
  /** A page or the document hit its cap and was cut short. */
  truncated: boolean;
}

const safeSlice = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
};

/**
 * Reads the text layer of the requested pages with a hardened pdf.js (D5-05 stage 3). A fresh worker per document,
 * terminated afterwards or at the timeout. Only getPage and getTextContent are called. An onPassword request is
 * refused at once and the password callback is never answered.
 */
export async function extractPdfText(opts: ExtractOptions): Promise<ExtractResult> {
  const { lib, bytes, pages, assetBase } = opts;
  const timeoutMs = opts.timeoutMs ?? PDF_TIMEOUT_MS;
  const worker = opts.startWorker();
  let pdfWorker: { destroy(): void } | undefined;
  let task: ReturnType<PdfJsLike['getDocument']> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: [string, (e: unknown) => void][] = [];

  const failures = new Promise<never>((_, reject) => {
    const bad = () => reject(new Refusal('corrupt'));
    for (const type of ['error', 'messageerror']) {
      worker.addEventListener(type, bad);
      listeners.push([type, bad]);
    }
    timer = setTimeout(() => reject(new Refusal('timeout')), timeoutMs);
  });
  failures.catch(() => undefined); // never an unhandled rejection when the work wins the race

  const work = (async (): Promise<ExtractResult> => {
    const port = worker.port ?? worker;
    // hand pdf.js the worker we started (the runtime's blob bootstrap, with our CSP and egress guard) as its port: it never starts its own
    const made = lib.PDFWorker.create?.({ port }) ?? lib.PDFWorker.fromPort?.({ port });
    if (made === undefined)
      throw new TypeError('this pdfjs-dist has neither PDFWorker.create nor PDFWorker.fromPort');
    pdfWorker = made;
    // pdf.js transfers the buffer to its worker: hand it a copy so the caller's bytes stay usable
    task = lib.getDocument({
      data: bytes.slice(),
      worker: pdfWorker,
      isEvalSupported: false,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      isOffscreenCanvasSupported: false,
      cMapUrl: `${assetBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetBase}standard_fonts/`,
    });
    const loading = task;
    const encrypted = new Promise<never>((_, reject) => {
      // refuse; updatePassword is never called
      loading.onPassword = () => reject(new Refusal('encrypted'));
    });
    encrypted.catch(() => undefined);
    const doc = await Promise.race([loading.promise, encrypted]);
    const out: ExtractResult = { pages: [], skipped: [], truncated: false };
    let total = 0;
    for (const n of pages) {
      let text: string;
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        text = normaliseText(
          content.items.map((i) => (i.str ?? '') + (i.hasEOL === true ? '\n' : '')).join(''),
        );
        page.cleanup?.();
      } catch {
        out.skipped.push({ page: n, reason: 'not_analysed' });
        continue;
      }
      if (text.length > PAGE_UNITS_MAX) {
        text = safeSlice(text, PAGE_UNITS_MAX);
        out.truncated = true;
      }
      if (total + text.length > DOC_UNITS_MAX) {
        out.truncated = true;
        break;
      }
      total += text.length;
      out.pages.push({ page: n, text });
    }
    return out;
  })();

  try {
    return await Promise.race([work, failures]);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    const name = (e as { name?: string } | null)?.name;
    // the cause is the library's own error name and message (never document text); it reaches only the console, for diagnosis
    const cause = `${name ?? 'Error'}: ${(e as { message?: string } | null)?.message ?? ''}`.slice(
      0,
      200,
    );
    throw new Refusal(name === 'PasswordException' ? 'encrypted' : 'corrupt', undefined, { cause });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const [type, fn] of listeners) worker.removeEventListener(type, fn);
    work.catch(() => undefined);
    // Not awaited: task.destroy() waits for an acknowledgement from the worker, which never comes from a hung or
    // already-dead one. The worker is terminated right after, which is what actually frees it.
    try {
      void task?.destroy().catch(() => undefined);
    } catch {
      /* terminated next */
    }
    try {
      pdfWorker?.destroy();
    } catch {
      /* ditto */
    }
    worker.terminate();
  }
}
