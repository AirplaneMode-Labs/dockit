/**
 * Fixtures that are generated when a test needs them and never committed: a file one byte over the 20 MiB limit, a PDF with 301
 * pages, and a decompression bomb (a small file whose content stream inflates to more than 1 GiB). Deterministic.
 */
import { createDeflate } from 'node:zlib';

const enc = (s: string) => Buffer.from(s, 'latin1');

/** A file of exactly `size` bytes that starts like a PDF. */
export function oversizePdf(size = 20 * 1024 * 1024 + 1): Buffer {
  const b = Buffer.alloc(size, 0x20);
  b.write('%PDF-1.4\n', 0, 'latin1');
  return b;
}

function assemble(objects: Buffer[], rootId: number): Buffer {
  const parts: Buffer[] = [enc('%PDF-1.4\n')];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([enc(`${i + 1} 0 obj\n`), body, enc('\nendobj\n')]);
    parts.push(chunk);
    offset += chunk.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  parts.push(
    enc(
      `${xref}trailer\n<< /Size ${objects.length + 1} /Root ${rootId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

/** `n` empty pages (objects 1 and 2 are the catalog and the page tree). */
export function manyPagesPdf(n: number): Buffer {
  const objects: Buffer[] = [
    enc('<< /Type /Catalog /Pages 2 0 R >>'),
    enc(
      `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${n} >>`,
    ),
  ];
  for (let i = 0; i < n; i++)
    objects.push(enc('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'));
  return assemble(objects, 1);
}

/** A one-page PDF whose content stream is `inflatedBytes` of spaces deflated: a few hundred KB that expand to more than 1 GiB. */
export async function bombPdf(inflatedBytes = 1024 * 1024 * 1024 + 1): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  const block = Buffer.alloc(1024 * 1024, 0x20);
  for (let written = 0; written < inflatedBytes; written += block.length) {
    const piece =
      written + block.length > inflatedBytes ? block.subarray(0, inflatedBytes - written) : block;
    if (!deflate.write(piece)) await new Promise((r) => deflate.once('drain', r));
  }
  deflate.end();
  await done;
  const data = Buffer.concat(chunks);
  const stream = Buffer.concat([
    enc(`<< /Filter /FlateDecode /Length ${data.length} >>\nstream\n`),
    data,
    enc('\nendstream'),
  ]);
  return assemble(
    [
      enc('<< /Type /Catalog /Pages 2 0 R >>'),
      enc('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      enc('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>'),
      stream,
    ],
    1,
  );
}
