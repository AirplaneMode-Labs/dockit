import { describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES } from '../../src/pipeline/limits.ts';
import { Refusal } from '../../src/pipeline/reasons.ts';
import { readPdf } from '../../src/pipeline/read.ts';

const pdfBytes = (head = '%PDF-1.4\n', pad = 0) => {
  const enc = new TextEncoder().encode(head);
  const out = new Uint8Array(enc.length + pad);
  out.set(enc);
  return out;
};

/** A Blob whose arrayBuffer and slice are spied, with a size the test chooses. */
function spiedFile(bytes: Uint8Array, size = bytes.byteLength) {
  const blob = new Blob([bytes as BlobPart]);
  const arrayBuffer = vi.fn(() => blob.arrayBuffer());
  const slice = vi.fn((...a: Parameters<Blob['slice']>) => blob.slice(...a));
  return { file: { size, arrayBuffer, slice } as unknown as Blob, arrayBuffer, slice };
}

describe('read stage', () => {
  it('refuses a file one byte over 20 MiB as too_large BEFORE any arrayBuffer() or slice() call', async () => {
    const { file, arrayBuffer, slice } = spiedFile(pdfBytes(), MAX_FILE_BYTES + 1);
    await expect(readPdf(file)).rejects.toMatchObject({ name: 'Refusal', reason: 'too_large' });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
  });

  it('accepts a file of exactly 20 MiB for the size check (it is then read)', async () => {
    const { file, arrayBuffer } = spiedFile(pdfBytes(), MAX_FILE_BYTES);
    // the spied size claims 20 MiB while the body is tiny: the read itself must still succeed
    const r = await readPdf(file);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(r.bytes.byteLength).toBeLessThan(100);
  });

  it('MAX_FILE_BYTES is 20,971,520', () => {
    expect(MAX_FILE_BYTES).toBe(20_971_520);
  });

  it('refuses a file with no %PDF- in the first 1024 bytes as not_pdf', async () => {
    const { file } = spiedFile(new TextEncoder().encode('hello world, not a pdf'));
    await expect(readPdf(file)).rejects.toMatchObject({ reason: 'not_pdf' });
  });

  it('%PDF- ending inside the first 1024 bytes (offset 1019) is a PDF; starting at offset 1020 it is not', async () => {
    const mk = (offset: number) => {
      const b = new Uint8Array(offset + 20);
      b.fill(0x20);
      b.set(new TextEncoder().encode('%PDF-1.7\n'), offset);
      return b;
    };
    await expect(readPdf(spiedFile(mk(1020)).file)).rejects.toMatchObject({ reason: 'not_pdf' });
    await expect(readPdf(spiedFile(mk(1019)).file)).resolves.toBeDefined();
    await expect(readPdf(spiedFile(mk(0)).file)).resolves.toBeDefined();
  });

  it('docId is the first 32 hex characters of the SHA-256 of the bytes, and sha256 is the whole digest', async () => {
    // sha256("abc") = ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad ; the PDF header is required, so use the known digest of a fixed body
    const body = pdfBytes('%PDF-1.4\nabc');
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', body)).toString('hex');
    const r = await readPdf(spiedFile(body).file);
    expect(r.sha256).toBe(digest);
    expect(r.docId).toBe(digest.slice(0, 32));
    expect(r.docId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.bytes).toEqual(body);
  });

  it('an unreadable file (arrayBuffer rejects) is corrupt, never an unhandled error', async () => {
    const file = {
      size: 10,
      arrayBuffer: () => Promise.reject(new Error('boom')),
    } as unknown as Blob;
    await expect(readPdf(file)).rejects.toBeInstanceOf(Refusal);
    await expect(readPdf(file)).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('an empty file is not_pdf', async () => {
    await expect(readPdf(spiedFile(new Uint8Array(0)).file)).rejects.toMatchObject({
      reason: 'not_pdf',
    });
  });
});
