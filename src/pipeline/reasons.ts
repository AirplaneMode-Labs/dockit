/** The pipeline's vocabulary: stages, reasons and the plain-language message for each reason. */

import {
  PIPELINE_REASONS,
  PIPELINE_STAGES,
  type PipelineReason,
  type PipelineStage,
} from '../contracts/event.ts';

// One source of truth: the vendored contract (spec release 0.6.0, event 0.1.5).
export { PIPELINE_REASONS, PIPELINE_STAGES };
export type { PipelineReason, PipelineStage };

export const REFUSAL_MESSAGES: Record<PipelineReason, string> = {
  not_pdf: 'This file is not a PDF.',
  too_large: 'This file is larger than 20 MiB, so dockit did not read it.',
  too_many_pages: 'This PDF has more than 300 pages. This demo stops at 300.',
  encrypted: 'This PDF is password-protected. dockit does not open protected files.',
  corrupt: 'This PDF could not be read. It looks damaged.',
  no_text_layer: 'This PDF has no text layer (it looks scanned). OCR is not yet supported.',
  timeout: 'Reading this PDF took longer than 60 seconds and was stopped.',
  model_not_cached: 'The model is not downloaded on this device. Connect once and press Download.',
  manifest_refused: 'The model files were refused: their signed list did not check out.',
  integrity: 'A model file did not match its recorded hash and was not used.',
  unsupported_profile: 'This browser or device does not meet the minimum for the demo model.',
  context_overflow: 'The retrieved passages did not fit the model even after dropping some.',
  no_index: 'There is no index for this document yet. Choose a PDF first.',
  ocr_not_yet: 'This page is an image only. OCR is not yet supported, so it was skipped.',
  legacy_encoding:
    'The text of this page uses a legacy font encoding and cannot be read reliably, so it was skipped.',
  not_analysed: 'This page could not be analysed, so it was skipped.',
  held_low_score: 'This passage was held back by the glyph gate and is not searched.',
  framed: 'dockit does not run inside another page. Open it directly.',
  // B1: an allocation failure in the engine (backend adapter R18). What the engine said is never shown or logged.
  out_of_memory:
    'The browser ran out of memory while running the model, so the answer was stopped. Close other tabs and try again; this device may not have enough memory for the demo model.',
  // S1-107: pagetriage's stream accounting refused the file before pdf.js ran. The sentence for the actual part comes from streams.ts.
  stream_limit:
    'This PDF holds a part that unpacks to more than dockit will open, so it was refused before it was opened.',
};

/**
 * BUG-T1-S5-09: shown when pagetriage reports that a page was cut short by a stream or content limit (a decompression bomb, an oversize
 * content stream). It is a too_large refusal with this message, not the 20 MiB one and not 'it looks scanned'.
 */
export const UNPACK_LIMIT_MESSAGE =
  'A part of this PDF is larger than dockit will unpack, so it was not read.';

/** A refusal: the pipeline stopped (or skipped something) for a documented reason; the message is plain language. */
export class Refusal extends Error {
  override name = 'Refusal';
  readonly reason: PipelineReason;
  readonly detail: Record<string, unknown> | undefined;
  constructor(reason: PipelineReason, message?: string, detail?: Record<string, unknown>) {
    super(message ?? REFUSAL_MESSAGES[reason]);
    this.reason = reason;
    this.detail = detail;
  }
}

export const isRefusal = (e: unknown): e is Refusal =>
  e instanceof Refusal || (e instanceof Error && e.name === 'Refusal');
