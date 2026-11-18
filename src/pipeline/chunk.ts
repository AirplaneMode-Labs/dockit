import {
  CHUNK_MAX,
  CHUNK_MAX_PAGES,
  CHUNK_OVERLAP,
  CHUNK_PAGE_BREAK_MIN,
  CHUNK_TARGET,
} from './limits.ts';

export interface PageText {
  /** 1-based page number. */
  page: number;
  text: string;
}

export interface Chunk {
  ordinal: number;
  pageStart: number;
  pageEnd: number;
  text: string;
}

/**
 * NFC, then well-formed (an unpaired surrogate becomes U+FFFD), CR and CRLF to LF, runs of horizontal whitespace to one space, at most one
 * blank line, trimmed. ZWNJ and ZWJ are kept. pdf.js can emit an unpaired surrogate from a broken ToUnicode map, and NFC keeps it; the gate,
 * embed() and putDocument() all refuse an ill-formed string, so it is repaired here, once, before anything is chunked (BUG-T2-S5-10).
 * String.prototype.toWellFormed is Chrome 111+, which is the floor of the app anyway.
 */
export function normaliseText(s: string): string {
  return s
    .normalize('NFC')
    .toWellFormed()
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ ?\n ?/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

interface Part {
  page: number;
  text: string;
}

/** Ends a segment at a blank line, a danda, a sentence end followed by a space or newline, or a newline. */
const BOUNDARY = /\n{2,}|।[ ]?|[.!?](?:[ ]|\n+)|\n/gu;

/** A cut position at most `max` units in, preferring whitespace in the last fifth, never inside a surrogate pair. */
function cutAt(s: string, max: number): number {
  let cut = max;
  const ws = s.slice(Math.floor(max * 0.8), max).search(/\s\S*$/u);
  if (ws >= 0) cut = Math.floor(max * 0.8) + ws + 1;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return cut;
}

function segmentsOf(page: number, text: string): Part[] {
  const out: Part[] = [];
  let from = 0;
  const push = (piece: string) => {
    let rest = piece;
    while (rest.length > CHUNK_MAX) {
      const cut = cutAt(rest, CHUNK_MAX);
      out.push({ page, text: rest.slice(0, cut) });
      rest = rest.slice(cut);
    }
    if (rest.length > 0) out.push({ page, text: rest });
  };
  for (const m of text.matchAll(BOUNDARY)) {
    const end = m.index! + m[0].length;
    push(text.slice(from, end));
    from = end;
  }
  if (from < text.length) push(text.slice(from));
  return out;
}

const distinctPages = (parts: Part[], extra?: number): number =>
  new Set([...parts.map((p) => p.page), ...(extra === undefined ? [] : [extra])]).size;
const lengthOf = (parts: Part[]): number => parts.reduce((n, p) => n + p.text.length, 0);

/** The tail of a finished chunk, at most CHUNK_OVERLAP units, starting at a word start (none if there is no whitespace). */
function overlapOf(parts: Part[]): Part[] {
  const joined = parts.map((p) => p.text).join('');
  const tail = joined.slice(-CHUNK_OVERLAP);
  const first = tail.search(/\s/u);
  if (first < 0) return [];
  const skip = joined.length - tail.length + first + 1; // units of `joined` to drop from the front
  const out: Part[] = [];
  let seen = 0;
  for (const p of parts) {
    const end = seen + p.text.length;
    if (end > skip) out.push({ page: p.page, text: p.text.slice(Math.max(0, skip - seen)) });
    seen = end;
  }
  const text = out.map((p) => p.text).join('');
  return text.trim() === '' ? [] : out;
}

/** Deterministic chunking (D5-05 stage 4): target 700, max 1000, overlap 100, at most 2 pages per chunk. */
export function chunkPages(pages: PageText[]): Chunk[] {
  const segs: Part[] = [];
  const nonEmpty = pages
    .map((p) => ({ page: p.page, text: normaliseText(p.text) }))
    .filter((p) => p.text !== '');
  nonEmpty.forEach((p, i) =>
    segs.push(...segmentsOf(p.page, i < nonEmpty.length - 1 ? `${p.text}\n\n` : p.text)),
  );

  const chunks: Chunk[] = [];
  let parts: Part[] = [];
  let fresh = 0;
  let freshUnits = 0;
  const flush = () => {
    if (fresh === 0) return;
    const last = parts[parts.length - 1]!;
    last.text = last.text.trimEnd();
    if (last.text === '') parts.pop();
    const text = parts.map((p) => p.text).join('');
    if (text !== '') {
      chunks.push({
        ordinal: chunks.length,
        pageStart: parts[0]!.page,
        pageEnd: parts[parts.length - 1]!.page,
        text,
      });
    }
    parts = overlapOf(parts);
    fresh = 0;
    freshUnits = 0;
  };

  for (const seg of segs) {
    if (fresh > 0) {
      const len = lengthOf(parts);
      // a chunk of a reasonable size is closed at a page boundary, so that its citation names the page its text is on
      const pageBreak =
        seg.page !== parts[parts.length - 1]!.page && freshUnits >= CHUNK_PAGE_BREAK_MIN;
      if (
        len >= CHUNK_TARGET ||
        len + seg.text.length > CHUNK_MAX ||
        distinctPages(parts, seg.page) > CHUNK_MAX_PAGES ||
        pageBreak
      )
        flush();
    }
    if (fresh === 0 && parts.length > 0) {
      // a new chunk starts with the overlap; drop it when it would not leave room, or when it comes from another page than the
      // text that follows (the cited pages must contain the whole chunk text)
      const room = lengthOf(parts) + 1 + seg.text.length <= CHUNK_MAX;
      if (!room || parts.some((p) => p.page !== seg.page)) parts = [];
      else parts[parts.length - 1]!.text += ' ';
    }
    parts.push(seg);
    fresh += 1;
    freshUnits += seg.text.length;
  }
  flush();
  return chunks;
}
