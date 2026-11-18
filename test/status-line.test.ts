import { readFileSync } from 'node:fs';
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

  it('is a Sprint 5 line: Working and Not yet, the done-when facts, 8 GB not measured, and no claim that Sprint 5 is met', () => {
    expect(SPRINT_STATUS_LINE).toMatch(/^Sprint 5 \(18 Nov 2026\): Working: .* Not yet: .*\.$/);
    expect(SPRINT_STATUS_LINE).toContain('not measured on 8 GB');
    expect(SPRINT_STATUS_LINE).toContain('OCR');
    expect(SPRINT_STATUS_LINE).toContain('WebLLM (cut)');
    expect(SPRINT_STATUS_LINE).toContain('the live page changes only after the owner pushes');
    expect(SPRINT_STATUS_LINE).not.toMatch(/\bmet\b/);
    expect(SPRINT_STATUS_LINE).not.toMatch(/compliance|cheaper|cost/i);
  });
});
