/**
 * Generates the packaged extension icons.
 *
 * The icons are committed, so this script is only re-run when the mark changes.
 * It exists instead of a binary-only asset so the mark is reviewable as code and
 * so the build never needs an image toolchain.
 *
 * Mark: a survey/GIS reticle — dark slate plate, teal graticule, an amber
 * traverse polyline and a station point.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../extension/public/icons');

const PLATE = [15, 23, 32, 255];
const GRID = [45, 130, 140, 255];
const ACCENT = [16, 185, 168, 255];
const AMBER = [245, 176, 65, 255];
const CLEAR = [0, 0, 0, 0];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const px = pixels[y * size + x];
      raw[p++] = px[0];
      raw[p++] = px[1];
      raw[p++] = px[2];
      raw[p++] = px[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const px = new Array(size * size).fill(CLEAR);
  const s = (v) => Math.round((v * size) / 128);
  const set = (x, y, c) => {
    if (x >= 0 && y >= 0 && x < size && y < size) px[y * size + x] = c;
  };
  const r = size / 2 - s(4);
  const cx = size / 2;
  const cy = size / 2;

  // Rounded plate.
  const corner = s(26);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(corner - x, x - (size - 1 - corner), 0);
      const dy = Math.max(corner - y, y - (size - 1 - corner), 0);
      if (Math.hypot(dx, dy) <= corner) set(x, y, PLATE);
    }
  }

  // Graticule: two rings plus cross hairs.
  const ring = (radius, thickness, colour) => {
    for (let a = 0; a < 2880; a++) {
      const t = (a / 2880) * Math.PI * 2;
      for (let w = 0; w < thickness; w++) {
        set(Math.round(cx + Math.cos(t) * (radius - w)), Math.round(cy + Math.sin(t) * (radius - w)), colour);
      }
    }
  };
  ring(r - s(6), Math.max(1, s(3)), GRID);
  ring(r - s(26), Math.max(1, s(2)), GRID);

  const tick = Math.max(1, s(3));
  for (let i = -r + s(4); i <= r - s(4); i++) {
    for (let w = 0; w < tick; w++) {
      set(Math.round(cx + i), Math.round(cy + w - tick / 2), GRID);
      set(Math.round(cx + w - tick / 2), Math.round(cy + i), GRID);
    }
  }

  // Traverse polyline over the reticle.
  const legs = [
    [-30, 18],
    [-8, -6],
    [14, 10],
    [32, -22],
  ].map(([x, y]) => [cx + s(x), cy + s(y)]);
  const width = Math.max(1, s(5));
  for (let i = 0; i < legs.length - 1; i++) {
    const [x0, y0] = legs[i];
    const [x1, y1] = legs[i + 1];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2;
    for (let t = 0; t <= steps; t++) {
      const x = x0 + ((x1 - x0) * t) / steps;
      const y = y0 + ((y1 - y0) * t) / steps;
      for (let ox = -width; ox <= width; ox++) {
        for (let oy = -width; oy <= width; oy++) {
          if (ox * ox + oy * oy <= width * width) set(Math.round(x + ox), Math.round(y + oy), AMBER);
        }
      }
    }
  }

  // Station point at the centre.
  const dot = Math.max(2, s(9));
  for (let ox = -dot; ox <= dot; ox++) {
    for (let oy = -dot; oy <= dot; oy++) {
      if (ox * ox + oy * oy <= dot * dot) set(Math.round(cx + ox), Math.round(cy + oy), ACCENT);
    }
  }
  return px;
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(resolve(outDir, `icon-${size}.png`), encodePng(size, draw(size)));
  process.stdout.write(`icon-${size}.png\n`);
}
