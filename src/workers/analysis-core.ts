import type { WorkerGate } from '../pipeline/gate.ts';
import { judgeStreams, type StreamLimitReason, type StreamLimits } from '../pipeline/streams.ts';

/**
 * The logic of the analysis worker, free of any worker global so it is unit-tested on three OSes: pagetriage (structure
 * of a PDF) and glyphsift (score of a text) are handed in as already-initialised WASM modules.
 */

export type AnalysisRequest =
  | { v: 1; id: number; type: 'triage'; bytes: ArrayBuffer }
  | { v: 1; id: number; type: 'gate'; texts: string[] };

export type AnalysisResponse =
  /** `bytes` is the request's own buffer, handed back (transferred by the worker script): what was judged is what comes home. */
  | {
      v: 1;
      id: number;
      type: 'triage';
      report: unknown;
      peakWasmBytes: number | null;
      bytes: ArrayBuffer;
    }
  | { v: 1; id: number; type: 'gate'; results: (WorkerGate | null)[] }
  /** S1-107: the stream accounting refused the file (a limit). The structure was never analysed; pdf.js never starts. */
  | {
      v: 1;
      id: number;
      type: 'streams_refused';
      reason: StreamLimitReason;
      limits: StreamLimits;
      peakWasmBytes: number | null;
    }
  /** S1-107: the accounting threw, trapped, answered 'unaccounted' or answered another shape: the structure could not be checked safely. */
  | { v: 1; id: number; type: 'streams_unchecked'; peakWasmBytes: number | null }
  | { v: 1; id: number; type: 'error'; code: 'corrupt' };

export interface WasmModules {
  pagetriage: {
    /**
     * S1-107: pagetriage.account_pdf_streams(bytes, opts_json): the canonical JSON of schema pagetriage.streams/0.1. dockit always passes
     * `undefined` for the options, so only the compiled-in limits apply. It throws (JsError) for a failure; a panic or a trap throws too.
     */
    account_pdf_streams(bytes: Uint8Array, opts: string | undefined): string;
    analyse_pdf_structure(bytes: Uint8Array, opts: string | undefined): string;
    /** memory.buffer.byteLength of the module, or null when it is not exposed. */
    memoryBytes(): number | null;
  };
  glyphsift: {
    /** gate(text) -> the JSON of spec glyphsift.gate/0.1 (the default threshold). Throws TypeError for an ill-formed string. */
    gate(text: string): string;
    memoryBytes(): number | null;
  };
}

/** One gate() call, parsed and checked against the documented shape. Anything else (a throw, other JSON) is null: never a pass. */
function parseGate(gs: WasmModules['glyphsift'], text: string): WorkerGate | null {
  try {
    const j = JSON.parse(gs.gate(text)) as {
      verdict?: unknown;
      ppm?: unknown;
      threshold_ppm?: unknown;
    };
    const verdict = j.verdict;
    if (verdict !== 'pass' && verdict !== 'hold' && verdict !== 'not_scored') return null;
    if (typeof j.threshold_ppm !== 'number' || !Number.isInteger(j.threshold_ppm)) return null;
    if (verdict === 'not_scored')
      return j.ppm === null ? { verdict, ppm: null, threshold: j.threshold_ppm } : null;
    if (typeof j.ppm !== 'number' || !Number.isInteger(j.ppm)) return null;
    return { verdict, ppm: j.ppm, threshold: j.threshold_ppm };
  } catch {
    return null; // an ill-formed string (TypeError), over 4 MiB, or a reply that is not JSON
  }
}

export function createAnalysisCore(mods: WasmModules) {
  let peak: number | null = 0;
  let unavailable = false;
  const sample = (): void => {
    const a = mods.pagetriage.memoryBytes();
    const b = mods.glyphsift.memoryBytes();
    if (a === null || b === null) {
      unavailable = true;
      return;
    }
    peak = Math.max(peak ?? 0, a + b);
  };
  const err = (id: number): AnalysisResponse => ({ v: 1, id, type: 'error', code: 'corrupt' });

  return {
    async handle(req: AnalysisRequest): Promise<AnalysisResponse> {
      const id = (req as { id?: unknown })?.id;
      if (req === null || typeof req !== 'object' || req.v !== 1 || typeof id !== 'number')
        return err(typeof id === 'number' ? id : 0);
      if (req.type === 'triage') {
        if (!(req.bytes instanceof ArrayBuffer)) return err(req.id);
        // S1-107: every stream of the file is counted before anything reads the document further, with no options (TD-70, TD-85)
        let verdict: ReturnType<typeof judgeStreams>;
        try {
          verdict = judgeStreams(
            mods.pagetriage.account_pdf_streams(new Uint8Array(req.bytes), undefined),
          );
        } catch {
          verdict = { verdict: 'refuse', kind: 'unchecked', unaccounted: false }; // a JsError, a panic or a trap: the instance is not asked again
        }
        // An encrypted file cannot be counted (its streams are ciphertext), so the accounting says 'unaccounted' for it. It keeps its own plain
        // refusal, as in Sprint 5: pagetriage's structure report says whether it is encrypted, and the pipeline's routing refuses it before pdf.js
        // starts. Only a clean 'unaccounted' answer is followed up; a throw or a trap never is. Every other unaccounted file stays unchecked.
        if (verdict.verdict === 'refuse' && verdict.kind === 'unchecked' && verdict.unaccounted) {
          try {
            const json = mods.pagetriage.analyse_pdf_structure(
              new Uint8Array(req.bytes),
              undefined,
            );
            const report = JSON.parse(json) as { structure?: { encrypted?: unknown } };
            if (report?.structure?.encrypted === true) {
              sample();
              return {
                v: 1,
                id: req.id,
                type: 'triage',
                report,
                peakWasmBytes: unavailable ? null : peak,
                bytes: req.bytes,
              };
            }
          } catch {
            // not encrypted, or not readable: refused as unchecked below
          }
        }
        if (verdict.verdict === 'refuse') {
          sample(); // the worker's WebAssembly memory after the accounting of a file that is refused
          const peakWasmBytes = unavailable ? null : peak;
          return verdict.kind === 'limit'
            ? {
                v: 1,
                id: req.id,
                type: 'streams_refused',
                reason: verdict.reason,
                limits: verdict.limits,
                peakWasmBytes,
              }
            : { v: 1, id: req.id, type: 'streams_unchecked', peakWasmBytes };
        }
        try {
          const json = mods.pagetriage.analyse_pdf_structure(new Uint8Array(req.bytes), undefined);
          sample();
          return {
            v: 1,
            id: req.id,
            type: 'triage',
            report: JSON.parse(json),
            peakWasmBytes: unavailable ? null : peak,
            bytes: req.bytes,
          };
        } catch {
          return err(req.id);
        }
      }
      if (req.type === 'gate') {
        if (!Array.isArray(req.texts) || !req.texts.every((t) => typeof t === 'string'))
          return err(req.id);
        const results = req.texts.map((t) => parseGate(mods.glyphsift, t));
        sample();
        return { v: 1, id: req.id, type: 'gate', results };
      }
      return err((req as { id: number }).id);
    },
  };
}
