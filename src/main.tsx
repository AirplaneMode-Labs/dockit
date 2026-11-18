import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import type { AppController } from './app/controller.ts';
import { createAppController, events } from './app/wiring.ts';
import './styles.css';
import { registerServiceWorker } from './trusted-types.ts';

const root = document.getElementById('root');
if (!root) throw new Error('dockit: #root missing');

/** Starts the controller once, after the first paint; a failure is shown on the page, never thrown into the void. */
function Boot() {
  const [controller, setController] = useState<AppController | Error | undefined>(undefined);
  useEffect(() => {
    if (window.top !== window.self) return; // a framed copy starts nothing
    let live = true;
    createAppController().then(
      (c) => {
        if (!live) return;
        setController(c);
        void c.init();
      },
      (e: unknown) => live && setController(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      live = false;
    };
  }, []);
  return <App controller={controller} events={events} />;
}

createRoot(root).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);

// The service worker is registered in production builds only. The dev server has no
// precache manifest and strips the CSP meta for the fast-refresh preamble.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    registerServiceWorker(
      navigator.serviceWorker as never,
      window.trustedTypes,
      document.baseURI,
    ).catch((err: unknown) => {
      console.warn('dockit: service worker registration failed', err);
    });
  });
}
