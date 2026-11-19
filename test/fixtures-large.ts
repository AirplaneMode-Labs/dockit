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

/** `inflatedBytes` bytes of `fill` through zlib at level 9: a few hundred KB that expand to more than 1 GiB. Streamed in 1 MiB blocks. */
async function deflateFill(inflatedBytes: number, fill: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  const block = Buffer.alloc(1024 * 1024, fill);
  for (let written = 0; written < inflatedBytes; written += block.length) {
    const piece =
      written + block.length > inflatedBytes ? block.subarray(0, inflatedBytes - written) : block;
    if (!deflate.write(piece)) await new Promise((r) => deflate.once('drain', r));
  }
  deflate.end();
  await done;
  return Buffer.concat(chunks);
}

/** A one-page PDF whose content stream is `inflatedBytes` of spaces deflated: a few hundred KB that expand to more than 1 GiB. */
export async function bombPdf(inflatedBytes = 1024 * 1024 * 1024 + 1): Promise<Buffer> {
  const data = await deflateFill(inflatedBytes, 0x20);
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

const TEXT_PAGE =
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
const TEXT_CONTENT = 'BT /F1 12 Tf 10 100 Td (grace period 45 days) Tj ET';
const rawStream = (dict: string, body: Buffer): Buffer =>
  Buffer.concat([enc(`<< ${dict} /Length ${body.length} >>\nstream\n`), body, enc('\nendstream')]);

/**
 * S1-107: a text page (it reads "grace period 45 days") whose embedded TrueType font file, FontFile2, is `inflatedBytes` of zeros deflated. The
 * page is otherwise ordinary, so a reader that does not count the font opens it: a few hundred KB that make pdf.js inflate 1 GiB in its worker.
 */
export async function fontBombPdf(inflatedBytes = 1024 * 1024 * 1024 + 1): Promise<Buffer> {
  const font = await deflateFill(inflatedBytes, 0x00);
  return assemble(
    [
      enc('<< /Type /Catalog /Pages 2 0 R >>'),
      enc('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      enc(TEXT_PAGE),
      rawStream('', enc(TEXT_CONTENT)),
      enc(
        '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Bomb /FirstChar 32 /LastChar 32 /Widths [500] /FontDescriptor 6 0 R >>',
      ),
      enc(
        '<< /Type /FontDescriptor /FontName /AAAAAA+Bomb /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>',
      ),
      rawStream(`/Length1 ${inflatedBytes} /Filter /FlateDecode`, font),
    ],
    1,
  );
}

/**
 * S1-107: a one-page PDF with an image XObject, DeviceGray 8 bits, declared 32768 x 32768, whose Flate stream is `inflatedBytes` of zeros:
 * more than 1 GiB decoded, and a declared raster of 32768 x 32768 x 4 bytes (4 GiB) once pdf.js makes it RGBA.
 */
export async function imageBombPdf(inflatedBytes = 1024 * 1024 * 1024 + 1): Promise<Buffer> {
  const image = await deflateFill(inflatedBytes, 0x00);
  return assemble(
    [
      enc('<< /Type /Catalog /Pages 2 0 R >>'),
      enc('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      enc(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
      ),
      rawStream('', enc('q 200 0 0 200 0 0 cm /Im1 Do Q')),
      rawStream(
        '/Type /XObject /Subtype /Image /Width 32768 /Height 32768 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
        image,
      ),
    ],
    1,
  );
}

/**
 * S1-107 (TD-85): an ordinary one-page text PDF whose startxref points past the end of the file. pdf.js repairs the cross-reference table by
 * scanning for objects and reads the text; pagetriage's accounting needs a loadable table (lopdf rejects this file, or needs a repair), so it
 * cannot vouch for the structure: the file is refused before pdf.js is opened, by design (safety before availability).
 */
export function brokenXrefPdf(): Buffer {
  const good = assemble(
    [
      enc('<< /Type /Catalog /Pages 2 0 R >>'),
      enc('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      enc(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      ),
      rawStream('', enc(TEXT_CONTENT)),
      enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    ],
    1,
  );
  return Buffer.from(
    good.toString('latin1').replace(/startxref\n\d+\n%%EOF\n$/, 'startxref\n999999\n%%EOF\n'),
    'latin1',
  );
}
