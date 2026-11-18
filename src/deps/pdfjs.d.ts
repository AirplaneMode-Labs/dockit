// pdfjs-dist 6 ships types for its main entry only; dockit uses two of its build files directly and types what it calls
// in src/workers/pdf-extract.ts (PdfJsLike).
declare module 'pdfjs-dist/build/pdf.mjs' {
  export const getDocument: unknown;
  export const PDFWorker: unknown;
}
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
