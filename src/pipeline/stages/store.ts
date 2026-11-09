import type { StorageApi } from '../../contracts/storage-api.ts';
import type { GlyphGateResult, StoreResult } from '../types.ts';

export const DOCUMENTS_NAMESPACE = 'dockit.documents';

export interface StoreDeps {
  store: StorageApi;
  documentId: string;
}

/**
 * Writes one document record through the Storage API. The record holds counts only; chunk
 * text would be stored here once extraction exists (Sprint 5).
 */
export async function storeStage(gate: GlyphGateResult, deps: StoreDeps): Promise<StoreResult> {
  await deps.store.set(DOCUMENTS_NAMESPACE, deps.documentId, {
    chunks: gate.chunks.length,
    gatePassed: gate.passed,
    cleanFraction: gate.cleanFraction,
    storedAt: new Date().toISOString(),
  });
  return {
    stage: 'store',
    stub: true,
    namespace: DOCUMENTS_NAMESPACE,
    documentId: deps.documentId,
    stored: 1,
  };
}
