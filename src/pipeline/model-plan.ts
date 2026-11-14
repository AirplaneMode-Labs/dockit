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

/**
 * What runtime reported landing (D1's LANDED.json files, 'green' only). The worker landed in Sprint 3 and is
 * still green in Sprint 4. WebLLM is cut from Sprint 4 (team decision TD-08, 14 Nov 2026): it is not in any
 * label or chain rung, and appears only as WEBLLM_NOT_YET in the not-yet box. The default is the conservative
 * wording; set a flag to true only when LANDED.json marks it green (test/pipeline.test.ts compares this constant
 * with that file). Display only: dockit imports no engine.
 */
export interface RuntimeLanded {
  worker: boolean;
}

export const RUNTIME_LANDED: RuntimeLanded = { worker: true };

/** The only WebLLM wording in dockit: a not-yet, never a claim. */
export const WEBLLM_NOT_YET = 'a WebLLM rung (cut from Sprint 4)';

export function chainLabels(l: RuntimeLanded): { webgpu: string; wasm: string } {
  const w = l.worker ? ', engine in a worker' : '';
  return {
    webgpu: `WebGPU: Transformers.js q4f16${w}`,
    wasm: `WebAssembly: Transformers.js q8${w}`,
  };
}

export function chainSentence(l: RuntimeLanded): string {
  const head = l.worker
    ? 'runtime 0.2.0-alpha.1 runs the engine in a worker'
    : 'runtime 0.2.0-alpha.1';
  return `${head}, tested with small test models only; dockit loads nothing until Sprint 5.`;
}

const LABELS = chainLabels(RUNTIME_LANDED);

export const CHAIN_SENTENCE: string = chainSentence(RUNTIME_LANDED);

export const CHAIN: readonly { id: RungId; label: string }[] = [
  { id: 'webgpu', label: LABELS.webgpu },
  { id: 'wasm', label: LABELS.wasm },
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
