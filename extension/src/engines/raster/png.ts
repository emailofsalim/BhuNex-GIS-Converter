/**
 * A minimal PNG encoder: 8-bit grey, RGB and RGBA.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * All of this already existed, complete and correct, as private functions
 * inside `pdf-image.ts` — where it had been written to re-container a scanned
 * page. A general image encoder locked inside the one module that happened to
 * need it first is this codebase's recurring defect in its quietest form: the
 * next caller cannot see it, so the next caller writes it again or does
 * without. `GroundOverlay` is that next caller — a KMZ cannot drape a raster
 * over Google Earth without image bytes — so the encoder moved out here and
 * `pdf-image.ts` imports it like anyone else.
 *
 * WHY THE PIXELS ARE STORED RATHER THAN COMPRESSED
 *
 * PNG's IDAT chunk holds exactly a zlib stream, and zlib permits STORED
 * (uncompressed) deflate blocks. Writing those needs no compressor at all, and
 * no decoder can tell the difference — a stored PNG is a valid PNG everywhere.
 *
 * The alternative is `CompressionStream('deflate')`, which is available here
 * and would produce a smaller file. It is also ASYNC, and making the encoder
 * async makes every caller async up to the KML writer, which is synchronous by
 * design. The trade is file size against a colour of function spreading
 * through the writer; `writeKmz` already deflates the whole archive, so a
 * stored PNG inside a deflated KMZ is compressed exactly once anyway, which is
 * where the size actually goes.
 */

/** What `encodePng` accepts. Channels are interleaved, 8 bits each, row-major. */
export type PngColour = 'grey' | 'rgb' | 'rgba';

const CHANNELS: Record<PngColour, number> = { grey: 1, rgb: 3, rgba: 4 };

/** PNG's own numbering: 0 grey, 2 truecolour, 6 truecolour with alpha. */
const COLOUR_TYPE: Record<PngColour, number> = { grey: 0, rgb: 2, rgba: 6 };

/**
 * Encodes interleaved 8-bit samples as a PNG.
 *
 * `samples` must hold exactly `width * height * channels` bytes. A short buffer
 * is a caller bug that would otherwise produce a file whose last rows are
 * whatever happened to be in memory, so it throws rather than padding.
 */
export function encodePng(samples: Uint8Array, width: number, height: number, colour: PngColour): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG dimensions must be positive integers, got ${width}x${height}.`);
  }
  const channels = CHANNELS[colour];
  const needed = width * height * channels;
  if (samples.length < needed) {
    throw new Error(`PNG needs ${needed} bytes for ${width}x${height} ${colour}, got ${samples.length}.`);
  }

  // Each row is prefixed with its filter byte. Filter 0 (none) keeps the
  // encoder trivial; the filters exist to help a compressor we are not using.
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0;
    raw.set(samples.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  return buildPng(raw, width, height, COLOUR_TYPE[colour]);
}

/**
 * Assembles a PNG from ALREADY-FILTERED rows.
 *
 * Exported for the one caller that has filtered rows and no samples:
 * `pdf-image.ts` inflates a PDF's Flate stream, which is unfiltered rows, and
 * inserts the filter bytes itself while it is already walking them.
 */
export function buildPng(filteredRows: Uint8Array, width: number, height: number, colorType: number): Uint8Array {
  const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;

  const chunks = [header, chunk('IHDR', ihdr), chunk('IDAT', zlibStored(filteredRows)), chunk('IEND', new Uint8Array(0))];
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A zlib stream of stored (uncompressed) deflate blocks.
 *
 * No compressor needed, and a decoder cannot tell the difference. The 65,535
 * byte block limit is deflate's, not a choice.
 */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;

  let read = 0;
  let write = 2;
  while (read < data.length || read === 0) {
    const size = Math.min(65535, data.length - read);
    const last = read + size >= data.length ? 1 : 0;
    out[write++] = last;
    out[write++] = size & 0xff;
    out[write++] = (size >> 8) & 0xff;
    out[write++] = ~size & 0xff;
    out[write++] = (~size >> 8) & 0xff;
    out.set(data.subarray(read, read + size), write);
    write += size;
    read += size;
    if (last) break;
  }

  const adler = adler32(data);
  out[write++] = (adler >>> 24) & 0xff;
  out[write++] = (adler >>> 16) & 0xff;
  out[write++] = (adler >>> 8) & 0xff;
  out[write++] = adler & 0xff;
  return out.subarray(0, write);
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
