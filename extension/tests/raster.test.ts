/**
 * Raster codec tests (instruction §16.1, Phase 4).
 *
 * These exercise the TIFF codecs directly rather than through a conversion, so
 * a failure names the codec rather than the format. Two things matter here:
 *
 *  - The fixtures are built by a TIFF assembler local to this file, not by the
 *    project's own writer. A decoder tested only against its matching encoder
 *    proves the pair agree with each other, not that either agrees with the
 *    specification — and a GeoTIFF that only this tool can read would be
 *    useless to a surveyor.
 *  - Where a value can be computed by hand from the spec, it is, and the
 *    working is in the comment. That is what makes these regression tests for
 *    the specification rather than for the current implementation.
 */

import { describe, expect, it } from 'vitest';
import {
  float16,
  lzwDecode,
  packBitsDecode,
  sampleReaderFor,
  undoFloatingPointPredictor,
  undoHorizontalDifferencing,
} from '@engines/raster/tiff-codec';
import { bandStatistics, decodeGeoTiffPixels, readGeoTiff, readGeoTiffInfo } from '@engines/raster/geotiff';
import { chooseSampleLayout, writeGeoTiff } from '@engines/raster/geotiff-write';
import { createDataset, type CirDataset, type SourceInfo } from '@core/cir';
import { crsFromEpsg } from '@crs/epsg';

// ---------------------------------------------------------------------------
// A minimal TIFF assembler, independent of the project's writer.
// ---------------------------------------------------------------------------

interface TiffTag {
  tag: number;
  type: number;
  values: number[];
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };

/**
 * Builds a single-IFD TIFF around already-encoded blocks.
 *
 * Deliberately dumb: it takes the block bytes as given, so a test can hand it
 * PackBits or LZW data the reader must decode, or a deliberately truncated
 * strip.
 */
function buildTiff(options: {
  width: number;
  height: number;
  bitsPerSample: number;
  samplesPerPixel: number;
  sampleFormat: number;
  compression: number;
  blocks: Uint8Array[];
  rowsPerStrip?: number;
  tileWidth?: number;
  tileLength?: number;
  predictor?: number;
  planarConfiguration?: number;
  littleEndian?: boolean;
  extraTags?: TiffTag[];
}): Uint8Array {
  const littleEndian = options.littleEndian ?? true;
  const tiled = options.tileWidth !== undefined;

  const tags: TiffTag[] = [
    { tag: 256, type: 4, values: [options.width] },
    { tag: 257, type: 4, values: [options.height] },
    { tag: 258, type: 3, values: new Array(options.samplesPerPixel).fill(options.bitsPerSample) },
    { tag: 259, type: 3, values: [options.compression] },
    { tag: 262, type: 3, values: [1] },
    { tag: 277, type: 3, values: [options.samplesPerPixel] },
    { tag: 284, type: 3, values: [options.planarConfiguration ?? 1] },
    { tag: 339, type: 3, values: new Array(options.samplesPerPixel).fill(options.sampleFormat) },
  ];
  if (options.predictor) tags.push({ tag: 317, type: 3, values: [options.predictor] });
  if (tiled) {
    tags.push({ tag: 322, type: 4, values: [options.tileWidth!] });
    tags.push({ tag: 323, type: 4, values: [options.tileLength!] });
    tags.push({ tag: 324, type: 4, values: new Array(options.blocks.length).fill(0) });
    tags.push({ tag: 325, type: 4, values: options.blocks.map((block) => block.length) });
  } else {
    tags.push({ tag: 273, type: 4, values: new Array(options.blocks.length).fill(0) });
    tags.push({ tag: 278, type: 4, values: [options.rowsPerStrip ?? options.height] });
    tags.push({ tag: 279, type: 4, values: options.blocks.map((block) => block.length) });
  }
  for (const extra of options.extraTags ?? []) tags.push(extra);
  tags.sort((left, right) => left.tag - right.tag);

  const ifdSize = 2 + tags.length * 12 + 4;
  let externalSize = 0;
  const externalAt = new Map<number, number>();
  for (const entry of tags) {
    const bytes = entry.values.length * (TYPE_SIZE[entry.type] ?? 1);
    if (bytes > 4) {
      externalAt.set(entry.tag, 8 + ifdSize + externalSize);
      externalSize += bytes + (bytes % 2);
    }
  }

  const blockStart = 8 + ifdSize + externalSize;
  const total = blockStart + options.blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out[0] = littleEndian ? 0x49 : 0x4d;
  out[1] = littleEndian ? 0x49 : 0x4d;
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, 8, littleEndian);

  const offsets: number[] = [];
  let at = blockStart;
  for (const block of options.blocks) {
    offsets.push(at);
    out.set(block, at);
    at += block.length;
  }
  const offsetTag = tags.find((entry) => entry.tag === (tiled ? 324 : 273))!;
  offsetTag.values = offsets;

  view.setUint16(8, tags.length, littleEndian);
  tags.forEach((entry, index) => {
    const entryAt = 10 + index * 12;
    view.setUint16(entryAt, entry.tag, littleEndian);
    view.setUint16(entryAt + 2, entry.type, littleEndian);
    view.setUint32(entryAt + 4, entry.values.length, littleEndian);
    const bytes = entry.values.length * (TYPE_SIZE[entry.type] ?? 1);
    const target = bytes > 4 ? externalAt.get(entry.tag)! : entryAt + 8;
    if (bytes > 4) view.setUint32(entryAt + 8, target, littleEndian);
    entry.values.forEach((value, position) => {
      if (entry.type === 3) view.setUint16(target + position * 2, value, littleEndian);
      else if (entry.type === 4) view.setUint32(target + position * 4, value, littleEndian);
      else if (entry.type === 12) view.setFloat64(target + position * 8, value, littleEndian);
      else out[target + position] = value & 0xff;
    });
  });
  view.setUint32(10 + tags.length * 12, 0, littleEndian);
  return out;
}

