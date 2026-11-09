/**
 * The planned production model and the backend fallback chain, as typed constants for the
 * "Answer" card. Display only: nothing here loads, downloads or runs a model (inference is
 * Sprint 5). Sizes and the source revision are the values recorded in runtime/docs/model-choice.md.
 */

/** True: runtime's local Hindi smoke run (D1-09, reviewed by S1) loaded the model once. Display only; dockit loads nothing. */
export const MODEL_LOADED_IN_BROWSER = true;

export const MODEL_PLAN = {
  name: 'Qwen3-1.7B',
  licence: 'Apache-2.0',
  webgpu: { dtype: 'q4f16', bytes: 1_426_069_098 },
  wasm: { dtype: 'q8', bytes: 1_742_387_852 },
  source: 'onnx-community/Qwen3-1.7B-ONNX@3231b522c6e7',
  contingency: 'Qwen3-0.6B',
} as const;

const BASE_CARD =
  'Planned production model: Qwen3-1.7B (Apache-2.0), WebGPU q4f16 1.43 GB, WASM q8 1.74 GB. Provisional until the Sprint 5 measurement on an 8 GB laptop; contingency Qwen3-0.6B.';

/** Exact sentence shared with runtime/docs/model-choice.md and the Sprint 2 write-up. */
export const MODEL_SMOKE_SENTENCE =
  'Loaded once in a browser: a local, unscored WebGPU smoke run of five synthetic Hindi prompts on an Apple-silicon Mac, which needed ONNX Runtime graph optimisation turned off (evidence/sprint-2/D1/hindi-smoke.json).';

export const MODEL_CARD_TEXT: string = MODEL_LOADED_IN_BROWSER
  ? `${BASE_CARD} Status: ${MODEL_SMOKE_SENTENCE}`
  : BASE_CARD;

export type RungId = 'webgpu' | 'wasm' | 'builtin' | 'refuse';

export const CHAIN: readonly { id: RungId; label: string }[] = [
  { id: 'webgpu', label: 'WebGPU (Transformers.js, q4f16)' },
  { id: 'wasm', label: 'WebAssembly (Transformers.js, q8)' },
  { id: 'builtin', label: 'Chrome built-in model (opt-in, outside the verified chain)' },
  { id: 'refuse', label: 'Refuse with a plain-language reason; nothing is downloaded silently' },
];

export const PREDICTION_LABEL =
  'prediction; nothing is downloaded or loaded; inference arrives in Sprint 5';

export interface PredictionEnv {
  gpu: { requestAdapter(): Promise<unknown> } | undefined;
  /** typeof WebAssembly */
  webAssembly: string;
  /** globalThis, or a stand-in; only the presence of 'LanguageModel' is checked. */
  globals: Record<string, unknown>;
}

export interface Prediction {
  webgpu: boolean;
  wasm: boolean;
  builtinPresent: boolean;
}

export function browserEnv(): PredictionEnv {
  return {
    gpu: (navigator as Navigator & { gpu?: PredictionEnv['gpu'] }).gpu,
    webAssembly: typeof WebAssembly,
    globals: globalThis as unknown as Record<string, unknown>,
  };
}

/**
 * Feature-detection prediction. The adapter object is reduced to a boolean immediately: its info
 * is never read, displayed or stored. LanguageModel is checked with `in` only; availability() and
 * create() are never called (create() can start a third-party model download).
 */
export async function predictBackends(env: PredictionEnv): Promise<Prediction> {
  let webgpu = false;
  if (env.gpu !== undefined) {
    try {
      webgpu = (await env.gpu.requestAdapter()) != null;
    } catch {
      webgpu = false;
    }
  }
  return {
    webgpu,
    wasm: env.webAssembly === 'object',
    builtinPresent: 'LanguageModel' in env.globals,
  };
}
