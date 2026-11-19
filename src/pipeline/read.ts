import { HEAD_SCAN_BYTES, MAX_FILE_BYTES } from './limits.ts';
import { Refusal } from './reasons.ts';

export interface ReadResult {
  bytes: Uint8Array;
  sha256: string;
  /** The first 32 hex characters of the SHA-256 of the bytes. */
  docId: string;
}

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** The SHA-256 of the bytes, lower-case hex (what the read stage records and the extract stage re-checks). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/**
 * Stage 1. The size is checked from File.size FIRST: an oversize file is never read, sliced or copied.
 * Then the bytes are read once, '%PDF-' must appear in the first 1024 bytes, and the document id is derived.
 */
export async function readPdf(file: Blob): Promise<ReadResult> {
  if (file.size > MAX_FILE_BYTES) throw new Refusal('too_large');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Refusal('corrupt');
  }
  const head = bytes.subarray(0, HEAD_SCAN_BYTES);
  const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  let found = false;
  for (let i = 0; i + MAGIC.length <= head.length && !found; i++)
    found = MAGIC.every((b, k) => head[i + k] === b);
  if (!found) throw new Refusal('not_pdf');
  const digest = await sha256Hex(bytes);
  return { bytes, sha256: digest, docId: digest.slice(0, 32) };
}
