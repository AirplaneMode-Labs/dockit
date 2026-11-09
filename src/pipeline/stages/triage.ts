import type { PageTriageResult, PdfResult } from '../types.ts';

/**
 * Stub. TODO(Sprint 5): call the @airplanemode/pagetriage wasm build per page and fill
 * pageKinds with its routing decision (text layer, scan, handwriting, stamp).
 */
export async function triageStage(pdf: PdfResult): Promise<PageTriageResult> {
  return {
    stage: 'triage',
    stub: true,
    pageCount: pdf.pageCount,
    pageKinds: [],
    summary: 'unknown',
  };
}
