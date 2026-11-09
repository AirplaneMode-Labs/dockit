import { useEffect, useMemo, useRef, useState } from 'react';
import type { Event } from './contracts/event.ts';
import { EventLog } from './pipeline/events.ts';
import { runPipeline, STAGE_ORDER } from './pipeline/run.ts';
import type { PipelineResult, StageName } from './pipeline/types.ts';

interface BeforeInstallPromptEvent extends globalThis.Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const STAGE_LABELS: Record<StageName, { title: string; placeholder: string }> = {
  pdf: { title: 'PDF', placeholder: 'page count: unknown (pagetriage wasm, Sprint 5)' },
  triage: { title: 'Page triage', placeholder: 'what is on each page: unknown' },
  extract: { title: 'Extraction', placeholder: 'text layer or OCR: none' },
  glyphGate: { title: 'Glyph gate', placeholder: 'glyphsift clean fraction: not measured' },
  store: { title: 'Local store', placeholder: 'in-memory StorageApi; OPFS via localdata later' },
  answer: { title: 'Model answer', placeholder: 'MockAdapter echo; no model downloaded' },
};

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

function syntheticBlob(): Blob {
  // Synthetic bytes generated in the page; no document is read.
  const bytes = new Uint8Array(4096);
  crypto.getRandomValues(bytes);
  return new Blob([bytes], { type: 'application/pdf' });
}

export function App() {
  const online = useOnline();
  const { canInstall, installed, install } = useInstallPrompt();
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
          <h1>dockit</h1>
          <p className="tagline">Offline document intelligence kit. Skeleton build.</p>
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
        Placeholder results. Nothing here processes a document yet; every stage returns a labelled
        stub. The demo with real page triage, extraction and a local model is Sprint 5.
      </div>

      <main className="grid">
        <section className="card">
          <h2>Pipeline</h2>
          <ol className="stages">
            {STAGE_ORDER.map((stage) => {
              const rec = result?.stages.find((s) => s.stage === stage);
              return (
                <li key={stage} data-testid={`stage-${stage}`}>
                  <span className="stage-title">{STAGE_LABELS[stage].title}</span>
                  <span className="stage-detail">
                    {rec
                      ? `stub ran in ${rec.durationMs.toFixed(2)} ms`
                      : STAGE_LABELS[stage].placeholder}
                  </span>
                </li>
              );
            })}
          </ol>
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

        <section className="card">
          <h2>Capability profile</h2>
          <p className="muted">
            Not measured. <code>detectCapabilities()</code> arrives with{' '}
            <code>@airplanemode/runtime</code>; dockit will show gpu, ramGb, storageFreeGb, cores
            and backendTier here.
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
            <table className="events">
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
          )}
        </section>
      </main>

      <footer className="foot">
        <p>
          Airplane Mode Labs. Apache-2.0. This app makes no network requests other than the asset
          and manifest URLs you pass it, and sends no telemetry.
        </p>
      </footer>
    </div>
  );
}
