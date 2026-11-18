// The only main-thread importer of pdfjs-dist. It loads the library lazily (a separate chunk) and never renders.
import type { PdfJsLike } from './pdf-extract.ts';

export async function loadPdfJs(): Promise<PdfJsLike> {
  const lib = await import('pdfjs-dist/build/pdf.mjs');
  return lib as unknown as PdfJsLike;
}
