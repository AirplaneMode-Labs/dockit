import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import * as h from '../scripts/lib/e2e-harness.mjs';
import { BenchFailure, FAILURE_REASONS, createGuard } from '../scripts/lib/fail-fast.mjs';

// B6: a crashed or out-of-memory run must fail within seconds with a recorded reason, not wait out ask()'s 10 minute timeout. These tests drive the
// guard with fake pages and contexts (a simulated crash, on any OS); the real chrome://crash case is test/e2e/failfast-crash.spec.ts (installed Chrome).

const never = (): Promise<never> => new Promise<never>(() => undefined);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A page whose awaited methods never settle, as a crashed renderer's would not: only the event emitter works. */
function hangingPage() {
  const page: any = new EventEmitter();
  const hang = new Proxy(() => never(), {
    get: (_t, p) => (p === 'then' ? undefined : hang),
    apply: () => never(),
  });
  page.getByTestId = () => hang;
  for (const m of [
    'goto',
    'waitForFunction',
    'waitForSelector',
    'setInputFiles',
    'evaluate',
    '$$eval',
  ])
    page[m] = () => never();
  return page;
}

describe('createGuard: the four reasons, each within a few seconds', () => {
  it('names exactly the four reasons the CSV may record', () => {
    expect([...FAILURE_REASONS]).toEqual([
      'renderer_crash',
      'browser_disconnected',
      'worker_crash',
      'out_of_memory',
    ]);
  });

  it('a page crash rejects a pending wait with renderer_crash in well under a second', async () => {
    const page: any = new EventEmitter();
    const g = createGuard({ page });
    const t0 = Date.now();
    const pending = g.race(never());
    setTimeout(() => page.emit('crash'), 20);
    await expect(pending).rejects.toMatchObject({ name: 'BenchFailure', reason: 'renderer_crash' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(g.failure?.reason).toBe('renderer_crash');
    g.dispose();
  });

  it('a closed context (the browser died or went away) is browser_disconnected', async () => {
    const page: any = new EventEmitter();
    const context: any = new EventEmitter();
    const g = createGuard({ page, context });
    const pending = g.race(never());
    setTimeout(() => context.emit('close'), 10);
    await expect(pending).rejects.toMatchObject({ reason: 'browser_disconnected' });
    g.dispose();
  });

  it('a CDP target crash: a worker or service worker is worker_crash, a page target is renderer_crash, a closed socket is browser_disconnected', async () => {
    for (const [target, reason] of [
      ['worker', 'worker_crash'],
      ['service_worker', 'worker_crash'],
      ['shared_worker', 'worker_crash'],
      ['page', 'renderer_crash'],
    ] as const) {
      let cb: (f: { kind: string; targetType?: string }) => void = () => undefined;
      const cdp = {
        onFailure: (fn: typeof cb) => {
          cb = fn;
          return () => undefined;
        },
      };
      const g = createGuard({ page: new EventEmitter() as any, cdp });
      const pending = g.race(never());
      cb({ kind: 'target_crashed', targetType: target });
      await expect(pending).rejects.toMatchObject({ reason });
      g.dispose();
    }
    let cb: (f: { kind: string }) => void = () => undefined;
    const g = createGuard({
      page: new EventEmitter() as any,
      cdp: {
        onFailure: (fn: typeof cb) => {
          cb = fn;
          return () => undefined;
        },
      },
    });
    const pending = g.race(never());
    cb({ kind: 'closed' });
    await expect(pending).rejects.toMatchObject({ reason: 'browser_disconnected' });
    g.dispose();
  });

  it("the app's out_of_memory event, found by polling, rejects within the poll interval (here 20 ms; at most 5 s in the bench)", async () => {
    let calls = 0;
    const g = createGuard({
      page: new EventEmitter() as any,
      pollOutOfMemory: async () => ++calls >= 3,
      pollMs: 20,
    });
    const t0 = Date.now();
    await expect(g.race(never())).rejects.toMatchObject({ reason: 'out_of_memory' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(calls).toBeGreaterThanOrEqual(3);
    g.dispose();
  });

  it('a poll that throws (the page is gone) is not an out-of-memory verdict and does not stop the polling', async () => {
    let calls = 0;
    const g = createGuard({
      page: new EventEmitter() as any,
      pollOutOfMemory: async () => {
        calls += 1;
        if (calls < 3) throw new Error('Target crashed');
        return true;
      },
      pollMs: 10,
    });
    await expect(g.race(never())).rejects.toMatchObject({ reason: 'out_of_memory' });
    g.dispose();
  });

  it('the default poll interval is at most 2 s, so a reason is recorded within 5 s', () => {
    const g = createGuard({ page: new EventEmitter() as any });
    expect(g.pollMs).toBeLessThanOrEqual(2000);
    g.dispose();
  });
});

describe('createGuard: semantics', () => {
  it('a wait that settles first settles normally, and a rejected wait keeps its own error', async () => {
    const g = createGuard({ page: new EventEmitter() as any });
    await expect(g.race(Promise.resolve(7))).resolves.toBe(7);
    await expect(g.race(Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(g.failure).toBeNull();
    g.dispose();
  });

  it('the first failure wins; later triggers do not replace it', async () => {
    const page: any = new EventEmitter();
    const context: any = new EventEmitter();
    const g = createGuard({ page, context });
    page.emit('crash');
    context.emit('close');
    expect(g.failure?.reason).toBe('renderer_crash');
    await expect(g.race(never())).rejects.toMatchObject({ reason: 'renderer_crash' });
    g.dispose();
  });

  it('a failure with nobody racing is not an unhandled rejection', async () => {
    const page: any = new EventEmitter();
    const g = createGuard({ page });
    page.emit('crash');
    await tick(20);
    expect(g.failure).toBeInstanceOf(BenchFailure);
    g.dispose();
  });

  it('dispose removes every listener and stops the poll: a later crash does not trip it', async () => {
    const page: any = new EventEmitter();
    const context: any = new EventEmitter();
    let polls = 0;
    const g = createGuard({
      page,
      context,
      pollOutOfMemory: async () => (polls++, false),
      pollMs: 10,
    });
    g.dispose();
    expect(page.listenerCount('crash')).toBe(0);
    expect(context.listenerCount('close')).toBe(0);
    const before = polls;
    page.emit('crash');
    context.emit('close');
    await tick(60);
    expect(g.failure).toBeNull();
    expect(polls).toBe(before);
  });

  it('checkRefusal throws only for the out_of_memory reason (an ordinary refusal is data, not a failure)', () => {
    const g = createGuard({ page: new EventEmitter() as any });
    expect(() => g.checkRefusal('out_of_memory')).toThrow(BenchFailure);
    for (const r of [null, '', 'stream_limit', 'corrupt', 'no_answer'])
      expect(() => g.checkRefusal(r)).not.toThrow();
    g.dispose();
  });

  it('BenchFailure carries its reason and refuses an unknown one', () => {
    expect(new BenchFailure('out_of_memory', 'during run 2').message).toBe(
      'out_of_memory: during run 2',
    );
    expect(() => new BenchFailure('whatever')).toThrow(/unknown failure reason/u);
  });
});

describe('the harness waits are wired through the guard (ask, openPdf, downloadModel, waitReady)', () => {
  const cases: [string, (page: any, guard: any) => Promise<unknown>][] = [
    ['ask', (page, guard) => h.ask(page, 'q?', { guard })],
    ['openPdf', (page, guard) => h.openPdf(page, 'x.pdf', { guard })],
    ['downloadModel', (page, guard) => h.downloadModel(page, { guard })],
    ['waitReady', (page, guard) => h.waitReady(page, 'http://127.0.0.1:1/dockit/', { guard })],
  ];
  it.each(cases)(
    '%s: a simulated renderer crash ends the wait within a second, with the reason',
    async (_name, call) => {
      const page = hangingPage();
      const guard = createGuard({ page });
      const t0 = Date.now();
      const pending = call(page, guard);
      setTimeout(() => page.emit('crash'), 30);
      await expect(pending).rejects.toMatchObject({
        name: 'BenchFailure',
        reason: 'renderer_crash',
      });
      expect(Date.now() - t0).toBeLessThan(1000);
      guard.dispose();
    },
  );

  it('ask: an out_of_memory refusal shown by the app is a failure, any other refusal is returned as before', async () => {
    const mk = (reason: string) => {
      const page: any = new EventEmitter();
      const el = (text: string, attr: string | null = null) => ({
        fill: async () => undefined,
        click: async () => undefined,
        count: async () => (text === '' ? 0 : 1),
        first: () => el(text, attr),
        innerText: async () => text,
        getAttribute: async () => attr,
      });
      page.getByTestId = (id: string) =>
        id === 'ask-refusal' ? el('The model ran out of memory.', reason) : el('');
      page.waitForSelector = async () => undefined;
      return page;
    };
    const g = createGuard({ page: new EventEmitter() as any });
    await expect(h.ask(mk('out_of_memory'), 'q?', { guard: g })).rejects.toMatchObject({
      reason: 'out_of_memory',
    });
    await expect(h.ask(mk('stream_limit'), 'q?', { guard: g })).resolves.toMatchObject({
      ok: false,
      reason: 'stream_limit',
    });
    g.dispose();
  });

  it('without a guard every function behaves as before (the argument is optional)', async () => {
    const page: any = {
      getByTestId: () => ({
        fill: async () => undefined,
        click: async () => undefined,
        count: async () => 0,
      }),
      waitForSelector: async () => undefined,
    };
    // reaches the end of the refusal check: no refusal element, so it goes on to read the answer, which the stub page cannot give
    await expect(h.ask(page, 'q?')).rejects.toBeDefined();
  });
});
