import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusLine } from '../src/status-line.tsx';
import { SPRINT_STATUS_LINE } from '../src/status-line-text.ts';

const unescape = (s: string) =>
  s
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"');

describe('dockit #sprint-status element (T1-S4-R1-05)', () => {
  it('renders id="sprint-status" whose text node equals the constant', () => {
    const html = renderToStaticMarkup(createElement(StatusLine));
    const m = /^<p [^>]*id="sprint-status"[^>]*>([\s\S]*)<\/p>$/.exec(html);
    expect(m).not.toBeNull();
    expect(unescape(m![1]!)).toBe(SPRINT_STATUS_LINE);
  });

  it('App renders the component, and index.html and offline.html carry no status text', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<StatusLine />');
    expect(readFileSync(new URL('../src/status-line.tsx', import.meta.url), 'utf8')).not.toMatch(
      /innerHTML|dangerouslySetInnerHTML/,
    );
    for (const f of ['../index.html', '../public/offline.html']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).not.toContain('sprint-status');
    }
  });

  it('equals the dockit line in site/data/demos.json when the site repo is beside this one', () => {
    const p = new URL('../../site/data/demos.json', import.meta.url);
    if (!existsSync(p)) return;
    const demos = JSON.parse(readFileSync(p, 'utf8')) as { repo: string; status: string }[];
    expect(demos.find((d) => d.repo === 'dockit')?.status).toBe(SPRINT_STATUS_LINE);
  });
});
