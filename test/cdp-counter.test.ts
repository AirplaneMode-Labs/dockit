import { describe, expect, it } from 'vitest';
import { createLedger } from '../scripts/lib/cdp-counter.mjs';

const req = (id: string, url: string, type = 'Fetch') => ({
  requestId: id,
  type,
  request: { url, method: 'GET' },
});

describe('CDP request ledger (the authoritative zero-request counter, D5-08)', () => {
  it('counts a request attempted after the mark as a network attempt when nothing answered it from a cache', () => {
    const l = createLedger();
    l.onEvent('page', 'Network.requestWillBeSent', req('1', 'https://example.invalid/x'));
    l.mark('offline');
    l.onEvent('page', 'Network.requestWillBeSent', req('2', 'https://example.invalid/y'));
    l.onEvent('page', 'Network.loadingFailed', {
      requestId: '2',
      errorText: 'net::ERR_INTERNET_DISCONNECTED',
    });
    const r = l.since('offline');
    expect(r.network).toEqual(['https://example.invalid/y']);
    expect(r.total).toBe(1);
  });

  it('a request before the mark is not counted after it', () => {
    const l = createLedger();
    l.onEvent('page', 'Network.requestWillBeSent', req('1', 'https://example.invalid/x'));
    l.mark('m');
    expect(l.since('m')).toMatchObject({ network: [], total: 0 });
  });

  it('a request answered by the service worker is a service-worker hit, reported separately, not a network attempt', () => {
    const l = createLedger();
    l.mark('m');
    l.onEvent(
      'page',
      'Network.requestWillBeSent',
      req('1', 'http://127.0.0.1/dockit/app/index.js', 'Script'),
    );
    l.onEvent('page', 'Network.responseReceived', {
      requestId: '1',
      response: {
        url: 'http://127.0.0.1/dockit/app/index.js',
        status: 200,
        fromServiceWorker: true,
      },
    });
    expect(l.since('m')).toMatchObject({ network: [], swHits: 1, cacheHits: 0, total: 1 });
  });

  it('a request served from the memory or disk cache is a cache hit', () => {
    const l = createLedger();
    l.mark('m');
    l.onEvent('page', 'Network.requestWillBeSent', req('1', 'http://127.0.0.1/a'));
    l.onEvent('page', 'Network.requestServedFromCache', { requestId: '1' });
    l.onEvent('page', 'Network.requestWillBeSent', req('2', 'http://127.0.0.1/b'));
    l.onEvent('page', 'Network.responseReceived', {
      requestId: '2',
      response: { url: 'http://127.0.0.1/b', status: 200, fromDiskCache: true },
    });
    expect(l.since('m')).toMatchObject({ network: [], cacheHits: 2, swHits: 0 });
  });

  it('data: and blob: URLs can reach no network and are not counted', () => {
    const l = createLedger();
    l.mark('m');
    l.onEvent('page', 'Network.requestWillBeSent', req('1', 'data:text/plain;base64,AAAA'));
    l.onEvent('w1', 'Network.requestWillBeSent', req('2', 'blob:http://127.0.0.1/uuid', 'Other'));
    expect(l.since('m').total).toBe(0);
  });

  it('the same request id in two sessions (a page and a worker) is two requests', () => {
    const l = createLedger();
    l.mark('m');
    l.onEvent('page', 'Network.requestWillBeSent', req('1', 'https://example.invalid/p'));
    l.onEvent('worker', 'Network.requestWillBeSent', req('1', 'https://example.invalid/w'));
    expect(l.since('m').network.sort()).toEqual([
      'https://example.invalid/p',
      'https://example.invalid/w',
    ]);
  });

  it('a request with a redirect keeps one entry, judged by its last response', () => {
    const l = createLedger();
    l.mark('m');
    l.onEvent('page', 'Network.requestWillBeSent', req('1', 'http://127.0.0.1/a'));
    l.onEvent('page', 'Network.requestWillBeSent', {
      ...req('1', 'http://127.0.0.1/b'),
      redirectResponse: { status: 302, url: 'http://127.0.0.1/a' },
    });
    l.onEvent('page', 'Network.responseReceived', {
      requestId: '1',
      response: { url: 'http://127.0.0.1/b', status: 200, fromServiceWorker: true },
    });
    expect(l.since('m')).toMatchObject({ total: 1, swHits: 1, network: [] });
  });

  it('records the targets that attach, by type, so a run can require that the workers were really watched', () => {
    const l = createLedger();
    for (const [type, url] of [
      ['page', 'http://127.0.0.1/dockit/'],
      ['service_worker', 'http://127.0.0.1/dockit/sw.js'],
      ['worker', 'blob:http://127.0.0.1/1'],
      ['worker', 'blob:http://127.0.0.1/2'],
      ['worker', 'blob:http://127.0.0.1/3'],
    ] as const) {
      l.onEvent('browser', 'Target.attachedToTarget', {
        sessionId: `s-${url}`,
        targetInfo: { type, url, targetId: url },
        waitingForDebugger: false,
      });
    }
    expect(l.targetCounts()).toEqual({ page: 1, service_worker: 1, worker: 3 });
    expect(() => l.requireTargets({ page: 1, service_worker: 1, worker: 3 })).not.toThrow();
    expect(() => l.requireTargets({ worker: 4 })).toThrow(/worker: expected at least 4, saw 3/);
  });

  it('the urls it reports carry no query string (a document name could be there)', () => {
    const l = createLedger();
    l.mark('m');
    l.onEvent(
      'page',
      'Network.requestWillBeSent',
      req('1', 'https://example.invalid/x?file=secret.pdf#frag'),
    );
    expect(l.since('m').network).toEqual(['https://example.invalid/x']);
  });
});
