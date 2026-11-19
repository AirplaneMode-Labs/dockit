// The authoritative request counter of the offline proof: Chrome DevTools Protocol Network.requestWillBeSent from EVERY target (the page,
// the engine, pdf and analysis workers, the service worker), found by browser-level Target.setAutoAttach {autoAttach, flatten}. It talks
// to the browser through its --remote-debugging-port (read from <profile>/DevToolsActivePort) with Node's built-in WebSocket client, so
// it needs no dependency and works on Windows.
//
// A request is judged by what answered it: a response from the service worker is a SERVICE-WORKER HIT and one from the memory or disk cache a
// CACHE HIT (both reported separately and neither reaches a network); anything else after the mark is a NETWORK attempt, whether it
// succeeded or was refused because the browser was offline. data: and blob: URLs reach no network and are not counted.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const cleanUrl = (u) => {
  try {
    const x = new URL(u);
    x.search = '';
    x.hash = '';
    return x.href;
  } catch {
    return u.split(/[?#]/)[0];
  }
};
const isHttp = (u) => /^https?:/i.test(u);

export function createLedger() {
  /** @type {Map<string, {url:string, seq:number, sw:boolean, cache:boolean, status:number|null}>} */
  const reqs = new Map();
  const marks = new Map();
  const targets = [];
  let seq = 0;
  return {
    onEvent(session, method, p) {
      if (method === 'Target.attachedToTarget') {
        targets.push({
          type: p.targetInfo.type,
          url: cleanUrl(p.targetInfo.url ?? ''),
          sessionId: p.sessionId,
        });
        return;
      }
      if (!method.startsWith('Network.')) return;
      const key = `${session}:${p.requestId}`;
      if (method === 'Network.requestWillBeSent') {
        const prev = reqs.get(key);
        if (prev && p.redirectResponse) {
          prev.url = cleanUrl(p.request.url); // a redirect keeps one entry, judged by its last response
          return;
        }
        reqs.set(key, {
          url: cleanUrl(p.request.url),
          seq: ++seq,
          sw: false,
          cache: false,
          status: null,
        });
      } else if (method === 'Network.responseReceived') {
        const r = reqs.get(key);
        if (!r) return;
        r.status = p.response.status ?? null;
        if (p.response.fromServiceWorker) r.sw = true;
        if (p.response.fromDiskCache || p.response.fromPrefetchCache) r.cache = true;
      } else if (method === 'Network.loadingFailed') {
        const r = reqs.get(key);
        if (r) r.failed = p.errorText ?? 'failed';
      } else if (method === 'Network.requestServedFromCache') {
        const r = reqs.get(key);
        if (r) r.cache = true;
      }
    },
    mark(label) {
      marks.set(label, seq);
    },
    since(label) {
      const from = marks.get(label);
      if (from === undefined) throw new Error(`no mark ${label}`);
      const out = { network: [], swHits: 0, cacheHits: 0, total: 0 };
      for (const r of reqs.values()) {
        if (r.seq <= from || !isHttp(r.url)) continue;
        out.total += 1;
        if (r.sw) out.swHits += 1;
        else if (r.cache) out.cacheHits += 1;
        else out.network.push(r.url);
      }
      return out;
    },
    /** Requests that failed (with the browser's error text): for diagnosis. */
    failedRequests() {
      return [...reqs.values()].filter((r) => r.failed).map((r) => `${r.url} ${r.failed}`);
    },
    targetCounts() {
      const c = {};
      for (const t of targets) c[t.type] = (c[t.type] ?? 0) + 1;
      return c;
    },
    requireTargets(min) {
      const c = this.targetCounts();
      for (const [type, n] of Object.entries(min)) {
        if ((c[type] ?? 0) < n)
          throw new Error(
            `CDP targets, ${type}: expected at least ${n}, saw ${c[type] ?? 0} (a target that was not watched could hide a request)`,
          );
      }
    },
    targets: () => [...targets],
  };
}

/** Connects to the browser of the profile and starts watching every target. */
export async function connectCdp(userDataDir, { timeoutMs = 15000 } = {}) {
  const file = join(userDataDir, 'DevToolsActivePort');
  const t0 = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`${file} did not appear: start Chrome with --remote-debugging-port=0`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const [port, path] = readFileSync(file, 'utf8').split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP websocket failed')), { once: true });
  });
  const ledger = createLedger();
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const attach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id !== undefined)
      return (void pending.get(msg.id)?.(msg.result), pending.delete(msg.id));
    ledger.onEvent(msg.sessionId ?? 'browser', msg.method, msg.params);
    if (msg.method === 'Target.attachedToTarget') {
      const s = msg.params.sessionId;
      // Queue the three commands without waiting for any answer: a target that is paused at its start (waitForDebuggerOnStart) may not
      // answer Network.enable until it is resumed, so awaiting it first would leave a service worker or worker frozen.
      void send('Network.enable', {}, s);
      void send('Target.setAutoAttach', attach, s); // workers of this target
      if (msg.params.waitingForDebugger) void send('Runtime.runIfWaitingForDebugger', {}, s);
    }
  });
  await send('Target.setAutoAttach', attach);
  return {
    ledger,
    close: () => ws.close(),
    /** Target.getTargets over the browser-level session: the targets that exist right now (used to sample the worker count, B1 M1). */
    getTargets: () => send('Target.getTargets'),
  };
}
