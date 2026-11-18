/**
 * Aimed tampering with a model manifest, for the e2e tamper cases (BUG-T1-S5-02).
 *
 * A tamper test proves the signature check only when the flipped byte keeps the file valid JSON and changes a signed value. The manifest that
 * runtime's bundle-models writes is pretty-printed ('"sha256": "<hex>"', one space after the colon), so a lookup for the compact
 * '"sha256":"' never matches. The aim here is whitespace-tolerant and assertWellAimed() fails the test loudly when the flip is not what
 * it claims to be, instead of letting a refusal for the wrong reason pass.
 */

const HASH_VALUE = /"sha256":\s*"([0-9a-f]{64})"/gu;
const HEX = '0123456789abcdef';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Offset (in bytes: the manifest is ASCII) of the third hex digit of the first sha256 value. Throws when there is no sha256 value. */
export function hashDigitOffset(text: string): number {
  const m = /"sha256":\s*"/u.exec(text);
  if (m === null) throw new Error('no "sha256" member found: the manifest has no hash to aim at');
  return m.index + m[0].length + 2;
}

export interface Flip {
  bytes: Uint8Array;
  offset: number;
  before: string;
  after: string;
}

/** A copy with one hex digit of the first sha256 value replaced by the next hex digit (wrapping): still a 64-digit hash, still valid JSON. */
export function flipHashDigit(bytes: Uint8Array): Flip {
  const out = new Uint8Array(bytes);
  const offset = hashDigitOffset(decode(bytes));
  const before = String.fromCharCode(out[offset]!);
  const at = HEX.indexOf(before);
  if (at < 0) throw new Error(`byte ${offset} is ${JSON.stringify(before)}, not a hex digit`);
  const after = HEX[(at + 1) % 16]!;
  out[offset] = after.charCodeAt(0);
  return { bytes: out, offset, before, after };
}

/** The explicit parse-failure case: the opening brace becomes '[', so the manifest is no longer valid JSON. One byte differs. */
export function breakJson(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  const at = out.indexOf(0x7b); // '{'
  if (at < 0) throw new Error('no { to break');
  out[at] = 0x5b; // '['
  return out;
}

/**
 * Throws unless `tampered` differs from `original` in exactly one byte, that byte is a hex digit in both, it lies inside a sha256 value, and
 * the tampered text still parses as JSON.
 */
export function assertWellAimed(original: Uint8Array, tampered: Uint8Array): void {
  if (original.length !== tampered.length)
    throw new Error(`length changed: ${original.length} -> ${tampered.length}`);
  const at: number[] = [];
  original.forEach((b, i) => {
    if (tampered[i] !== b) at.push(i);
  });
  if (at.length !== 1) throw new Error(`exactly one byte must differ, ${at.length} do`);
  const i = at[0]!;
  const was = String.fromCharCode(original[i]!);
  const now = String.fromCharCode(tampered[i]!);
  if (!/^[0-9a-f]$/u.test(was) || !/^[0-9a-f]$/u.test(now))
    throw new Error(
      `byte ${i}: ${JSON.stringify(was)} -> ${JSON.stringify(now)} is not a hex digit`,
    );
  const text = decode(original);
  const inside = [...text.matchAll(HASH_VALUE)].some((m) => {
    const start = m.index + m[0].indexOf(m[1]!);
    return i >= start && i < start + 64;
  });
  if (!inside) throw new Error(`byte ${i} is not inside a sha256 value`);
  try {
    JSON.parse(decode(tampered));
  } catch (e) {
    throw new Error(`the tampered manifest no longer parses: ${(e as Error).message}`);
  }
}
