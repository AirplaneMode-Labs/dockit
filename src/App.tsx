import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Event } from './contracts/event.ts';
import type { AppController } from './app/controller.ts';
import { StatusLine } from './status-line.tsx';
import { AskCard } from './ui/AskCard.tsx';
import { CapabilityCard } from './ui/CapabilityCard.tsx';
import { DocumentCard } from './ui/DocumentCard.tsx';
import { Framed } from './ui/Framed.tsx';
import { ModelCard } from './ui/ModelCard.tsx';

/** 'Built from main at <sha12>' (CI) or 'Local build <sha12>[-dirty]' (vite.config.ts decides, from the environment and git). */
const BUILD_ID: string = String(import.meta.env['VITE_BUILD_ID'] ?? 'Local build unknown');

interface BeforeInstallPromptEvent extends globalThis.Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

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

export function App({
  controller,
  events,
}: {
  controller: AppController | Error | undefined;
  events: { subscribe(fn: () => void): () => void; snapshot(): Event[] };
}) {
  const online = useOnline();
  const { canInstall, installed, install } = useInstallPrompt();
  const requirements = useMemo(detectRequirements, []);
  const swState = useServiceWorkerState();
  const baseUrl = useMemo(() => new URL(import.meta.env.BASE_URL, location.href).href, []);
  const [log, setLog] = useState<Event[]>([]);
  useEffect(() => events.subscribe(() => setLog(events.snapshot())), [events]);

  if (window.top !== window.self) return <Framed />;

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>dockit demo</h1>
          <p className="tagline">
            Ask a question about a PDF. Everything runs in this tab: the file is never uploaded, and
            after the one-time model download no request leaves the page.
          </p>
          <p className="build" data-testid="build-line">
            {BUILD_ID}
            {__DOCKIT_STUB__
              ? ' (stub build: the sibling builds are not included; never deployed)'
              : ''}
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

      <StatusLine />

      {controller === undefined ? (
        <p className="muted" data-testid="starting">
          Starting...
        </p>
      ) : controller instanceof Error ? (
        <div className="box box-warn" role="alert" data-testid="startup-error">
          <p>dockit could not start: {controller.message}</p>
        </div>
      ) : (
        <Live controller={controller} online={online} />
      )}

      <main className="grid">
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
            storage, quota, estimate() and persist() are shared between them. The models are held in
            the shared airplanemode-runtime store; documents stay in memory unless you choose to
            keep one.
          </p>
        </section>

        <section id="not-yet" className="card box box-warn" data-testid="not-yet">
          <h2>What this demo does not do yet</h2>
          <ul>
            <li>
              Text-layer PDFs only. OCR is not yet supported: a scanned PDF is refused, and
              image-only pages are skipped.
            </li>
            <li>
              The model is Qwen3-0.6B, a small demo model. It is not the pilot model (Qwen3-1.7B,
              hosted by the customer), and its answers can be wrong: check the source pages.
            </li>
            <li>
              Single-threaded WebAssembly: answers take seconds. A Windows or 8 GB laptop figure
              does not exist yet: the figures on the benchmarks page are from an Apple M5 Pro with
              48 GB, and every one says not measured on 8 GB.
            </li>
            <li>
              An emulated Windows figure (a GitHub-hosted virtual machine, not a laptop) is pending
              the first run of the manual benchmark, which is written and has not run. It will say
              what it is on every row, and it will not fill an 8 GB laptop cell.
            </li>
            <li>
              No Hindi or other Indic answer quality claim: the glyph gate is tested on Devanagari
              text, but answers over Hindi documents are not evaluated.
            </li>
            <li>
              No real signing key: the model list is signed by a key that exists only inside the
              build that made this page, which proves the files and the list came from the same
              build, not who published them.
            </li>
            <li>
              No WebLLM (cut), no multi-document chat. This page has been live since the owner's
              push of 18 Nov 2026.
            </li>
            <li>
              Memory: only one model is held at a time, so the models are loaded again from this
              device for each stage and every question takes longer. Every question loads the models
              again from this device. The memory line is a usability guard, not a security control:
              the browser reports memory in coarse steps and a user can change what it reports, and
              a page cannot read how much memory is free. Not measured on an 8 GB laptop.
            </li>
            <li>
              Hostile files: a PDF whose structure cannot be checked is refused before it is opened,
              which includes a damaged file that other readers would repair. A PDF that holds a part
              which unpacks to more than the limit is refused in the same way. Inline-image and Type
              3 procedure decoding by pdf.js stay unchecked.
            </li>
            <li data-testid="tt-status">
              Trusted Types is on for scripts (require-trusted-types-for 'script'; policies
              dockit-sw, airplanemode-worker, dockit-workers). The CSP comes from a meta tag because
              GitHub Pages cannot send headers, so frame-ancestors is not set; a framed copy shows
              only a link to open dockit directly.
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
            The worker precaches the shell, the WASM files and the pdf.js assets after verifying
            every file's SHA-256, never sees a document, and lets the model files pass through to
            the browser's verified store.
          </p>
        </section>

        <section className="card card-wide">
          <h2>Events</h2>
          <p className="muted">
            In-memory ring buffer following Event 0.1. Counts, timings and enums only: never a file
            name, text, question or answer. Nothing leaves this page.
          </p>
          {log.length === 0 ? (
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
                  {log.slice(-60).map((e) => (
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
          · <a href="./THIRD-PARTY-NOTICES.txt">Third-party notices</a>
        </p>
        <p>
          After the one-time model download this app makes no network requests, and it sends no
          telemetry.
        </p>
      </footer>
    </div>
  );
}

/** The live part of the page: model, capability, document and question, all driven by the controller. */
function Live({ controller, online }: { controller: AppController; online: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useEffect(() => {
    controller.setOnline(online);
  }, [controller, online]);
  // Ask stays disabled while the model is being loaded, which includes the re-load after a Stop (the model card says 'Loading the model again')
  const ready =
    state.doc.status === 'ready' &&
    state.doc.info !== undefined &&
    state.doc.info.chunks > 0 &&
    state.model.status !== 'loading';
  return (
    <main className="grid" data-testid="live">
      <ModelCard
        model={state.model}
        online={online}
        onDownload={() => void controller.download()}
      />
      <CapabilityCard capability={state.capability} />
      <DocumentCard
        doc={state.doc}
        kept={state.kept}
        onFile={(f) => void controller.openFile(f)}
        onKeep={(k) => controller.setKeep(k)}
        onDelete={() => void controller.remove()}
        onUseKept={(id) => void controller.useKept(id)}
        onDeleteKept={(id) => void controller.removeKept(id)}
      />
      <AskCard
        ask={state.ask}
        ready={ready}
        onAsk={(q) => void controller.ask(q)}
        onStop={() => controller.stop()}
      />
    </main>
  );
}
