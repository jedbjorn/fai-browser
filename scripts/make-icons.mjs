#!/usr/bin/env node
// Generates the extension icons (extension/icons/icon-16|32|48|128.png): an amber rounded square with a cream "F"
// and a small toolbar-click dot, drawn from rectangles with 4x4 supersampling and written as RGBA PNGs with node:zlib.
// No dependencies. Rerun after changing the design: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = join(import.meta.dirname, '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const AMBER = [166, 110, 32];
const AMBER_DARK = [135, 88, 20];
const CREAM = [250, 245, 235];

// Shapes in a 0..1 unit square.
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function sample(x, y) {
  if (!inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return null;
  // The letter F: stem, top bar, middle bar.
  const letter = inRect(x, y, 0.29, 0.2, 0.43, 0.8) || inRect(x, y, 0.29, 0.2, 0.74, 0.33)
    || inRect(x, y, 0.29, 0.45, 0.64, 0.57);
  if (letter) return CREAM;
  // A small dot at the bottom right: the click that approves.
  if (inCircle(x, y, 0.72, 0.72, 0.085)) return CREAM;
  // A subtle darker lower half for depth.
  return y > 0.5 ? AMBER_DARK.map((value, i) => Math.round(value + (AMBER[i] - value) * (1 - (y - 0.5) * 2) * 0.6)) : AMBER;
}

function render(size) {
  const ss = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const color = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          a++;
        }
      }
      const offset = (py * size + px) * 4;
      if (a) {
        pixels[offset] = Math.round(r / a);
        pixels[offset + 1] = Math.round(g / a);
        pixels[offset + 2] = Math.round(b / a);
      }
      pixels[offset + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  writeFileSync(join(OUT, `icon-${size}.png`), png(size, render(size)));
}
console.log(`Wrote ${SIZES.map(size => `icon-${size}.png`).join(', ')} to ${OUT}`);
