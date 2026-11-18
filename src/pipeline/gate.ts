import type { Chunk } from './chunk.ts';

/** glyphsift's own default threshold (docs/gate.md, DEFAULT_GATE_THRESHOLD_PPM): the worker passes none, so this is the one applied. */
export const DEFAULT_GATE_THRESHOLD_PPM = 975_000;

/** What glyphsift gate() said about one text (spec glyphsift.gate/0.1), reduced to what dockit uses. */
export interface WorkerGate {
  verdict: 'pass' | 'hold' | 'not_scored';
  /** The chunk's score, 1,000,000 is clean; null when the gate has nothing to say (script other or none). */
  ppm: number | null;
  threshold: number;
}

export type GateVerdict =
  | { verdict: 'pass'; scored: true; ppm: number; threshold: number; message: string }
  | { verdict: 'pass'; scored: false; note: 'not_scored'; threshold: number; message: string }
  | {
      verdict: 'hold';
      scored: true;
      reason: 'held_low_score';
      ppm: number;
      threshold: number;
      message: string;
    };

export interface GatedChunk extends Chunk {
  /** At most 8 primitive keys: stored with the chunk as the storage API's `gate` meta. */
  gate: Record<string, string | number | boolean>;
}

export interface GateResult {
  verdicts: (GateVerdict & { ordinal: number })[];
  kept: GatedChunk[];
  held: number;
}

/**
 * Applies the gate's answers: pass is kept, hold is reported with its ppm and threshold and never indexed, not_scored passes
 * marked 'not_scored'. A null answer (the gate refused the text or failed) is treated as not_scored: the chunk is kept and the
 * mark says it was not scored. `results` has one entry per chunk, in order.
 */
export function gateChunks(chunks: Chunk[], results: readonly (WorkerGate | null)[]): GateResult {
  if (results.length !== chunks.length)
    throw new RangeError('gateChunks needs one gate result per chunk');
  const verdicts: GateResult['verdicts'] = [];
  const kept: GatedChunk[] = [];
  chunks.forEach((c, i) => {
    const r = results[i] ?? null;
    let v: GateVerdict;
    if (r === null || r.verdict === 'not_scored' || r.ppm === null) {
      const threshold = r?.threshold ?? DEFAULT_GATE_THRESHOLD_PPM;
      v = {
        verdict: 'pass',
        scored: false,
        note: 'not_scored',
        threshold,
        message: 'Passed without a score (not_scored).',
      };
    } else if (r.verdict === 'hold') {
      v = {
        verdict: 'hold',
        scored: true,
        reason: 'held_low_score',
        ppm: r.ppm,
        threshold: r.threshold,
        message: `Held back: score ${r.ppm} ppm is below the threshold ${r.threshold} ppm.`,
      };
    } else {
      v = {
        verdict: 'pass',
        scored: true,
        ppm: r.ppm,
        threshold: r.threshold,
        message: `Passed: score ${r.ppm} ppm is at or above the threshold ${r.threshold} ppm.`,
      };
    }
    verdicts.push({ ...v, ordinal: c.ordinal });
    if (v.verdict === 'pass') {
      const gate: GatedChunk['gate'] = v.scored
        ? { verdict: 'pass', scored: true, ppm: v.ppm, threshold: v.threshold }
        : { verdict: 'not_scored', scored: false, threshold: v.threshold, note: 'not_scored' };
      kept.push({ ...c, gate });
    }
  });
  return { verdicts, kept, held: verdicts.length - kept.length };
}
