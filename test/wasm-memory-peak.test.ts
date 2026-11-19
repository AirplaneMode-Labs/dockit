import { describe, expect, it } from 'vitest';
import { wasmMemoryPeak } from '../scripts/lib/e2e-harness.mjs';

// B1: wasm_memory_peak_bytes is the most WebAssembly memory the workers held AT ONCE. Sprint 5 added the peaks of every engine and the analysis worker because
// they all lived together; with one model at a time (a model.unload for each model.load) that sum would count each load of 15 in a run as if they coexisted
// (18,331 MiB in the first after-run). The figure is therefore the peak of the memory of the workers that are alive together.
const MiB = 1048576;
const mem = (loadId: string, mib: number) => ({
  name: 'model.memory',
  attrs: { loadId, measure: 'wasm-memory', phase: 'load' },
  bytes: mib * MiB,
});
const unload = (loadId: string) => ({ name: 'model.unload', attrs: { loadId } });
const analysis = (mib: number) => ({
  name: 'pipeline.memory',
  attrs: { worker: 'analysis', stage: 'triage', measure: 'wasm-memory' },
  bytes: mib * MiB,
});

describe('wasm_memory_peak_bytes: the peak of the workers alive together', () => {
  it('Sprint 5 events (no model.unload): both engines and the analysis worker live together, so their peaks add up, as before', () => {
    const ev = [mem('a', 1000), mem('b', 1300), mem('a', 1200), analysis(74)];
    expect(wasmMemoryPeak(ev)).toBe((1200 + 1300 + 74) * MiB);
  });

  it('one engine at a time: each load is unloaded before the next, so the peak is the largest single engine, never the sum of the loads', () => {
    const ev = [
      mem('e1', 400),
      unload('e1'),
      analysis(74),
      mem('e2', 400),
      mem('g1', 1300),
      unload('g1'),
      mem('e3', 400),
      unload('e3'),
    ];
    // e2 is never unloaded in this list: it is alive while g1 loads, so the two coexist
    expect(wasmMemoryPeak(ev)).toBe((400 + 1300) * MiB);
    const sequential = [
      mem('e1', 400),
      unload('e1'),
      mem('g1', 1300),
      unload('g1'),
      mem('e2', 400),
      unload('e2'),
      analysis(74),
    ];
    expect(wasmMemoryPeak(sequential)).toBe(1300 * MiB);
  });

  it('15 sequential loads in a run give the largest one, not 15 times it', () => {
    const ev: object[] = [];
    for (let i = 0; i < 15; i++) ev.push(mem(`l${i}`, i % 2 === 0 ? 1300 : 400), unload(`l${i}`));
    ev.push(analysis(74));
    expect(wasmMemoryPeak(ev)).toBe(1300 * MiB);
  });

  it('the analysis worker can be the largest thing alive: the peak is then its own', () => {
    expect(wasmMemoryPeak([mem('e1', 40), unload('e1'), analysis(74)])).toBe(74 * MiB);
  });

  it('two engines that overlap (the second loads before the first unloads) add up while they overlap', () => {
    expect(
      wasmMemoryPeak([mem('a', 500), mem('b', 700), unload('a'), unload('b'), analysis(10)]),
    ).toBe(1200 * MiB);
  });

  it('a figure that cannot be measured is null: never estimated', () => {
    expect(
      wasmMemoryPeak([
        { name: 'model.memory', attrs: { loadId: 'a', measure: 'unavailable' } },
        analysis(1),
      ]),
    ).toBeNull();
    expect(wasmMemoryPeak([analysis(1)])).toBeNull(); // no engine measured
    expect(wasmMemoryPeak([mem('a', 1)])).toBeNull(); // no analysis worker measured
    expect(wasmMemoryPeak([])).toBeNull();
  });
});
