import { MAX_PAGES } from './limits.ts';
import { Refusal, UNPACK_LIMIT_MESSAGE, type PipelineReason } from './reasons.ts';

/** The slice of pagetriage's structure report (schema pagetriage.structure/0.1) that routing reads. */
export interface StructureReport {
  /** True when part of the analysis was skipped (limits, encryption, damaged pages). Read together with the evidence below, never alone. */
  degraded?: boolean;
  warnings?: string[];
  document: { pages: number };
  structure: { encrypted: boolean };
  pages: {
    index: number;
    text_layer: { state: string; reliable: boolean | null } | null;
    /** features.truncated: the page's content was cut short by a limit (the figures are lower bounds). */
    features?: { truncated?: boolean } | null;
    notes?: string[];
  }[];
}

/** The pagetriage wording (pdf/mod.rs) for a page or a document cut short by a size or work limit. */
const LIMIT_NOTE = /decompression limit|content byte budget|content budget exhausted/u;
const LIMIT_WARNING = /content budget exhausted|page tree cut short/u;

/**
 * True when the report says a stream or content limit cut the analysis short: a page with features.truncated, a page note naming the
 * decompression limit or a byte budget, or a document warning naming the content budget or a page tree cut short. A report that is only
 * degraded for another reason (for example a repaired cross-reference table) is not a limit and is routed as before.
 */
export function hitStreamLimit(report: StructureReport): boolean {
  if (report.warnings?.some((w) => typeof w === 'string' && LIMIT_WARNING.test(w))) return true;
  return report.pages.some(
    (p) =>
      p.features?.truncated === true ||
      p.notes?.some((n) => typeof n === 'string' && LIMIT_NOTE.test(n)) === true,
  );
}

export type PageFlag = 'invisible_ocr_under_image' | 'mixed' | null;

export interface PageRoute {
  /** 1-based page number. */
  page: number;
  action: 'extract' | 'skip';
  /** Why a page is skipped (null when it is extracted). */
  reason: Extract<PipelineReason, 'ocr_not_yet' | 'legacy_encoding' | 'not_analysed'> | null;
  /** An extracted page whose text layer may be an OCR layer over an image, or may mix text and images. */
  flag: PageFlag;
}

export interface RouteResult {
  pages: PageRoute[];
  /** 1-based numbers of the pages to extract, ascending. */
  extract: number[];
}

/**
 * Routes every page by pagetriage text_layer.state (TD-32: text-layer PDFs only, OCR not yet):
 *   native_text, reliable true or null      extract
 *   invisible_ocr_under_image, mixed        extract, flagged
 *   raster_only, vector_only, empty         ocr_not_yet
 *   no text_layer                           not_analysed
 *   native_text, reliable false             legacy_encoding
 * An encrypted document or more than 300 pages is refused first. A page cut short by a stream limit (hitStreamLimit) refuses the whole
 * document as too_large, with its own message, so a decompression bomb is never reported as a scanned file (BUG-T1-S5-09). Zero
 * extractable pages is no_text_layer.
 */
export function routePages(report: StructureReport): RouteResult {
  if (
    report === null ||
    typeof report !== 'object' ||
    !Array.isArray(report.pages) ||
    typeof report.document !== 'object' ||
    report.document === null ||
    typeof report.structure !== 'object' ||
    report.structure === null
  ) {
    throw new Refusal('corrupt');
  }
  if (report.structure.encrypted === true) throw new Refusal('encrypted');
  const count = Number(report.document.pages);
  if (!Number.isFinite(count)) throw new Refusal('corrupt');
  if (count > MAX_PAGES) throw new Refusal('too_many_pages');
  if (hitStreamLimit(report)) throw new Refusal('too_large', UNPACK_LIMIT_MESSAGE);

  const pages: PageRoute[] = report.pages.map((p) => {
    const page = p.index + 1;
    const layer = p.text_layer;
    if (layer === null || layer === undefined)
      return { page, action: 'skip', reason: 'not_analysed', flag: null };
    switch (layer.state) {
      case 'native_text':
        return layer.reliable === false
          ? { page, action: 'skip', reason: 'legacy_encoding', flag: null }
          : { page, action: 'extract', reason: null, flag: null };
      case 'invisible_ocr_under_image':
      case 'mixed':
        return { page, action: 'extract', reason: null, flag: layer.state };
      case 'raster_only':
      case 'vector_only':
      case 'empty':
        return { page, action: 'skip', reason: 'ocr_not_yet', flag: null };
      default:
        return { page, action: 'skip', reason: 'not_analysed', flag: null };
    }
  });
  const extract = pages.filter((p) => p.action === 'extract').map((p) => p.page);
  if (extract.length === 0) {
    throw new Refusal('no_text_layer', undefined, {
      pages: pages.map((p) => ({ page: p.page, reason: p.reason })),
    });
  }
  return { pages, extract };
}
