import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATE_THRESHOLD_PPM,
  gateChunks,
  type WorkerGate,
} from '../../src/pipeline/gate.ts';

const chunk = (ordinal: number, text: string) => ({ ordinal, pageStart: 1, pageEnd: 1, text });
const pass = (ppm: number): WorkerGate => ({ verdict: 'pass', ppm, threshold: 975_000 });
const hold = (ppm: number): WorkerGate => ({ verdict: 'hold', ppm, threshold: 975_000 });
const notScored: WorkerGate = { verdict: 'not_scored', ppm: null, threshold: 975_000 };

describe('gate stage (glyphsift gate(), spec glyphsift.gate/0.1, TD-42)', () => {
  it("the default threshold is glyphsift's own, 975000 ppm", () => {
    expect(DEFAULT_GATE_THRESHOLD_PPM).toBe(975_000);
  });

  it('passes what the gate passes and holds what it holds, with ppm and threshold on the hold; held chunks are not kept', () => {
    const r = gateChunks(
      [chunk(0, 'clean'), chunk(1, 'edge'), chunk(2, 'noisy')],
      [pass(1_000_000), pass(975_000), hold(974_999)],
    );
    expect(r.verdicts.map((v) => v.verdict)).toEqual(['pass', 'pass', 'hold']);
    expect(r.verdicts[2]).toMatchObject({
      verdict: 'hold',
      reason: 'held_low_score',
      ppm: 974_999,
      threshold: 975_000,
    });
    expect(r.kept.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(r.held).toBe(1);
  });

  it('a chunk the gate has nothing to say about (not_scored: Latin text, no letters) passes, marked not_scored', () => {
    const r = gateChunks([chunk(0, 'Plain English text.')], [notScored]);
    expect(r.verdicts[0]).toMatchObject({
      verdict: 'pass',
      scored: false,
      note: 'not_scored',
      threshold: 975_000,
    });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.gate).toEqual({
      verdict: 'not_scored',
      scored: false,
      threshold: 975_000,
      note: 'not_scored',
    });
  });

  it('attaches the gate result to every kept chunk as the SDK gate meta: at most 8 keys, primitives only', () => {
    const r = gateChunks([chunk(0, 'a')], [pass(999_999)]);
    const meta = r.kept[0]!.gate;
    expect(Object.keys(meta).length).toBeLessThanOrEqual(8);
    for (const v of Object.values(meta))
      expect(['string', 'number', 'boolean']).toContain(typeof v);
    expect(meta).toEqual({ verdict: 'pass', scored: true, ppm: 999_999, threshold: 975_000 });
  });

  it('describes a hold in plain words with ppm and threshold', () => {
    const r = gateChunks([chunk(0, 'noisy')], [hold(500_000)]);
    expect(r.verdicts[0]!.message).toBe(
      'Held back: score 500000 ppm is below the threshold 975000 ppm.',
    );
  });

  it('a chunk the gate could not be asked about (null: refused or failed) is not_scored, passes, and carries the fact', () => {
    const r = gateChunks([chunk(0, 'x')], [null]);
    expect(r.verdicts[0]).toMatchObject({ verdict: 'pass', scored: false, note: 'not_scored' });
    expect(r.kept[0]!.gate['note']).toBe('not_scored');
  });

  it('a result list that is shorter than the chunk list is a programming error, not a silent pass', () => {
    expect(() => gateChunks([chunk(0, 'a'), chunk(1, 'b')], [pass(1_000_000)])).toThrow(
      /one gate result per chunk/,
    );
  });
});
