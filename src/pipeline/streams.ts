/**
 * S1-107 (TD-70, TD-85): the verdict of pagetriage's account_pdf_streams, judged in the analysis worker before pdf.js is started.
 *
 * pagetriage counts the decoded bytes of EVERY stream in the file (fonts, images, content, forms, everything else, unreferenced objects and
 * earlier revisions included) through a fixed scratch sink, so a font or image bomb is refused before a renderer opens it. dockit calls it with
 * no options (the compiled-in limits only: nothing from the document, the URL, the query string or storage can raise a limit), and reads
 * only the verdict, the reason and the limits. The report's `notes` are never read: they are fixed templates, but they are still the output of
 * a parser that has just read a hostile file.
 *
 * A refusal with a limit reason becomes the pipeline reason stream_limit, with a plain sentence for the kind of part. Everything else, a throw,
 * a trap, 'unaccounted' (lopdf could not vouch for the structure), JSON of another shape, becomes the existing 'corrupt' refusal with
 * STREAMS_UNCHECKED_MESSAGE. The trade (TD-85): a PDF that pdf.js could open but lopdf cannot is now refused; safety comes before availability.
 */

export const STREAMS_SCHEMA = 'pagetriage.streams/0.1';

export const STREAM_LIMIT_REASONS = Object.freeze([
  'font_over_limit',
  'image_over_limit',
  'content_over_limit',
  'other_over_limit',
  'total_over_limit',
  'too_many_streams',
] as const);
export type StreamLimitReason = (typeof STREAM_LIMIT_REASONS)[number];

/** The seven limits the report echoes (bytes, and a count for streams_max). */
export interface StreamLimits {
  font_decoded_max: number;
  image_decoded_max: number;
  image_raster_max: number;
  content_decoded_max: number;
  other_decoded_max: number;
  total_decoded_max: number;
  streams_max: number;
}
const LIMIT_KEYS: readonly (keyof StreamLimits)[] = [
  'font_decoded_max',
  'image_decoded_max',
  'image_raster_max',
  'content_decoded_max',
  'other_decoded_max',
  'total_decoded_max',
  'streams_max',
];

export type StreamsVerdict =
  | { verdict: 'ok' }
  | { verdict: 'refuse'; kind: 'limit'; reason: StreamLimitReason; limits: StreamLimits }
  /** `unaccounted` is true only for a clean, well-formed answer of the accounting that said it could not count (reason 'unaccounted'). */
  | { verdict: 'refuse'; kind: 'unchecked'; unaccounted: boolean };

/** Shown when the structure could not be checked (a throw, a trap, 'unaccounted', or a report of another shape). */
export const STREAMS_UNCHECKED_MESSAGE =
  "This PDF's structure could not be checked safely, so it was refused before it was opened.";

const UNCHECKED: StreamsVerdict = Object.freeze({
  verdict: 'refuse',
  kind: 'unchecked',
  unaccounted: false,
});
const UNACCOUNTED: StreamsVerdict = Object.freeze({
  verdict: 'refuse',
  kind: 'unchecked',
  unaccounted: true,
});

/** A byte count the page can state as a limit: a non-negative integer that is exact as a JavaScript number. */
const isLimit = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function readLimits(raw: unknown): StreamLimits | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const out = {} as Record<string, number>;
  for (const k of LIMIT_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (!isLimit(v)) return undefined;
    out[k] = v;
  }
  return out as unknown as StreamLimits;
}

/** Judges the JSON text account_pdf_streams returned. Never throws: anything but the documented shape is 'unchecked', never a pass. */
export function judgeStreams(text: string): StreamsVerdict {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return UNCHECKED;
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return UNCHECKED;
  const r = j as { schema?: unknown; verdict?: unknown; reason?: unknown; limits?: unknown };
  if (r.schema !== STREAMS_SCHEMA) return UNCHECKED;
  const limits = readLimits(r.limits);
  if (limits === undefined) return UNCHECKED;
  if (r.verdict === 'ok') return r.reason === '' ? { verdict: 'ok' } : UNCHECKED;
  if (r.verdict !== 'refuse') return UNCHECKED;
  if (r.reason === 'unaccounted') return UNACCOUNTED;
  const reason = STREAM_LIMIT_REASONS.find((x) => x === r.reason);
  return reason === undefined ? UNCHECKED : { verdict: 'refuse', kind: 'limit', reason, limits };
}

/** 33554432 gives '32 MiB'; a figure that is not a whole number of MiB keeps one decimal; from 1024 MiB it is stated in GiB. */
function size(bytes: number): string {
  const mib = bytes / 1_048_576;
  if (mib >= 1024) return `${Number((mib / 1024).toFixed(1))} GiB`;
  return `${Number(mib.toFixed(1))} MiB`;
}

const END = 'so it was refused before it was opened.';

/** The plain sentence for a limit, with the number the accounting reported (so a lowered limit reads as lowered). */
export function streamLimitMessage(reason: StreamLimitReason, l: StreamLimits): string {
  switch (reason) {
    case 'font_over_limit':
      return `This PDF holds a font that unpacks to more than ${size(l.font_decoded_max)}, ${END}`;
    case 'image_over_limit':
      return `This PDF holds an image that unpacks to more than ${size(Math.min(l.image_decoded_max, l.image_raster_max))}, ${END}`;
    case 'content_over_limit':
      return `This PDF holds page content that unpacks to more than ${size(l.content_decoded_max)}, ${END}`;
    case 'other_over_limit':
      return `This PDF holds a part that unpacks to more than ${size(l.other_decoded_max)}, ${END}`;
    case 'total_over_limit':
      return `This PDF unpacks to more than ${size(l.total_decoded_max)} in all, ${END}`;
    case 'too_many_streams':
      return `This PDF holds more than ${l.streams_max.toLocaleString('en-US')} parts, more than dockit will check, ${END}`;
  }
}
