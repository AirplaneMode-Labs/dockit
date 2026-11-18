import type { WorkerGate } from '../pipeline/gate.ts';

/**
 * The logic of the analysis worker, free of any worker global so it is unit-tested on three OSes: pagetriage (structure
 * of a PDF) and glyphsift (score of a text) are handed in as already-initialised WASM modules.
 */

export type AnalysisRequest =
  | { v: 1; id: number; type: 'triage'; bytes: ArrayBuffer }
  | { v: 1; id: number; type: 'gate'; texts: string[] };

export type AnalysisResponse =
  | { v: 1; id: number; type: 'triage'; report: unknown; peakWasmBytes: number | null }
  | { v: 1; id: number; type: 'gate'; results: (WorkerGate | null)[] }
  | { v: 1; id: number; type: 'error'; code: 'corrupt' };

export interface WasmModules {
  pagetriage: {
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
        try {
          const json = mods.pagetriage.analyse_pdf_structure(new Uint8Array(req.bytes), undefined);
          sample();
          return {
            v: 1,
            id: req.id,
            type: 'triage',
            report: JSON.parse(json),
            peakWasmBytes: unavailable ? null : peak,
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
