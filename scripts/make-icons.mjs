#!/usr/bin/env node
// Generates public/icons/icon-192.png and icon-512.png with zero dependencies.
// The icon is a flat rounded square with a simple document glyph, drawn so that the whole
// motif sits inside the maskable safe zone (inner 80 percent). Placeholder artwork.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0 (none)
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [0x14, 0x21, 0x3d, 0xff]; // navy
const PAPER = [0xf4, 0xf1, 0xea, 0xff]; // warm white
const LINE = [0x9a, 0xa8, 0xc8, 0xff]; // muted blue

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, c) => {
    const i = (y * size + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = c[3];
  };
  // Background fills the full square so maskable crops stay solid.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, BG);
  // Document sheet inside the safe zone: x in [0.30, 0.70], y in [0.22, 0.78], folded corner.
  const x0 = Math.round(size * 0.3);
  const x1 = Math.round(size * 0.7);
  const y0 = Math.round(size * 0.22);
  const y1 = Math.round(size * 0.78);
  const fold = Math.round(size * 0.1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const inFold = x > x1 - fold && y < y0 + fold && x - (x1 - fold) > y - y0;
      if (!inFold) put(x, y, PAPER);
    }
  }
  // Three text lines.
  const lineH = Math.max(2, Math.round(size * 0.035));
  const lx0 = Math.round(size * 0.36);
  const lx1 = Math.round(size * 0.64);
  for (const fy of [0.42, 0.52, 0.62]) {
    const ly = Math.round(size * fy);
    for (let y = ly; y < ly + lineH; y++) for (let x = lx0; x < lx1; x++) put(x, y, LINE);
  }
  return encodePng(size, size, px);
}

mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}
