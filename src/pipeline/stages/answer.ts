import type { BackendAdapter } from '../../contracts/backend-adapter.ts';
import type { AnswerResult, StoreResult } from '../types.ts';

export const PLACEHOLDER_PREFIX = 'placeholder:';

export interface AnswerDeps {
  adapter: BackendAdapter;
  question: string;
}

/**
 * Stub: asks the injected adapter (the MockAdapter in Sprint 1) and prefixes the answer so
 * it can never be mistaken for a real one. Retrieval over stored chunks arrives in Sprint 5.
 */
export async function answerStage(stored: StoreResult, deps: AnswerDeps): Promise<AnswerResult> {
  const result = await deps.adapter.generate([
    {
      role: 'system',
      content: `No model is loaded. ${stored.stored} record(s) in ${stored.namespace}.`,
    },
    { role: 'user', content: deps.question },
  ]);
  return {
    stage: 'answer',
    stub: true,
    answer: `${PLACEHOLDER_PREFIX} ${result.text}`,
    finishReason: result.finishReason,
    timings: result.timings,
  };
}
