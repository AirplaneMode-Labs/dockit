import { describe, expect, it, vi } from 'vitest';
import {
  createAnalysisCore,
  type AnalysisRequest,
  type AnalysisResponse,
} from '../../src/workers/analysis-core.ts';
import { createAnalysisClient } from '../../src/workers/analysis-client.ts';

const REPORT = {
  schema: 'pagetriage.structure/0.1',
  degraded: false,
  document: { pages: 1 },
  structure: { encrypted: false },
  pages: [],
  warnings: [],
};

const LIMITS = {
  font_decoded_max: 33_554_432,
  image_decoded_max: 268_435_456,
  image_raster_max: 268_435_456,
  content_decoded_max: 67_108_864,
  other_decoded_max: 67_108_864,
  total_decoded_max: 536_870_912,
  streams_max: 3_000_000,
};
const streamsJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 'pagetriage.streams/0.1',
    verdict: 'ok',
    reason: '',
    limits: LIMITS,
    streams: {
      count: 1,
      by_kind: {},
      total_decoded_bytes: 0,
      decoded_capped: false,
      early_stop: false,
    },
    notes: [],
    ...over,
  });
const STREAMS_OK = streamsJson();

describe('analysis core (runs inside the analysis worker)', () => {
  const mkCore = (
    over: {
      memBytes?: () => number | null;
      fail?: boolean;
      gate?: (t: string) => string;
      streams?: (bytes: Uint8Array, opts: string | undefined) => string;
      analyse?: (bytes: Uint8Array, opts: string | undefined) => string;
    } = {},
  ) => {
    const calls: { pt: unknown[]; gs: string[]; order: string[]; streamsOpts: unknown[] } = {
      pt: [],
      gs: [],
      order: [],
      streamsOpts: [],
    };
    const core = createAnalysisCore({
      pagetriage: {
        account_pdf_streams: (bytes: Uint8Array, opts: string | undefined) => {
          calls.order.push('streams');
          calls.streamsOpts.push(opts);
          return over.streams ? over.streams(bytes, opts) : STREAMS_OK;
        },
        analyse_pdf_structure: (bytes: Uint8Array, opts: string | undefined) => {
          calls.order.push('analyse');
          calls.pt.push([bytes.byteLength, opts]);
          if (over.fail) throw new Error('not a pdf');
          return over.analyse ? over.analyse(bytes, opts) : JSON.stringify(REPORT);
        },
        memoryBytes: over.memBytes ?? (() => 5_000_000),
      },
      glyphsift: {
        gate: (t: string) => {
          calls.gs.push(t);
          return over.gate
            ? over.gate(t)
            : JSON.stringify({
                spec: 'glyphsift.gate/0.1',
                scored: true,
                script: 'devanagari',
                devanagari_ppm: 1000000,
                ppm: 1000000,
                threshold_ppm: 975000,
                verdict: 'pass',
              });
        },
        memoryBytes: () => 3_000_000,
      },
    });
    return { core, calls };
  };

  it('triage returns the parsed structure report and the peak wasm memory: the sum of the two modules, which the worker holds at once', async () => {
    const { core, calls } = mkCore();
    const r = (await core.handle({
      v: 1,
      id: 7,
      type: 'triage',
      bytes: new Uint8Array(40).buffer,
    })) as Extract<AnalysisResponse, { type: 'triage' }>;
    expect(r).toMatchObject({
      v: 1,
      id: 7,
      type: 'triage',
      report: REPORT,
      peakWasmBytes: 8_000_000,
    });
    expect(calls.pt[0]).toEqual([40, undefined]);
  });

  it('triage gives the very ArrayBuffer back, so the bytes that were judged are the bytes that come home (B1 M3)', async () => {
    const { core } = mkCore();
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const r = (await core.handle({ v: 1, id: 1, type: 'triage', bytes: buffer })) as Extract<
      AnalysisResponse,
      { type: 'triage' }
    >;
    expect(r.bytes).toBe(buffer);
  });

  // S1-107: the stream accounting runs first, with no options, and a refusal stops the triage
  it('triage accounts the streams FIRST, with no options (opts_json is never passed), then analyses the structure', async () => {
    const { core, calls } = mkCore();
    await core.handle({ v: 1, id: 1, type: 'triage', bytes: new Uint8Array(40).buffer });
    expect(calls.order).toEqual(['streams', 'analyse']);
    expect(calls.streamsOpts).toEqual([undefined]);
  });

  it.each([
    'font_over_limit',
    'image_over_limit',
    'content_over_limit',
    'other_over_limit',
    'total_over_limit',
    'too_many_streams',
  ])(
    'a refusal for %s is answered as streams_refused with the reason and the limits, and the structure is never analysed',
    async (reason) => {
      const { core, calls } = mkCore({ streams: () => streamsJson({ verdict: 'refuse', reason }) });
      const r = await core.handle({
        v: 1,
        id: 9,
        type: 'triage',
        bytes: new Uint8Array(40).buffer,
      });
      expect(r).toEqual({
        v: 1,
        id: 9,
        type: 'streams_refused',
        reason,
        limits: LIMITS,
        peakWasmBytes: 8_000_000, // the worker's memory after the accounting (5,000,000 + 3,000,000 in these fakes)
      });
      expect(calls.order).toEqual(['streams']);
    },
  );

  it('a throw (a panic or a trap) and a reply of another shape are streams_unchecked, and the structure is never analysed (a trapped instance is not asked again)', async () => {
    for (const streams of [
      () => {
        throw new Error('RuntimeError: unreachable');
      },
      () => 'not json',
      () => streamsJson({ schema: 'other' }),
      () => streamsJson({ verdict: 'ok', reason: 'font_over_limit' }),
    ]) {
      const { core, calls } = mkCore({ streams });
      const r = await core.handle({
        v: 1,
        id: 4,
        type: 'triage',
        bytes: new Uint8Array(40).buffer,
      });
      expect(r).toMatchObject({ v: 1, id: 4, type: 'streams_unchecked' });
      expect(calls.order).toEqual(['streams']);
    }
  });

  // An encrypted file cannot be counted (its streams are ciphertext), so the accounting says 'unaccounted' for it. It must keep its own plain refusal
  // (password-protected), as in Sprint 5: pagetriage's structure report says encrypted, and the pipeline's routing refuses it. pdf.js never starts.
  it("'unaccounted' for a file that pagetriage's structure report calls encrypted is an ordinary triage response, so the file is refused as encrypted", async () => {
    const encryptedReport = { ...REPORT, structure: { encrypted: true } };
    const { core, calls } = mkCore({
      streams: () => streamsJson({ verdict: 'refuse', reason: 'unaccounted' }),
      analyse: () => JSON.stringify(encryptedReport),
    });
    const r = await core.handle({ v: 1, id: 5, type: 'triage', bytes: new Uint8Array(40).buffer });
    expect(r).toMatchObject({ v: 1, id: 5, type: 'triage', report: encryptedReport });
    expect(calls.order).toEqual(['streams', 'analyse']);
  });

  it("'unaccounted' for any other file (a structure the parser could not load, or one that needed repair) is streams_unchecked, whatever the structure report says", async () => {
    for (const analyse of [
      () => JSON.stringify(REPORT), // not encrypted
      () => {
        throw new Error('not a pdf');
      },
      () => 'not json',
    ]) {
      const { core } = mkCore({
        streams: () => streamsJson({ verdict: 'refuse', reason: 'unaccounted' }),
        analyse,
      });
      const r = await core.handle({
        v: 1,
        id: 6,
        type: 'triage',
        bytes: new Uint8Array(40).buffer,
      });
      expect(r).toMatchObject({ v: 1, id: 6, type: 'streams_unchecked' });
    }
  });

  it("the report's notes never reach the response", async () => {
    const { core } = mkCore({
      streams: () =>
        streamsJson({ verdict: 'refuse', reason: 'font_over_limit', notes: ['SENTINEL-NOTE'] }),
    });
    const r = await core.handle({ v: 1, id: 1, type: 'triage', bytes: new Uint8Array(40).buffer });
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
  });

  it('peak memory is the maximum over all calls so far, never lower than before', async () => {
    let n = 1_000_000;
    let shrink = false;
    const { core } = mkCore({ memBytes: () => (shrink ? 100 : (n += 1_000_000)) });
    await core.handle({ v: 1, id: 1, type: 'triage', bytes: new ArrayBuffer(8) });
    const r2 = (await core.handle({ v: 1, id: 2, type: 'triage', bytes: new ArrayBuffer(8) })) as {
      peakWasmBytes: number;
    };
    expect(r2.peakWasmBytes).toBe(6_000_000); // second call: 3,000,000 + 3,000,000
    shrink = true;
    const r3 = (await core.handle({ v: 1, id: 3, type: 'triage', bytes: new ArrayBuffer(8) })) as {
      peakWasmBytes: number;
    };
    expect(r3.peakWasmBytes).toBe(6_000_000);
  });

  it('peak memory is null (reported unavailable, never estimated) when either module exposes no memory', async () => {
    const { core } = mkCore({ memBytes: () => null });
    const r = (await core.handle({ v: 1, id: 1, type: 'triage', bytes: new ArrayBuffer(8) })) as {
      peakWasmBytes: number | null;
    };
    expect(r.peakWasmBytes).toBeNull();
    const g = createAnalysisCore({
      pagetriage: {
        account_pdf_streams: () => STREAMS_OK,
        analyse_pdf_structure: () => '{}',
        memoryBytes: () => null,
      },
      glyphsift: { gate: () => '{}', memoryBytes: () => null },
    });
    const r2 = (await g.handle({ v: 1, id: 1, type: 'triage', bytes: new ArrayBuffer(8) })) as {
      peakWasmBytes: number | null;
    };
    expect(r2.peakWasmBytes).toBeNull();
  });

  it('a pagetriage failure is an error response with the code corrupt, never a thrown exception', async () => {
    const { core } = mkCore({ fail: true });
    expect(await core.handle({ v: 1, id: 3, type: 'triage', bytes: new ArrayBuffer(8) })).toEqual({
      v: 1,
      id: 3,
      type: 'error',
      code: 'corrupt',
    });
  });

  const G = (o: object) =>
    JSON.stringify({ spec: 'glyphsift.gate/0.1', threshold_ppm: 975000, ...o });

  it('gate returns one verdict per text, in order, with ppm and threshold; a refused text is null', async () => {
    const { core } = mkCore({
      gate: (t) => {
        if (t === 'huge') throw new TypeError('too large');
        if (t === 'latin')
          return G({
            scored: false,
            script: 'other',
            devanagari_ppm: 0,
            ppm: null,
            verdict: 'not_scored',
          });
        return t === 'bad'
          ? G({
              scored: true,
              script: 'devanagari',
              devanagari_ppm: 1000000,
              ppm: 900000,
              verdict: 'hold',
            })
          : G({
              scored: true,
              script: 'devanagari',
              devanagari_ppm: 1000000,
              ppm: 1000000,
              verdict: 'pass',
            });
      },
    });
    const r = (await core.handle({
      v: 1,
      id: 4,
      type: 'gate',
      texts: ['ok', 'bad', 'latin', 'huge'],
    })) as { results: unknown[] };
    expect(r.results).toEqual([
      { verdict: 'pass', ppm: 1_000_000, threshold: 975_000 },
      { verdict: 'hold', ppm: 900_000, threshold: 975_000 },
      { verdict: 'not_scored', ppm: null, threshold: 975_000 },
      null,
    ]);
  });

  it('a gate reply that is not the documented JSON is a null result for that text, never a pass', async () => {
    const { core } = mkCore({ gate: () => 'not json' });
    const r = (await core.handle({ v: 1, id: 5, type: 'gate', texts: ['a'] })) as {
      results: unknown[];
    };
    expect(r.results).toEqual([null]);
    const g = mkCore({ gate: () => G({ scored: true, verdict: 'maybe', ppm: 1 }) });
    const r2 = (await g.core.handle({ v: 1, id: 6, type: 'gate', texts: ['a'] })) as {
      results: unknown[];
    };
    expect(r2.results).toEqual([null]);
  });

  it('rejects a malformed request with an error response', async () => {
    const { core } = mkCore();
    expect(await core.handle({ v: 2, id: 1, type: 'triage' } as never)).toMatchObject({
      type: 'error',
      code: 'corrupt',
    });
    expect(await core.handle({ v: 1, id: 1, type: 'gate', texts: 'x' } as never)).toMatchObject({
      type: 'error',
    });
    expect(await core.handle({ v: 1, id: 1, type: 'other' } as never)).toMatchObject({
      type: 'error',
    });
  });
});

