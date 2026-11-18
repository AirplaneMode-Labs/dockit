/**
 * The Devanagari gate in Chrome (D5-10, never dropped). Local-only: `npm run test:gate`. Two synthetic Hindi PDFs go through REAL pdf.js extraction and
 * the REAL glyphsift WASM gate in the built app: the clean page passes and is indexed, the damaged page is held with held_low_score (shown with its
 * ppm and threshold) and is not indexed, so nothing of it can ever be retrieved. The embedder is the real one (the pipeline embeds what the gate lets
 * through); no language model is asked anything. Hindi answer quality is claimed nowhere.
 */
import { expect, test } from 'playwright/test';
import * as playwright from 'playwright';
import { join } from 'node:path';
import * as h from '../scripts/lib/e2e-harness.mjs';

const pdf = (n: string) => join(import.meta.dirname, 'fixtures', 'pdf', n);
let srv: Awaited<ReturnType<typeof h.startServer>>;
let s: Awaited<ReturnType<typeof h.launch>>;

test.beforeAll(async () => {
  srv = await h.startServer({ port: 4433 });
  s = await h.launch(playwright, { profileDir: h.newProfileDir(), watch: false });
  await h.waitReady(s.page, srv.base);
  const d = await h.downloadModel(s.page);
  expect(d.status).toBe('cached');
});
test.afterAll(async () => {
  await s?.close();
  await srv?.close();
});

test('deva-clean.pdf: pagetriage calls it text, the gate passes the chunk, and it is indexed', async () => {
  const r = await h.openPdf(s.page, pdf('deva-clean.pdf'));
  expect(r.ok, r.refusal).toBe(true);
  expect(r.summary).toMatch(/1 pages, 1 passages indexed\./);
  await expect(s.page.getByTestId('held-chunks')).toHaveCount(0);
  await expect(s.page.getByTestId('skipped-pages')).toHaveCount(0);
  const stages = (await h.readEvents(s.page)).filter((e) => e.name === 'pipeline.stage');
  const gate = stages.filter((e) => e.attrs.stage === 'gate').at(-1)!;
  expect(gate.attrs).toMatchObject({ outcome: 'ok', held: 0, chunks: 1 });
});

test('deva-noised.pdf: the same page with damage is HELD with held_low_score, shown with ppm and threshold, and not indexed', async () => {
  const r = await h.openPdf(s.page, pdf('deva-noised.pdf'));
  expect(r.ok, r.refusal).toBe(true);
  expect(r.summary).toMatch(/1 pages, 0 passages indexed, 1 held back\./);
  const held = s.page.getByTestId('held-chunks');
  await expect(held).toContainText('held_low_score');
  const text = await held.innerText();
  const ppm = Number(/Score (\d+) ppm/.exec(text)?.[1]);
  const threshold = Number(/threshold (\d+) ppm/.exec(text)?.[1]);
  expect(threshold).toBe(975000);
  expect(ppm).toBeLessThan(threshold);
  const stages = (await h.readEvents(s.page)).filter((e) => e.name === 'pipeline.stage');
  const gate = stages.filter((e) => e.attrs.stage === 'gate').at(-1)!;
  expect(gate.attrs).toMatchObject({ held: 1 });
  // nothing of the held chunk is searchable: with no passage indexed the question box is disabled, so no question can reach the store
  await expect(s.page.getByTestId('question')).toBeDisabled();
  await expect(s.page.getByTestId('ask')).toBeDisabled();
});
