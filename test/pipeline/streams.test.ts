import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STREAMS_UNCHECKED_MESSAGE,
  STREAM_LIMIT_REASONS,
  judgeStreams,
  streamLimitMessage,
  type StreamLimits,
} from '../../src/pipeline/streams.ts';

// S1-107 (TD-70, TD-85): pagetriage's account_pdf_streams counts the decoded bytes of every stream in the file, through a fixed scratch sink,
// before pdf.js is started. dockit gives it no options (compiled-in defaults only), judges its canonical JSON, and refuses in plain words.
// Anything that is not exactly the documented shape is never a pass.

const LIMITS: StreamLimits = {
  font_decoded_max: 33_554_432,
  image_decoded_max: 268_435_456,
  image_raster_max: 268_435_456,
  content_decoded_max: 67_108_864,
  other_decoded_max: 67_108_864,
  total_decoded_max: 536_870_912,
  streams_max: 3_000_000,
};
const kind = { count: 0, raw_bytes: 0, decoded_bytes: 0, max_decoded_bytes: 0, over_limit: false };
const report = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'pagetriage.streams/0.1',
    verdict: 'ok',
    reason: '',
    limits: LIMITS,
    streams: {
      count: 1,
      by_kind: { font: kind, image: kind, content: kind, form: kind, other: kind },
      total_decoded_bytes: 0,
      decoded_capped: false,
      early_stop: false,
    },
    notes: [],
    ...over,
  });

describe('judging the stream accounting', () => {
  it('verdict ok with no reason is ok', () => {
    expect(judgeStreams(report())).toEqual({ verdict: 'ok' });
  });

  it.each(STREAM_LIMIT_REASONS)(
    'verdict refuse with the limit reason %s is a limit refusal that carries the limits',
    (reason) => {
      expect(judgeStreams(report({ verdict: 'refuse', reason }))).toEqual({
        verdict: 'refuse',
        kind: 'limit',
        reason,
        limits: LIMITS,
      });
    },
  );

  it("'unaccounted' (the parser could not vouch for the structure) is unchecked, not a limit, and says that it was a clean answer of the accounting", () => {
    expect(judgeStreams(report({ verdict: 'refuse', reason: 'unaccounted' }))).toEqual({
      verdict: 'refuse',
      kind: 'unchecked',
      unaccounted: true,
    });
  });

  it('anything that is not exactly the documented shape is unchecked, never a pass', () => {
    const bad: unknown[] = [
      'not json',
      '',
      '[]',
      'null',
      report({ schema: 'pagetriage.streams/0.2' }),
      report({ schema: undefined }),
      report({ verdict: 'maybe' }),
      report({ verdict: 'ok', reason: 'font_over_limit' }), // an ok that names a reason contradicts itself
      report({ verdict: 'refuse', reason: '' }),
      report({ verdict: 'refuse', reason: 'something_new' }),
      report({
        verdict: 'refuse',
        reason: 'font_over_limit',
        limits: { ...LIMITS, font_decoded_max: -1 },
      }),
      report({
        verdict: 'refuse',
        reason: 'font_over_limit',
        limits: { ...LIMITS, font_decoded_max: 1.5 },
      }),
      report({
        verdict: 'refuse',
        reason: 'font_over_limit',
        limits: { ...LIMITS, font_decoded_max: 2 ** 60 },
      }),
      report({
        verdict: 'refuse',
        reason: 'font_over_limit',
        limits: { ...LIMITS, font_decoded_max: '32' },
      }),
      report({ verdict: 'refuse', reason: 'font_over_limit', limits: undefined }),
      report({ verdict: 'ok', limits: undefined }),
    ];
    for (const b of bad)
      expect(judgeStreams(b as string), String(b).slice(0, 60)).toEqual({
        verdict: 'refuse',
        kind: 'unchecked',
        unaccounted: false, // anything but the documented shape is not a clean answer
      });
  });

  it("the report's notes are never read: text a hostile document put into them reaches nothing", () => {
    const j = judgeStreams(
      report({
        verdict: 'refuse',
        reason: 'font_over_limit',
        notes: ['SENTINEL-NOTE-FROM-THE-DOCUMENT'],
      }),
    );
    expect(JSON.stringify(j)).not.toContain('SENTINEL');
    expect(streamLimitMessage('font_over_limit', LIMITS)).not.toContain('SENTINEL');
  });
});

describe('the plain sentence for each limit', () => {
  it('a font: the documented example, with the limit the accounting reported', () => {
    expect(streamLimitMessage('font_over_limit', LIMITS)).toBe(
      'This PDF holds a font that unpacks to more than 32 MiB, so it was refused before it was opened.',
    );
  });

  it('one sentence per kind, each ending in "refused before it was opened", with no code name and no "free RAM"', () => {
    const want: Record<(typeof STREAM_LIMIT_REASONS)[number], string> = {
      font_over_limit: 'a font that unpacks to more than 32 MiB',
      image_over_limit: 'an image that unpacks to more than 256 MiB',
      content_over_limit: 'page content that unpacks to more than 64 MiB',
      other_over_limit: 'a part that unpacks to more than 64 MiB',
      total_over_limit: 'more than 512 MiB in all',
      too_many_streams: 'more than 3,000,000 parts',
    };
    for (const r of STREAM_LIMIT_REASONS) {
      const m = streamLimitMessage(r, LIMITS);
      expect(m, r).toContain(want[r]);
      expect(m, r).toMatch(/so it was refused before it was opened\.$/);
      expect(m, r).not.toMatch(/_|free RAM/i);
      expect(new Set(STREAM_LIMIT_REASONS.map((x) => streamLimitMessage(x, LIMITS))).size).toBe(6);
    }
  });

  it('the number is the one the accounting reported, so a lowered limit reads as lowered', () => {
    expect(
      streamLimitMessage('font_over_limit', { ...LIMITS, font_decoded_max: 8_388_608 }),
    ).toContain('more than 8 MiB');
    expect(
      streamLimitMessage('image_over_limit', { ...LIMITS, image_raster_max: 134_217_728 }),
    ).toContain('more than 128 MiB');
  });

  it('the unchecked sentence is the documented one', () => {
    expect(STREAMS_UNCHECKED_MESSAGE).toBe(
      "This PDF's structure could not be checked safely, so it was refused before it was opened.",
    );
  });
});

// S1-107 (TD-85): the accounting is called with the compiled-in limits only. No limit may come from the document, the URL, the query string or storage, so the
// one call in the source passes `undefined` as the options, and nothing else in src/ calls it.
describe('the accounting is called with no options, from one place', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const f = join(dir, n);
      return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(n) ? [f] : [];
    });
  const src = join(import.meta.dirname, '..', '..', 'src');
  it('exactly one call of account_pdf_streams in src/, on the pagetriage module, with undefined as the options', () => {
    const calls = walk(src).flatMap((f) =>
      [
        ...readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
          .matchAll(/\.account_pdf_streams\s*\(([^)]*\)?[^)]*)\)/g),
      ].map((m) => ({
        file: f
          .slice(src.length + 1)
          .split('\\')
          .join('/'),
        args: m[1]!.replace(/\s+/g, ' ').trim(),
      })),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('workers/analysis-core.ts');
    expect(calls[0]!.args).toBe('new Uint8Array(req.bytes), undefined');
    // the worker script only forwards the export; it never builds an options string
    expect(readFileSync(join(src, 'workers', 'analysis-worker.ts'), 'utf8')).not.toMatch(
      /opts_json|JSON\.stringify/,
    );
  });
});
