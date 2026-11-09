import { useEffect, useMemo, useRef, useState } from 'react';
import type { Event } from './contracts/event.ts';
import { EventLog } from './pipeline/events.ts';
import { runPipeline, STAGE_ORDER } from './pipeline/run.ts';
import {
  browserEnv,
  CHAIN,
  MODEL_CARD_TEXT,
  MODEL_PLAN,
  PREDICTION_LABEL,
  predictBackends,
  type Prediction,
} from './pipeline/model-plan.ts';
import type { PipelineResult, StageName } from './pipeline/types.ts';

interface BeforeInstallPromptEvent extends globalThis.Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Every stage is a stub in this build; the text is the same for all six on purpose. */
const STAGE_STATUS = 'not built (stub returns a labelled placeholder)';

const STAGE_LABELS: Record<StageName, { title: string; landsIn: string }> = {
  pdf: { title: 'PDF (page count via pagetriage wasm)', landsIn: 'Sprint 5' },
  triage: { title: 'Page triage (what is on each page)', landsIn: 'Sprint 5' },
  extract: { title: 'Extraction (text layer or OCR)', landsIn: 'Sprint 5' },
  glyphGate: { title: 'Glyph gate (glyphsift clean fraction)', landsIn: 'Sprint 5' },
  store: { title: 'Local store (localdata over OPFS)', landsIn: 'Sprint 4 (localdata)' },
  answer: { title: 'Model answer (local model)', landsIn: 'Sprint 5' },
};

/** Set by the Pages workflow (VITE_BUILD_SHA=$GITHUB_SHA); 'local' for a developer build. */
const BUILD_SHA: string = String(import.meta.env['VITE_BUILD_SHA'] ?? 'local').slice(0, 12);

interface Requirement {
  id: string;
  label: string;
  note: string;
  ok: boolean;
}

