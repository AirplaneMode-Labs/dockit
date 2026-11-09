import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('dockit: #root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker is registered in production builds only. The dev server has no
// precache manifest and strips the CSP meta for the fast-refresh preamble.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err: unknown) => {
      console.warn('dockit: service worker registration failed', err);
    });
  });
}
