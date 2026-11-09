import type { GenerateResult } from '../contracts/backend-adapter.ts';

/** What the app hands to the pipeline. The file bytes are never read beyond their length. */
export interface PipelineInput {
  file: Blob;
  fileName: string;
  question: string;
}

export type StageName = 'pdf' | 'triage' | 'extract' | 'glyphGate' | 'store' | 'answer';

/** Every Sprint 1 result carries `stub: true`; nothing here is a measurement. */
interface StubResult<S extends StageName> {
  stage: S;
  stub: true;
}

export type PageKind = 'text' | 'scan' | 'handwriting' | 'stamp' | 'mixed' | 'unknown';

export interface PdfResult extends StubResult<'pdf'> {
  bytes: number;
  mediaType: string;
  /** 'unknown' until the pagetriage wasm lands in Sprint 5. */
  pageCount: number | 'unknown';
}

export interface PageTriageResult extends StubResult<'triage'> {
  pageCount: number | 'unknown';
  /** One kind per page once pagetriage runs; empty while stubbed. */
  pageKinds: PageKind[];
  summary: 'unknown' | string;
}

export interface TextChunk {
  id: string;
  page: number;
  text: string;
}

export interface ExtractionResult extends StubResult<'extract'> {
  source: 'none' | 'text-layer' | 'ocr';
  chunks: TextChunk[];
}

export interface GlyphGateResult extends StubResult<'glyphGate'> {
  passed: boolean;
  /** Fraction of clean graphemes once glyphsift runs; null while stubbed. */
  cleanFraction: number | null;
  chunks: TextChunk[];
}

export interface StoreResult extends StubResult<'store'> {
  namespace: string;
  documentId: string;
  stored: number;
}

export interface AnswerResult extends StubResult<'answer'> {
  /** Always prefixed 'placeholder:' in Sprint 1. */
  answer: string;
  finishReason: GenerateResult['finishReason'];
  timings: GenerateResult['timings'];
}

export type StageResult =
  PdfResult | PageTriageResult | ExtractionResult | GlyphGateResult | StoreResult | AnswerResult;

export interface StageRecord {
  stage: StageName;
  durationMs: number;
  result: StageResult;
}

export interface PipelineResult {
  placeholder: true;
  stages: StageRecord[];
  answer: AnswerResult;
}