/** A fake Worker the test drives by hand. */
class FakeWorker {
  listeners = new Map<string, ((e: unknown) => void)[]>();
  sent: { msg: AnalysisRequest; transfer?: unknown[] | undefined }[] = [];
  terminated = false;
  addEventListener(t: string, fn: (e: unknown) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  removeEventListener(t: string, fn: (e: unknown) => void) {
    this.listeners.set(
      t,
      (this.listeners.get(t) ?? []).filter((f) => f !== fn),
    );
  }
  postMessage(msg: AnalysisRequest, transfer?: unknown[]) {
    this.sent.push({ msg, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  reply(r: AnalysisResponse) {
    this.emit('message', r);
  }
}

describe('analysis client (main thread)', () => {
  it('posts a triage request with the bytes transferred and resolves with the parsed report and peak memory', async () => {
    const w = new FakeWorker();
    const c = createAnalysisClient({ startWorker: () => w as never });
    const p = c.triage(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    expect(w.sent[0]!.msg).toMatchObject({ v: 1, type: 'triage' });
    expect(w.sent[0]!.transfer).toHaveLength(1);
    const sent = (w.sent[0]!.msg as { bytes: ArrayBuffer }).bytes;
    w.reply({
      v: 1,
      id: w.sent[0]!.msg.id,
      type: 'triage',
      report: REPORT as never,
      peakWasmBytes: 123,
      bytes: sent, // the worker gives the one buffer back (B1 M3)
    });
    const r = await p;
    expect(r).toMatchObject({ report: REPORT, peakWasmBytes: 123 });
    expect([...r.bytes]).toEqual([1, 2, 3]);
    expect(r.bytes.buffer).toBe(sent); // not a copy
  });

  it('a triage response that does not give the bytes back is corrupt (what was judged must be what is opened)', async () => {
    const w = new FakeWorker();
    const c = createAnalysisClient({ startWorker: () => w as never });
    const p = c.triage(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    w.emit('message', {
      v: 1,
      id: w.sent[0]!.msg.id,
      type: 'triage',
      report: REPORT,
      peakWasmBytes: 1,
    });
    await expect(p).rejects.toMatchObject({ reason: 'corrupt' });
  });

  // B1 M3: the analysis worker holds two WebAssembly modules; its memory is returned by ending it as soon as the stage is over
  it('the worker is terminated as soon as a call settles, and the next call starts a fresh one', async () => {
    const workers: FakeWorker[] = [];
    const c = createAnalysisClient({
      startWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as never;
      },
    });
    const p = c.gate(['a']);
    await Promise.resolve();
    workers[0]!.reply({ v: 1, id: workers[0]!.sent[0]!.msg.id, type: 'gate', results: [null] });
    await p;
    expect(workers[0]!.terminated).toBe(true);
    const q = c.triage(new Uint8Array([9]));
    await Promise.resolve();
    expect(workers).toHaveLength(2);
    const buf = (workers[1]!.sent[0]!.msg as { bytes: ArrayBuffer }).bytes;
    workers[1]!.reply({
      v: 1,
      id: workers[1]!.sent[0]!.msg.id,
      type: 'triage',
      report: REPORT as never,
      peakWasmBytes: null,
      bytes: buf,
    });
    await q;
    expect(workers[1]!.terminated).toBe(true);
  });

  it('a call that fails also ends its worker', async () => {
    const w = new FakeWorker();
    const c = createAnalysisClient({ startWorker: () => w as never });
    const p = c.gate(['a']);
    await Promise.resolve();
    w.reply({ v: 1, id: w.sent[0]!.msg.id, type: 'error', code: 'corrupt' });
    await expect(p).rejects.toMatchObject({ reason: 'corrupt' });
    expect(w.terminated).toBe(true);
  });

  it('gate resolves with the verdicts', async () => {
    const w = new FakeWorker();
    const c = createAnalysisClient({ startWorker: () => w as never });
    const p = c.gate(['a', 'b']);
    await Promise.resolve();
    const results = [{ verdict: 'pass' as const, ppm: 1_000_000, threshold: 975_000 }, null];
    w.reply({ v: 1, id: w.sent[0]!.msg.id, type: 'gate', results });
    await expect(p).resolves.toEqual(results);
  });

  it('an error response becomes a Refusal with that code', async () => {
    const w = new FakeWorker();
    const c = createAnalysisClient({ startWorker: () => w as never });
    const p = c.triage(new Uint8Array(3));
    await Promise.resolve();
    w.reply({ v: 1, id: w.sent[0]!.msg.id, type: 'error', code: 'corrupt' });
    await expect(p).rejects.toMatchObject({ name: 'Refusal', reason: 'corrupt' });
  });

  it('ignores a response with an id it did not issue', async () => {
    const w = new FakeWorker();
    const c = createAnalysisClient({ startWorker: () => w as never, timeoutMs: 50 });
    const p = c.gate(['a']);
    await Promise.resolve();
    w.reply({ v: 1, id: 99999, type: 'gate', results: [null] });
    await expect(p).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('a response that is not a well-formed analysis response is corrupt (the worker is untrusted)', async () => {
    const w = new FakeWorker();
    const c = createAnalysisClient({ startWorker: () => w as never });
    const p = c.gate(['a']);
    await Promise.resolve();
    w.emit('message', { v: 1, id: w.sent[0]!.msg.id, type: 'gate', results: 'nope' });
    await expect(p).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it("'error' and 'messageerror' events are corrupt, terminate the worker, and the next call starts a fresh one", async () => {
    for (const ev of ['error', 'messageerror']) {
      const workers: FakeWorker[] = [];
      const c = createAnalysisClient({
        startWorker: () => {
          const w = new FakeWorker();
          workers.push(w);
          return w as never;
        },
      });
      const p = c.gate(['a']);
      await Promise.resolve();
      workers[0]!.emit(ev);
      await expect(p).rejects.toMatchObject({ reason: 'corrupt' });
      expect(workers[0]!.terminated).toBe(true);
      const q = c.gate(['b']);
      await Promise.resolve();
      expect(workers).toHaveLength(2);
      workers[1]!.reply({ v: 1, id: workers[1]!.sent[0]!.msg.id, type: 'gate', results: [null] });
      await expect(q).resolves.toEqual([null]);
    }
  });

  it('a call that gets no answer in 60 s terminates the worker and refuses with timeout; the page stays usable', async () => {
    vi.useFakeTimers();
    try {
      const workers: FakeWorker[] = [];
      const c = createAnalysisClient({
        startWorker: () => {
          const w = new FakeWorker();
          workers.push(w);
          return w as never;
        },
        timeoutMs: 60_000,
      });
      const p = c.triage(new Uint8Array(3));
      const assertion = expect(p).rejects.toMatchObject({ reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(60_001);
      await assertion;
      expect(workers[0]!.terminated).toBe(true);
      c.gate(['x']).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1);
      expect(workers).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() terminates the worker', async () => {
    const w = new FakeWorker();
    const c = createAnalysisClient({ startWorker: () => w as never });
    c.gate(['a']).catch(() => undefined);
    await Promise.resolve();
    c.dispose();
    expect(w.terminated).toBe(true);
  });
});

describe('analysis client: the stream accounting verdict (S1-107, TD-85)', () => {
  const triageWith = async (reply: (id: number) => unknown) => {
    const w = new FakeWorker();
    const c = createAnalysisClient({ startWorker: () => w as never });
    const p = c.triage(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    w.emit('message', reply(w.sent[0]!.msg.id));
    return { p, w };
  };

  it('streams_refused is the refusal stream_limit with the plain sentence for the kind, and the worker is ended', async () => {
    const { p, w } = await triageWith((id) => ({
      v: 1,
      id,
      type: 'streams_refused',
      reason: 'font_over_limit',
      limits: LIMITS,
      peakWasmBytes: 1234,
    }));
    await expect(p).rejects.toMatchObject({
      name: 'Refusal',
      reason: 'stream_limit',
      message:
        'This PDF holds a font that unpacks to more than 32 MiB, so it was refused before it was opened.',
      detail: { limit: 'font_over_limit', peakWasmBytes: 1234 },
    });
    expect(w.terminated).toBe(true);
  });

  it("streams_unchecked is the existing 'corrupt' refusal with the documented sentence", async () => {
    const { p } = await triageWith((id) => ({
      v: 1,
      id,
      type: 'streams_unchecked',
      peakWasmBytes: null,
    }));
    await expect(p).rejects.toMatchObject({
      name: 'Refusal',
      reason: 'corrupt',
      message:
        "This PDF's structure could not be checked safely, so it was refused before it was opened.",
    });
  });

  it('a streams_refused the worker got wrong (an unknown reason, a limit that is not a count) is a plain corrupt, not a made-up sentence', async () => {
    for (const bad of [
      { reason: 'something_new', limits: LIMITS },
      { reason: 'font_over_limit', limits: { ...LIMITS, font_decoded_max: -5 } },
      { reason: 'font_over_limit', limits: undefined },
    ]) {
      const { p } = await triageWith((id) => ({
        v: 1,
        id,
        type: 'streams_refused',
        peakWasmBytes: null,
        ...bad,
      }));
      await expect(p).rejects.toMatchObject({ reason: 'corrupt' });
    }
  });
});