/** Packs numbers into bytes at a given width, little-endian, for fixtures. */
function packSamples(values: number[], bits: number, format: 'uint' | 'int' | 'float'): Uint8Array {
  const bytes = new Uint8Array((values.length * bits) / 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    if (format === 'float' && bits === 32) view.setFloat32(index * 4, value, true);
    else if (format === 'float' && bits === 64) view.setFloat64(index * 8, value, true);
    else if (format === 'int' && bits === 16) view.setInt16(index * 2, value, true);
    else if (bits === 16) view.setUint16(index * 2, value, true);
    else if (bits === 32) view.setUint32(index * 4, value, true);
    else bytes[index] = value;
  });
  return bytes;
}

/**
 * A TIFF LZW encoder written from the TIFF 6.0 pseudocode, used only to make
 * fixtures. `earlyChange: false` produces the GIF-style variant, which exists
 * here so a test can prove the decoder is not accidentally implementing it.
 */
function encodeLzw(data: Uint8Array, { earlyChange = true }: { earlyChange?: boolean } = {}): Uint8Array {
  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let width = 9;

  const put = (code: number) => {
    bitBuffer = (bitBuffer << width) | code;
    bitCount += width;
    while (bitCount >= 8) {
      out.push((bitBuffer >> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  };

  let table = new Map<string, number>();
  let next = 258;
  const reset = () => {
    table = new Map();
    next = 258;
    width = 9;
  };

  /** A one-byte sequence is its own code; longer ones come from the table. */
  const codeFor = (sequence: string): number | undefined =>
    sequence.includes(',') ? table.get(sequence) : Number(sequence);

  reset();
  put(256);

  let omega = '';
  for (const byte of data) {
    const candidate = omega === '' ? String(byte) : `${omega},${byte}`;
    if (codeFor(candidate) !== undefined) {
      omega = candidate;
      continue;
    }
    put(codeFor(omega)!);
    table.set(candidate, next++);
    omega = String(byte);
    // Early change: widen when the next free code reaches 2^width - 1, one
    // entry before the table would need the extra bit. `earlyChange: false` is
    // the GIF rule and exists only so a test can prove the two differ.
    if ((earlyChange ? next + 1 : next) >= 1 << width && width < 12) width++;
    if (next >= 4093) {
      put(256);
      reset();
    }
  }
  if (omega !== '') put(codeFor(omega)!);
  put(257);
  if (bitCount > 0) out.push((bitBuffer << (8 - bitCount)) & 0xff);
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------

describe('TIFF compression codecs', () => {
  it('decodes PackBits literals, runs and the no-op control byte', () => {
    // The TIFF 6.0 specification's worked example, decoded control byte by
    // control byte (a negative n means repeat the next byte 1 - n times):
    //   FE = -2 → AA ×3          02 → literal 80 00 2A
    //   FD = -3 → AA ×4          03 → literal 80 00 2A 22
    //   F7 = -9 → AA ×10
    // which is 3 + 3 + 4 + 4 + 10 = 24 bytes.
    const encoded = new Uint8Array([0xfe, 0xaa, 0x02, 0x80, 0x00, 0x2a, 0xfd, 0xaa, 0x03, 0x80, 0x00, 0x2a, 0x22, 0xf7, 0xaa]);
    const expected = new Uint8Array([
      0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0x22, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
      0xaa, 0xaa, 0xaa, 0xaa,
    ]);
    expect(packBitsDecode(encoded, expected.length)).toEqual(expected);
  });

  it('stops a PackBits run at the strip boundary rather than overrunning it', () => {
    // A run of 128 bytes decoded into a 4-byte strip: a decoder that trusted
    // the control byte would write past the band and corrupt the next row.
    const encoded = new Uint8Array([0x81, 0x07]);
    expect(packBitsDecode(encoded, 4)).toEqual(new Uint8Array([7, 7, 7, 7]));
  });

  it('decodes a hand-computed LZW stream', () => {
    // Four 0x00 bytes encode as the codes 256 (clear), 0, 258, 0, 257 (EOI) at
    // nine bits each, MSB first:
    //   100000000 000000000 100000010 000000000 100000001
    // which packs to 80 00 20 40 08 08.
    const encoded = new Uint8Array([0x80, 0x00, 0x20, 0x40, 0x08, 0x08]);
    expect(lzwDecode(encoded, 4)).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it('handles the KwKwK case, where a code refers to the entry it is defining', () => {
    // Byte 5 repeated: the third code emitted is the one being added, the
    // classic LZW edge case that produces a one-byte-short output when missed.
    const data = new Uint8Array([5, 5, 5, 5, 5, 5, 5, 5]);
    expect(lzwDecode(encodeLzw(data), data.length)).toEqual(data);
  });

  it('widens the code one entry early, as TIFF requires and GIF does not', () => {
    // Enough distinct byte pairs to push the table past 510 entries, so the
    // 9-to-10-bit transition is actually crossed.
    const data = new Uint8Array(4096);
    for (let index = 0; index < data.length; index++) data[index] = (index * 7 + (index >> 5)) & 0xff;

    expect(lzwDecode(encodeLzw(data, { earlyChange: true }), data.length)).toEqual(data);
    // The same bytes encoded with the GIF rule must NOT decode correctly. If
    // this ever passes, the decoder has quietly adopted the wrong variant and
    // every large LZW GeoTIFF is being misread after the first few hundred
    // pixels — the failure mode that looks like plausible terrain.
    expect(lzwDecode(encodeLzw(data, { earlyChange: false }), data.length)).not.toEqual(data);
  });

  it('stops on a corrupt code instead of looping for ever', () => {
    // A code beyond the next free table entry cannot be resolved. Storing it
    // anyway puts a forward reference in the prefix chain, and walking that
    // chain never reaches a root — the decoder spins and the conversion worker
    // never returns. A truncated file is an inconvenience; a hung worker with
    // no error is worse, so this asserts the decode terminates.
    //
    // Codes: 256 (clear), 65 (a literal), 4000 (far beyond the table).
    const bits = [256, 65, 4000].map((code) => code.toString(2).padStart(9, '0')).join('');
    const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
    const bytes = new Uint8Array(padded.length / 8);
    for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(padded.slice(index * 8, index * 8 + 8), 2);

    const started = Date.now();
    const decoded = lzwDecode(bytes, 64);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(decoded[0]).toBe(65);
  });

  it('returns what it decoded when an LZW stream is truncated', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const encoded = encodeLzw(data);
    // Three bytes carry the clear code (bits 0-8) and the first data code
    // (bits 9-17), so exactly one byte is recoverable.
    const decoded = lzwDecode(encoded.subarray(0, 3), data.length);
    // A short read is not an exception: the strip is simply incomplete, and the
    // rest of the raster is still worth reading.
    expect(decoded.length).toBe(data.length);
    expect(decoded[0]).toBe(1);
  });
});

describe('TIFF predictors', () => {
  it('reverses horizontal differencing per band, not per byte', () => {
    // Two pixels, three bands. Stored as differences from the same band one
    // pixel left: red predicts red, not the green beside it.
    const bytes = new Uint8Array([10, 20, 30, 5, -5 & 0xff, 1]);
    undoHorizontalDifferencing(bytes, 2, 1, 3, 8, true);
    expect([...bytes]).toEqual([10, 20, 30, 15, 15, 31]);
  });

  it('reverses horizontal differencing on 16-bit samples with wraparound', () => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 65000, true);
    view.setUint16(2, 1000, true); // wraps past 65535
    view.setUint16(4, 100, true);
    view.setUint16(6, 50, true);
    undoHorizontalDifferencing(bytes, 4, 1, 1, 16, true);
    expect(view.getUint16(2, true)).toBe((65000 + 1000) & 0xffff);
  });

  it('reverses the floating-point predictor, including the byte de-interleave', () => {
    // Round trip through the encoder's two steps: split each float into byte
    // planes, then difference the bytes. Reversing only the differencing (the
    // common shortcut) leaves the planes scrambled and the values absurd.
    const values = [412.25, 413.5, 414.75, 410.0];
    const raw = packSamples(values, 32, 'float');
    const planes = new Uint8Array(raw.length);
    for (let sample = 0; sample < values.length; sample++) {
      for (let byte = 0; byte < 4; byte++) {
        planes[(3 - byte) * values.length + sample] = raw[sample * 4 + byte];
      }
    }
    const differenced = new Uint8Array(planes);
    for (let at = differenced.length - 1; at >= 1; at--) differenced[at] = (differenced[at] - differenced[at - 1]) & 0xff;

    undoFloatingPointPredictor(differenced, values.length, 1, 1, 32, true);
    const view = new DataView(differenced.buffer);
    values.forEach((value, index) => expect(view.getFloat32(index * 4, true)).toBeCloseTo(value, 4));
  });

  it('refuses horizontal prediction on sub-byte samples instead of guessing', () => {
    expect(() => undoHorizontalDifferencing(new Uint8Array(4), 8, 1, 1, 4, true)).toThrow(/TIFF_PREDICTOR_SUB_BYTE|does not define/);
  });
});

describe('sample readers', () => {
  it('reads packed 1-bit and 4-bit samples most-significant bit first', () => {
    const bytes = new Uint8Array([0b10110001, 0x00]);
    const view = new DataView(bytes.buffer);
    const oneBit = sampleReaderFor('uint', 1, true);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((index) => oneBit(view, 0, index))).toEqual([1, 0, 1, 1, 0, 0, 0, 1]);

    const fourBit = sampleReaderFor('uint', 4, true);
    expect([fourBit(view, 0, 0), fourBit(view, 0, 1)]).toEqual([0b1011, 0b0001]);
  });

  it('reads half-precision floats', () => {
    // 0x3C00 is 1.0, 0xC000 is -2.0, 0x0000 is zero.
    expect(float16(0x3c00)).toBe(1);
    expect(float16(0xc000)).toBe(-2);
    expect(float16(0x0000)).toBe(0);
  });

  it('names the width it cannot read rather than returning zeros', () => {
    expect(() => sampleReaderFor('int', 4, true)).toThrow(/cannot read/);
  });
});

describe('GeoTIFF pixel decoding', () => {
  const source: SourceInfo = { fileName: 'dem.tif', size: 0, formatId: 'geotiff', formatName: 'GeoTIFF', detectionConfidence: 1 };

  it('decodes an uncompressed single-band elevation raster', async () => {
    const values = [410.25, 411.5, 412.75, 413.0, 414.25, 415.5];
    const tiff = buildTiff({
      width: 3,
      height: 2,
      bitsPerSample: 32,
      samplesPerPixel: 1,
      sampleFormat: 3,
      compression: 1,
      blocks: [packSamples(values, 32, 'float')],
    });
    const info = readGeoTiffInfo(tiff);
    const bands = await decodeGeoTiffPixels(tiff, info);
    expect(bands).toHaveLength(1);
    values.forEach((value, index) => expect(bands[0][index]).toBeCloseTo(value, 4));
  });

  it('decodes multiple strips and stitches them in row order', async () => {
    const rows = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    const tiff = buildTiff({
      width: 3,
      height: 3,
      bitsPerSample: 16,
      samplesPerPixel: 1,
      sampleFormat: 1,
      compression: 1,
      rowsPerStrip: 1,
      blocks: rows.map((row) => packSamples(row, 16, 'uint')),
    });
    const bands = await decodeGeoTiffPixels(tiff, readGeoTiffInfo(tiff));
    expect([...bands[0]]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('drops tile padding rather than writing it into the image', async () => {
    // A 3×3 image in 2×2 tiles: every tile is full-size, so the right column
    // and bottom row of the tile grid are padding that must not appear.
    const tile = (values: number[]) => packSamples(values, 8, 'uint');
    const tiff = buildTiff({
      width: 3,
      height: 3,
      bitsPerSample: 8,
      samplesPerPixel: 1,
      sampleFormat: 1,
      compression: 1,
      tileWidth: 2,
      tileLength: 2,
      blocks: [
        tile([1, 2, 4, 5]), // top-left
        tile([3, 99, 6, 99]), // top-right, padded column
        tile([7, 8, 99, 99]), // bottom-left, padded row
        tile([9, 99, 99, 99]), // bottom-right corner
      ],
    });
    const bands = await decodeGeoTiffPixels(tiff, readGeoTiffInfo(tiff));
    expect([...bands[0]]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('separates bands under planar configuration 2', async () => {
    const tiff = buildTiff({
      width: 2,
      height: 1,
      bitsPerSample: 8,
      samplesPerPixel: 3,
      sampleFormat: 1,
      compression: 1,
      planarConfiguration: 2,
      blocks: [packSamples([10, 11], 8, 'uint'), packSamples([20, 21], 8, 'uint'), packSamples([30, 31], 8, 'uint')],
    });
    const bands = await decodeGeoTiffPixels(tiff, readGeoTiffInfo(tiff));
    expect([...bands[0]]).toEqual([10, 11]);
    expect([...bands[1]]).toEqual([20, 21]);
    expect([...bands[2]]).toEqual([30, 31]);
  });

  it('interleaves bands under planar configuration 1', async () => {
    const tiff = buildTiff({
      width: 2,
      height: 1,
      bitsPerSample: 8,
      samplesPerPixel: 3,
      sampleFormat: 1,
      compression: 1,
      blocks: [packSamples([10, 20, 30, 11, 21, 31], 8, 'uint')],
    });
    const bands = await decodeGeoTiffPixels(tiff, readGeoTiffInfo(tiff));
    expect([...bands[0]]).toEqual([10, 11]);
    expect([...bands[1]]).toEqual([20, 21]);
    expect([...bands[2]]).toEqual([30, 31]);
  });

  it('decodes LZW with horizontal prediction, as GDAL writes it', async () => {
    const values = [100, 101, 103, 106, 110, 115];
    const raw = packSamples(values, 8, 'uint');
    const differenced = new Uint8Array(raw);
    for (let at = differenced.length - 1; at >= 1; at--) differenced[at] = (differenced[at] - differenced[at - 1]) & 0xff;

    const tiff = buildTiff({
      width: 6,
      height: 1,
      bitsPerSample: 8,
      samplesPerPixel: 1,
      sampleFormat: 1,
      compression: 5,
      predictor: 2,
      blocks: [encodeLzw(differenced)],
    });
    const bands = await decodeGeoTiffPixels(tiff, readGeoTiffInfo(tiff));
    expect([...bands[0]]).toEqual(values);
  });

  it('decodes PackBits strips', async () => {
    const tiff = buildTiff({
      width: 4,
      height: 1,
      bitsPerSample: 8,
      samplesPerPixel: 1,
      sampleFormat: 1,
      compression: 32773,
      blocks: [new Uint8Array([0xfd, 0x2a])], // repeat 0x2A four times
    });
    const bands = await decodeGeoTiffPixels(tiff, readGeoTiffInfo(tiff));
    expect([...bands[0]]).toEqual([42, 42, 42, 42]);
  });

  it('reads big-endian files', async () => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint16(0, 4096, false);
    new DataView(bytes.buffer).setUint16(2, 8192, false);
    const tiff = buildTiff({
      width: 2,
      height: 1,
      bitsPerSample: 16,
      samplesPerPixel: 1,
      sampleFormat: 1,
      compression: 1,
      littleEndian: false,
      blocks: [bytes],
    });
    const bands = await decodeGeoTiffPixels(tiff, readGeoTiffInfo(tiff));
    expect([...bands[0]]).toEqual([4096, 8192]);
  });

  it('refuses a JPEG-compressed file by name instead of reading noise', async () => {
    const tiff = buildTiff({
      width: 2,
      height: 1,
      bitsPerSample: 8,
      samplesPerPixel: 1,
      sampleFormat: 1,
      compression: 7,
      blocks: [new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
    });
    await expect(decodeGeoTiffPixels(tiff, readGeoTiffInfo(tiff))).rejects.toMatchObject({ code: 'TIFF_COMPRESSION_UNSUPPORTED' });

    // The georeference still reads, and the refusal is a named warning rather
    // than a failed conversion — losing the extent as well would be worse.
    const dataset = await readGeoTiff(tiff, source);
    expect(dataset.raster?.hasPixelData).toBe(false);
    const warning = dataset.warnings.find((entry) => entry.code === 'GEOTIFF_PIXELS_NOT_DECODED');
    expect(warning?.message).toMatch(/JPEG/);
    expect(dataset.raster?.width).toBe(2);
  });

  it('reports nodata out of the statistics rather than averaging it in', () => {
    const stats = bandStatistics([new Float64Array([10, 20, -9999, 30])], -9999);
    expect(stats[0].min).toBe(10);
    expect(stats[0].max).toBe(30);
    expect(stats[0].mean).toBeCloseTo(20, 6);
  });

  it('refuses a raster beyond the memory ceiling with a size, not a crash', async () => {
    const tiff = buildTiff({
      width: 60000,
      height: 60000,
      bitsPerSample: 8,
      samplesPerPixel: 1,
      sampleFormat: 1,
      compression: 1,
      blocks: [new Uint8Array(16)],
    });
    await expect(decodeGeoTiffPixels(tiff, readGeoTiffInfo(tiff))).rejects.toMatchObject({ code: 'TIFF_TOO_LARGE' });
  });
});

describe('GeoTIFF writing', () => {
  function demDataset(values: number[], width: number, height: number, noData: number | null = -9999): CirDataset {
    return createDataset({
      kind: 'raster',
      name: 'dem',
      source: { fileName: 'dem.asc', size: 0, formatId: 'asciigrid', formatName: 'ESRI ASCII Grid', detectionConfidence: 1 },
      crs: crsFromEpsg(32645),
      crsOrigin: 'declared',
      units: 'm',
      axisOrder: 'xy',
      layers: [],
      raster: {
        width,
        height,
        bandCount: 1,
        pixelType: 'float64',
        noData,
        geotransform: [412000, 10, 0, 2591300, 0, -10],
        extent: { minX: 412000, minY: 2591300 - height * 10, maxX: 412000 + width * 10, maxY: 2591300 },
        bands: [Float64Array.from(values)],
        hasPixelData: true,
        isElevation: true,
      },
      warnings: [],
    });
  }

  it('picks the narrowest lossless sample type from the data', () => {
    expect(chooseSampleLayout([Float64Array.from([0, 128, 255])], null).name).toBe('uint8');
    expect(chooseSampleLayout([Float64Array.from([0, 5000])], null).name).toBe('uint16');
    expect(chooseSampleLayout([Float64Array.from([-500, 5000])], null).name).toBe('int16');
    // Fractional elevations must not be demoted to an integer type: rounding a
    // DEM to the metre is exactly the silent loss rule R3 forbids.
    expect(chooseSampleLayout([Float64Array.from([410.25, 411.5])], null).name).toBe('float32');
  });

  it('lets nodata widen the chosen type', () => {
    // Values fit in uint8, but -9999 does not; picking uint8 would clamp every
    // nodata cell to zero and turn holes into sea level.
    expect(chooseSampleLayout([Float64Array.from([1, 2, 3])], -9999).name).toBe('int16');
  });

  it('round-trips an elevation raster through its own reader', async () => {
    const values = [410.25, 411.5, 412.75, 413.0, 414.25, -9999];
    const { bytes, warnings } = await writeGeoTiff(demDataset(values, 3, 2));
    expect(warnings.filter((entry) => entry.severity === 'error')).toHaveLength(0);

    const info = readGeoTiffInfo(bytes);
    expect(info.width).toBe(3);
    expect(info.height).toBe(2);
    expect(info.epsg).toBe(32645);
    expect(info.noData).toBe(-9999);
    expect(info.compressionName).toBe('Deflate (Adobe)');

    const dataset = await readGeoTiff(bytes, { fileName: 'out.tif', size: bytes.length, formatId: 'geotiff', formatName: 'GeoTIFF', detectionConfidence: 1 });
    expect(dataset.raster?.hasPixelData).toBe(true);
    values.forEach((value, index) => expect(dataset.raster!.bands![0][index]).toBeCloseTo(value, 3));
    // Georeference survives: origin, pixel size and north-down row order.
    expect(dataset.raster?.geotransform?.[0]).toBeCloseTo(412000, 6);
    expect(dataset.raster?.geotransform?.[1]).toBeCloseTo(10, 6);
    expect(dataset.raster?.geotransform?.[5]).toBeCloseTo(-10, 6);
  });

  it('round-trips uncompressed as well as Deflate', async () => {
    const values = [1, 2, 3, 4];
    const { bytes } = await writeGeoTiff(demDataset(values, 2, 2, null), {
      compression: 'none',
      sampleWidth: 'auto',
      rowsPerStrip: 1,
    });
    const dataset = await readGeoTiff(bytes, { fileName: 'out.tif', size: bytes.length, formatId: 'geotiff', formatName: 'GeoTIFF', detectionConfidence: 1 });
    expect([...dataset.raster!.bands![0]]).toEqual(values);
  });

  it('counts the pixels an over-narrow sample type would damage', async () => {
    // In uint8: 10.5 and 20.25 are in range but fractional (rounded), 30 is
    // exact, 70000 is far outside (clamped). Both counts must be reported —
    // "some values changed" would be useless to someone checking a DEM.
    const { warnings } = await writeGeoTiff(demDataset([10.5, 20.25, 30, 70000], 2, 2, null), {
      compression: 'none',
      sampleWidth: 'uint8',
      rowsPerStrip: 8,
    });
    const clamped = warnings.find((entry) => entry.code === 'TIFF_VALUES_CLAMPED');
    expect(clamped?.severity).toBe('error');
    expect(clamped?.count).toBe(1);
    expect(warnings.find((entry) => entry.code === 'TIFF_VALUES_ROUNDED')?.count).toBe(2);
  });

  it('refuses to write a raster whose pixels were never decoded', async () => {
    const dataset = demDataset([1, 2, 3, 4], 2, 2);
    dataset.raster!.hasPixelData = false;
    dataset.raster!.bands = undefined;
    await expect(writeGeoTiff(dataset)).rejects.toMatchObject({ code: 'TIFF_NO_PIXEL_DATA' });
  });

  it('refuses to write an ungeoreferenced raster rather than placing it at zero', async () => {
    const dataset = demDataset([1, 2, 3, 4], 2, 2);
    dataset.raster!.geotransform = null;
    await expect(writeGeoTiff(dataset)).rejects.toMatchObject({ code: 'TIFF_NO_GEOREFERENCE' });
  });

  it('reports rotation terms it cannot express instead of dropping them silently', async () => {
    const dataset = demDataset([1, 2, 3, 4], 2, 2);
    dataset.raster!.geotransform = [412000, 10, 0.5, 2591300, 0.25, -10];
    const { warnings } = await writeGeoTiff(dataset);
    expect(warnings.some((entry) => entry.code === 'TIFF_ROTATION_DROPPED')).toBe(true);
  });
});
