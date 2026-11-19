/** The manifest entry ids dockit's loader and its memory line read (the bundle is built by runtime's bundle-models.mjs). */
export const GENERATOR_DESCRIPTOR = 'qwen3-0.6b.descriptor';
export const EMBEDDER_DESCRIPTOR = 'multilingual-e5-small.descriptor';
export const TOKENIZER_ENTRY = 'qwen3-0.6b.tokenizer';
/**
 * The answer model's entry. Its signed minProfile.ramGb is the memory line (TD-67): the threshold is read from the verified manifest, never from
 * a constant in the page. Both engines are refused below it, because the pipeline cannot answer without the answer model.
 */
export const ANSWER_ENTRY_ID = GENERATOR_DESCRIPTOR;

/** The memory line of a verified manifest: minProfile.ramGb of the answer entry, or undefined when there is none. */
export function memoryLineOf(manifest: {
  entries: { id: string; minProfile?: { ramGb?: number } }[];
}): number | undefined {
  const ram = manifest.entries.find((e) => e.id === ANSWER_ENTRY_ID)?.minProfile?.ramGb;
  return typeof ram === 'number' && Number.isFinite(ram) && ram > 0 ? ram : undefined;
}
