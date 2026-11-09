import type { ExtractionResult, GlyphGateResult } from '../types.ts';

/**
 * Stub: the glyphsift validator lands in Sprint 2 and is wired here in Sprint 5. Until
 * then the gate passes everything and reports cleanFraction null so nobody mistakes it for
 * a measurement.
 */
export async function glyphGateStage(extract: ExtractionResult): Promise<GlyphGateResult> {
  return {
    stage: 'glyphGate',
    stub: true,
    passed: true,
    cleanFraction: null,
    chunks: extract.chunks,
  };
}
