import type { ExtractionResult, PageTriageResult } from '../types.ts';

/** Stub: no text layer reading and no OCR yet; source is always 'none'. */
export async function extractStage(_triage: PageTriageResult): Promise<ExtractionResult> {
  return { stage: 'extract', stub: true, source: 'none', chunks: [] };
}
