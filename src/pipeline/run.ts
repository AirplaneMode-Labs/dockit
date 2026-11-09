import type { BackendAdapter } from '../contracts/backend-adapter.ts';
import type { EventSink } from '../contracts/event.ts';
import type { StorageApi } from '../contracts/storage-api.ts';
import { newEvent } from './events.ts';
import { MemoryStore } from './memory-store.ts';
import { MockAdapter } from './mock-adapter.ts';
import { answerStage } from './stages/answer.ts';
import { extractStage } from './stages/extract.ts';
import { glyphGateStage } from './stages/glyphGate.ts';
import { pdfStage } from './stages/pdf.ts';
import { storeStage } from './stages/store.ts';
import { triageStage } from './stages/triage.ts';
import type {
  PipelineInput,
  PipelineResult,
  StageName,
  StageRecord,
  StageResult,
} from './types.ts';

export const STAGE_ORDER: readonly StageName[] = [
  'pdf',
  'triage',
  'extract',
  'glyphGate',
  'store',
  'answer',
];

export const EVENT_SOURCE = 'dockit';

export interface RunOptions {
  events?: EventSink;
  store?: StorageApi;
  adapter?: BackendAdapter;
  documentId?: string;
  now?: () => number;
}

/**
 * Composes the six stage stubs in order and emits Event-schema events for each. Event attrs
 * carry counts and flags only: never the question, the file name or any text.
 */
export async function runPipeline(
  input: PipelineInput,
  opts: RunOptions = {},
): Promise<PipelineResult> {
  const now = opts.now ?? (() => performance.now());
  const events = opts.events ?? { emit: () => {} };
  const store = opts.store ?? new MemoryStore();
  const adapter = opts.adapter ?? new MockAdapter();
  const documentId = opts.documentId ?? crypto.randomUUID();
  const stages: StageRecord[] = [];

  events.emit(
    newEvent({
      source: EVENT_SOURCE,
      kind: 'log',
      name: 'pipeline.start',
      level: 'info',
      bytes: input.file.size,
      attrs: { placeholder: true, stages: STAGE_ORDER.length },
    }),
  );

  const started = now();
  async function step<T extends StageResult>(stage: StageName, fn: () => Promise<T>): Promise<T> {
    const t0 = now();
    const result = await fn();
    const durationMs = now() - t0;
    stages.push({ stage, durationMs, result });
    events.emit(
      newEvent({
        source: EVENT_SOURCE,
        kind: 'timing',
        name: `pipeline.stage.${stage.toLowerCase()}`,
        level: 'debug',
        durationMs,
        attrs: { stage, stub: result.stub },
      }),
    );
    return result;
  }

  const pdf = await step('pdf', () => pdfStage(input));
  const triage = await step('triage', () => triageStage(pdf));
  const extract = await step('extract', () => extractStage(triage));
  const gate = await step('glyphGate', () => glyphGateStage(extract));
  const stored = await step('store', () => storeStage(gate, { store, documentId }));

  if (adapter instanceof MockAdapter) {
    await adapter.load(MockAdapter.placeholderEntry(), MockAdapter.placeholderLoadOptions());
  }
  const answer = await step('answer', () =>
    answerStage(stored, { adapter, question: input.question }),
  );

  events.emit(
    newEvent({
      source: EVENT_SOURCE,
      kind: 'timing',
      name: 'pipeline.complete',
      level: 'info',
      durationMs: now() - started,
      attrs: { placeholder: true, chunks: gate.chunks.length, gatePassed: gate.passed },
    }),
  );

  return { placeholder: true, stages, answer };
}
