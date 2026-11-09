import type { PdfResult, PipelineInput } from '../types.ts';

/**
 * Stub: real page count arrives with the pagetriage wasm in Sprint 5.
 * The blob's bytes are not inspected; only its size and declared media type are recorded.
 */
export async function pdfStage(input: PipelineInput): Promise<PdfResult> {
  return {
    stage: 'pdf',
    stub: true,
    bytes: input.file.size,
    mediaType: input.file.type || 'application/octet-stream',
    pageCount: 'unknown',
  };
}