/** Feature detection at load; nothing here is a static list. */
function detectRequirements(): Requirement[] {
  const nav = navigator as Navigator & { serviceWorker?: unknown };
  return [
    {
      id: 'service-worker',
      label: 'Service Worker',
      note: 'registers ./sw.js and serves the shell offline',
      ok: 'serviceWorker' in nav && nav.serviceWorker !== undefined,
    },
    {
      id: 'cache-api',
      label: 'Cache API',
      note: 'holds the hash-verified precache',
      ok: typeof caches !== 'undefined' && typeof caches.open === 'function',
    },
    {
      id: 'install-prompt',
      label: 'Install prompt (beforeinstallprompt)',
      note: 'Chromium-only; other browsers install from their own menu or not at all',
      ok: 'onbeforeinstallprompt' in window,
    },
    {
      id: 'secure-context',
      label: 'Secure context (https or localhost)',
      note: 'service workers and installation require it',
      ok: window.isSecureContext === true,
    },
  ];
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

function useInstallPrompt(): { canInstall: boolean; installed: boolean; install: () => void } {
  const deferred = useRef<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(
    () => window.matchMedia('(display-mode: standalone)').matches,
  );
  useEffect(() => {
    const onPrompt = (e: globalThis.Event) => {
      e.preventDefault();
      deferred.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onInstalled = () => {
      setInstalled(true);
      setCanInstall(false);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const install = () => {
    const e = deferred.current;
    if (!e) return;
    void e.prompt().then(() => {
      deferred.current = null;
      setCanInstall(false);
    });
  };
  return { canInstall, installed, install };
}

interface WorkerState {
  scope: string;
  worker: string;
  controller: string;
}

/** Registration scope and controller state, refreshed on every lifecycle change. */
function useServiceWorkerState(): WorkerState {
  const [state, setState] = useState<WorkerState>({
    scope: 'none',
    worker: 'none',
    controller: 'none',
  });
  useEffect(() => {
    const sw = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
    if (!sw) {
      setState({ scope: 'unsupported', worker: 'unsupported', controller: 'unsupported' });
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const reg = await sw.getRegistration();
      if (cancelled) return;
      const worker = reg?.active ?? reg?.waiting ?? reg?.installing;
      setState({
        scope: reg?.scope ?? 'none',
        worker: worker ? worker.state : reg ? 'registered, no worker' : 'none',
        controller: sw.controller ? sw.controller.state : 'none',
      });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    sw.addEventListener('controllerchange', () => void refresh());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return state;
}

function syntheticBlob(): Blob {
  // Synthetic bytes generated in the page; no document is read.
  const bytes = new Uint8Array(4096);
  crypto.getRandomValues(bytes);
  return new Blob([bytes], { type: 'application/pdf' });
}

const yesNo = (b: boolean): string => (b ? 'likely available' : 'not detected');

function usePrediction(): Prediction | null {
  const [p, setP] = useState<Prediction | null>(null);
  useEffect(() => {
    let cancelled = false;
    void predictBackends(browserEnv()).then((r) => {
      if (!cancelled) setP(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return p;
}

function ModelPlanCard() {
  const prediction = usePrediction();
  return (
    <section className="card card-wide" data-testid="model-plan">
      <h2>Answer: planned model and backend chain</h2>
      <p data-testid="model-card">{MODEL_CARD_TEXT}</p>
      <ul className="reqs">
        <li data-testid="plan-webgpu">
          WebGPU: {MODEL_PLAN.webgpu.dtype}, {MODEL_PLAN.webgpu.bytes.toLocaleString('en-US')} B
        </li>
        <li data-testid="plan-wasm">
          WebAssembly: {MODEL_PLAN.wasm.dtype}, {MODEL_PLAN.wasm.bytes.toLocaleString('en-US')} B
        </li>
        <li data-testid="plan-source">
          Source: <code>{MODEL_PLAN.source}</code>
        </li>
      </ul>
      <h3>Fallback chain (in order)</h3>
      <ol data-testid="chain">
        {CHAIN.map((r) => (
          <li key={r.id}>{r.label}</li>
        ))}
      </ol>
      <h3>This browser</h3>
      <dl className="kv" data-testid="prediction">
        <dt>WebGPU</dt>
        <dd data-testid="pred-webgpu">{prediction ? yesNo(prediction.webgpu) : 'checking'}</dd>
        <dt>WebAssembly</dt>
        <dd data-testid="pred-wasm">{prediction ? yesNo(prediction.wasm) : 'checking'}</dd>
        <dt>Chrome built-in model API</dt>
        <dd data-testid="pred-builtin">
          {prediction
            ? prediction.builtinPresent
              ? 'present (opt-in only)'
              : 'not detected'
            : 'checking'}
        </dd>
      </dl>
      <p className="muted small" data-testid="prediction-label">
        {PREDICTION_LABEL}
      </p>
    </section>
  );
}

export function App() {
  const online = useOnline();
  const { canInstall, installed, install } = useInstallPrompt();
  const requirements = useMemo(detectRequirements, []);
  const swState = useServiceWorkerState();
  const baseUrl = useMemo(() => new URL(import.meta.env.BASE_URL, location.href).href, []);
  const log = useMemo(() => new EventLog(200), []);
  const [events, setEvents] = useState<Event[]>([]);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [running, setRunning] = useState(false);
  const [question, setQuestion] = useState('What is this document about?');

  useEffect(() => log.subscribe(() => setEvents(log.snapshot())), [log]);

  const run = async () => {
    setRunning(true);
    try {
      const r = await runPipeline(
        { file: syntheticBlob(), fileName: 'synthetic.pdf', question },
        { events: log },
      );
      setResult(r);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>dockit demo</h1>
          <p className="tagline">
            Everything runs in this tab. Nothing is uploaded; the only network requests are for this
            page's own files.
          </p>
          <p className="build" data-testid="build-line">
            Built from main at <code>{BUILD_SHA}</code> by <code>.github/workflows/pages.yml</code>
          </p>
        </div>
        <div className="badges" aria-live="polite">
          <span
            className={online ? 'badge badge-ok' : 'badge badge-warn'}
            data-testid="online-badge"
          >
            {online ? 'online' : 'offline'}
          </span>
          {installed ? (
            <span className="badge">installed</span>
          ) : (
            <button type="button" onClick={install} disabled={!canInstall} data-testid="install">
              {canInstall ? 'Install app' : 'Install (not offered yet)'}
            </button>
          )}
        </div>
      </header>

      <div className="banner" role="status" data-testid="placeholder-banner">
        Document processing is not built yet. Every pipeline stage below returns a labelled stub;
        what works today is the installable shell, its hash-verified offline cache and the offline
        page. The real pipeline (page triage, extraction, glyph gate, local store, local model) is
        Sprint 5.
      </div>

      <main className="grid">
        <section className="card card-wide">
          <h2>Pipeline</h2>
          <div className="table-wrap">
            <table className="table pipeline" data-testid="pipeline">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Lands in</th>
                </tr>
              </thead>
              <tbody>
                {STAGE_ORDER.map((stage) => {
                  const rec = result?.stages.find((s) => s.stage === stage);
                  return (
                    <tr key={stage} data-testid={`stage-${stage}`}>
                      <td className="stage-title">{STAGE_LABELS[stage].title}</td>
                      <td data-testid={`status-${stage}`}>
                        {STAGE_STATUS}
                        {rec ? (
                          <span className="muted">
                            {' '}
                            ; stub ran in {rec.durationMs.toFixed(2)} ms
                          </span>
                        ) : null}
                      </td>
                      <td>{STAGE_LABELS[stage].landsIn}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <label className="field">
            <span>Question</span>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={200}
              autoComplete="off"
            />
          </label>
          <button type="button" onClick={() => void run()} disabled={running} data-testid="run">
            {running
              ? 'Running placeholder pipeline'
              : 'Run placeholder pipeline on synthetic bytes'}
          </button>
          {result ? (
            <p className="answer" data-testid="answer">
              {result.answer.answer}
            </p>
          ) : null}
        </section>

        <ModelPlanCard />

        <section id="requirements" className="card box" data-testid="requirements">
          <h2>Browser requirements</h2>
          <ul className="reqs">
            {requirements.map((r) => (
              <li key={r.id} data-testid={`req-${r.id}`} data-ok={r.ok ? 'true' : 'false'}>
                <span className={r.ok ? 'tick' : 'cross'} aria-hidden="true">
                  {r.ok ? '✓' : '✗'}
                </span>{' '}
                <span className="req-label">{r.label}</span>
                <span className="visually-hidden">{r.ok ? ' available' : ' missing'}</span>
                <span className="muted"> : {r.note}</span>
              </li>
            ))}
          </ul>
          <p className="muted small" data-testid="shared-origin">
            All Airplane Mode Labs demos share one browser origin (airplanemode-labs.github.io):
            storage, quota, estimate() and persist() are shared between them. This demo writes only
            under the dockit-precache-* cache.
          </p>
        </section>

        <section id="not-yet" className="card box box-warn" data-testid="not-yet">
          <h2>What this demo does not do yet</h2>
          <ul>
            <li>
              No document processing at all: every stage is a labelled stub. The real pipeline (page
              triage, extraction, glyph gate, local store, model answer) lands in Sprint 5.
            </li>
            <li>
              No model and no inference: nothing is downloaded or loaded and the answer stage echoes
              a MockAdapter. The planned-model card above is a plan plus a feature-detection
              prediction only; dockit wires a local model in Sprint 5.
            </li>
            <li>
              The capability profile card is not wired: runtime's detectCapabilities() is not called
              here yet (Sprint 5).
            </li>
            <li>
              No OPFS storage: the store stage writes to memory only. localdata's OPFS driver is
              Sprint 4 and dockit adopts it in Sprint 5.
            </li>
          </ul>
        </section>

        <section className="card" data-testid="sw-card">
          <h2>Service worker</h2>
          <dl className="kv">
            <dt>base URL</dt>
            <dd data-testid="base-url">{baseUrl}</dd>
            <dt>scope</dt>
            <dd data-testid="sw-scope">{swState.scope}</dd>
            <dt>worker</dt>
            <dd data-testid="sw-worker">{swState.worker}</dd>
            <dt>controller</dt>
            <dd data-testid="sw-controller">{swState.controller}</dd>
          </dl>
          <p className="muted small">
            The worker precaches the shell after verifying every file's SHA-256 and deletes only its
            own stale <code>dockit-precache-*</code> caches on activate.
          </p>
        </section>

        <section className="card">
          <h2>Capability profile</h2>
          <p className="muted">
            Not measured. <code>detectCapabilities()</code> from <code>@airplanemode/runtime</code>{' '}
            is not called in this build; dockit will show gpu, ramGb, storageFreeGb, cores and
            backendTier here.
          </p>
          <dl className="kv">
            <dt>gpu</dt>
            <dd>unknown</dd>
            <dt>ramGb</dt>
            <dd>unknown</dd>
            <dt>storageFreeGb</dt>
            <dd>unknown</dd>
            <dt>cores</dt>
            <dd>unknown</dd>
            <dt>backendTier</dt>
            <dd>unknown</dd>
          </dl>
        </section>

        <section className="card card-wide">
          <h2>Events</h2>
          <p className="muted">
            In-memory ring buffer following Event 0.1. Nothing leaves this page.
          </p>
          {events.length === 0 ? (
            <p className="muted">No events yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table events">
                <thead>
                  <tr>
                    <th>name</th>
                    <th>kind</th>
                    <th>level</th>
                    <th>durationMs</th>
                    <th>attrs</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td>{e.kind}</td>
                      <td>{e.level}</td>
                      <td>{e.durationMs === undefined ? '' : e.durationMs.toFixed(2)}</td>
                      <td>
                        <code>{JSON.stringify(e.attrs)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      <footer className="foot">
        <p>
          <a href="https://github.com/AirplaneMode-Labs/dockit" rel="noopener">
            dockit on GitHub
          </a>{' '}
          · <a href="https://airplanemode-labs.github.io/site/">Airplane Mode Labs</a> · Apache-2.0
        </p>
        <p>
          This app makes no network requests other than the asset and manifest URLs you pass it, and
          sends no telemetry.
        </p>
      </footer>
    </div>
  );
}
