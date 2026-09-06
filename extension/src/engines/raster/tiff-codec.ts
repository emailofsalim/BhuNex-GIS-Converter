/**
 * TIFF compression codecs and predictors.
 *
 * Kept apart from `geotiff.ts` on purpose: that file knows about IFDs, GeoKeys
 * and georeference, this one knows nothing about TIFF structure and only turns
 * one compressed block into bytes, and bytes into samples. Each codec is then
 * testable against a known vector without constructing a TIFF around it.
 *
 * Only codecs that are genuinely implemented appear here. Anything else is
 * reported by name and refused (rule R1) rather than decoded into noise — a
 * JPEG-compressed tile read as raw bytes would produce a plausible-looking
 * elevation model made of nothing.
 */

import { ConversionError } from '../../core/errors';

export const COMPRESSION = {
  none: 1,
  lzw: 5,
  deflateAdobe: 8,
  packBits: 32773,
  deflate: 32946,
} as const;

/** Compression codes this build can actually decode. */
export const SUPPORTED_COMPRESSIONS: ReadonlySet<number> = new Set([
  COMPRESSION.none,
  COMPRESSION.lzw,
  COMPRESSION.deflateAdobe,
  COMPRESSION.packBits,
  COMPRESSION.deflate,
]);

/**
 * PackBits — Apple's byte-oriented run-length encoding (TIFF §9).
 *
 * A control byte n: 0..127 means copy the next n+1 bytes literally, 129..255
 * means repeat the next byte 257-n times, and 128 is a no-op.
 */
export function packBitsDecode(input: Uint8Array, expectedBytes: number): Uint8Array {
  const out = new Uint8Array(expectedBytes);
  let read = 0;
  let write = 0;

  while (read < input.length && write < expectedBytes) {
    const control = input[read++];
    if (control === 128) continue;
    if (control < 128) {
      const run = control + 1;
      for (let index = 0; index < run && read < input.length && write < expectedBytes; index++) {
        out[write++] = input[read++];
      }
    } else {
      const run = 257 - control;
      if (read >= input.length) break;
      const value = input[read++];
      for (let index = 0; index < run && write < expectedBytes; index++) out[write++] = value;
    }
  }
  return out;
}

const LZW_CLEAR = 256;
const LZW_EOI = 257;
const LZW_FIRST = 258;
const LZW_MAX = 4096;

/**
 * LZW as TIFF uses it: MSB-first bit packing and "early change".
 *
 * Early change is the detail that breaks naive implementations. TIFF widens the
 * code from 9 to 10 bits when the table reaches 511 entries, not 512 — one code
 * earlier than the LZW of GIF. Getting it wrong decodes the first few hundred
 * pixels correctly and then produces garbage, which is exactly the kind of
 * failure that looks like real terrain.
 *
 * The dictionary is held as prefix/suffix chains in typed arrays rather than as
 * byte arrays per entry: a 4096-entry table of growing Uint8Arrays allocates
 * heavily on every strip, and a raster has thousands of strips.
 */
export function lzwDecode(input: Uint8Array, expectedBytes: number): Uint8Array {
  const out = new Uint8Array(expectedBytes);
  const prefix = new Int32Array(LZW_MAX);
  const suffix = new Uint8Array(LZW_MAX);
  const lengths = new Int32Array(LZW_MAX);

  for (let code = 0; code < 256; code++) {
    prefix[code] = -1;
    suffix[code] = code;
    lengths[code] = 1;
  }

  let next = LZW_FIRST;
  let codeWidth = 9;
  let previous = -1;
  let write = 0;

  let bitBuffer = 0;
  let bitCount = 0;
  let read = 0;

  /**
   * Expands a code into the output buffer and returns its first byte.
   *
   * The chain runs from the last byte back to the first, so it is written
   * backwards from the end of the entry. A tail that would overrun the strip is
   * dropped rather than growing the buffer: a short final strip is normal, and
   * silently reallocating would hide a genuinely corrupt code stream.
   */
  const emit = (code: number): number => {
    const start = write;
    if (start >= expectedBytes) return -1;
    let position = start + lengths[code] - 1;
    let walker = code;
    while (walker >= 0) {
      if (position < expectedBytes) out[position] = suffix[walker];
      position--;
      walker = prefix[walker];
    }
    write = Math.min(start + lengths[code], expectedBytes);
    return out[start];
  };

  while (write < expectedBytes) {
    while (bitCount < codeWidth) {
      if (read >= input.length) {
        // Ran out of input before EOI. Everything decoded so far is valid.
        return out;
      }
      bitBuffer = (bitBuffer << 8) | input[read++];
      bitCount += 8;
    }
    const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
    bitCount -= codeWidth;

    if (code === LZW_EOI) break;

    if (code === LZW_CLEAR) {
      next = LZW_FIRST;
      codeWidth = 9;
      previous = -1;
      continue;
    }

    if (previous === -1) {
      if (code >= next && code >= 256) break;
      emit(code);
      previous = code;
      continue;
    }

    let firstByte: number;
    if (code < next && lengths[code] > 0) {
      firstByte = emit(code);
    } else if (code === next) {
      // KwKwK: the code is the one about to be defined, so its expansion is the
      // previous string plus that string's own first byte.
      const start = write;
      emit(previous);
      firstByte = out[start];
      if (write < expectedBytes) out[write++] = firstByte;
    } else {
      // A code beyond the next free entry cannot be resolved: valid LZW never
      // emits one. Accepting it would store a forward reference in the prefix
      // chain, and a later walk of that chain would loop for ever rather than
      // terminate at a root — a corrupt strip must not be able to hang the
      // worker. Everything decoded up to here is still returned.
      break;
    }
    if (firstByte < 0) break;

    if (next < LZW_MAX) {
      prefix[next] = previous;
      suffix[next] = firstByte;
      lengths[next] = lengths[previous] + 1;
      next++;
    }
    previous = code;

    // Early change, and the reason it is easy to get wrong by one.
    //
    // A decoder cannot add a table entry until it has read the code that
    // follows the one the entry describes, so at the moment it reads code k+1
    // its table holds exactly one entry fewer than the encoder's did when that
    // code was written. The encoder widens 9→10 bits after adding entry 510
    // (its next free code becomes 511); to be reading at the same width, the
    // decoder must therefore widen when its own next free code reaches 510.
    //
    // Widening at 511 instead — matching the encoder's threshold rather than
    // compensating for the lag — decodes perfectly for the first ~250 table
    // entries and then silently shifts every subsequent code by one bit.
    if (next + 2 >= 1 << codeWidth && codeWidth < 12) codeWidth++;
  }

  return out;
}

/**
 * Deflate, via the platform rather than a bundled library (rule R15).
 *
 * TIFF's two Deflate codes (8 and 32946) both mean zlib-wrapped data, but real
 * files written by older tools sometimes carry a raw stream, so a failed zlib
 * inflate is retried raw before giving up.
 */
export async function inflate(input: Uint8Array): Promise<Uint8Array> {
  try {
    return await inflateWith(input, 'deflate');
  } catch {
    return await inflateWith(input, 'deflate-raw');
  }
}

async function inflateWith(input: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array> {
  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  void writer.write(input);
  void writer.close();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function deflate(input: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(input);
  void writer.close();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Decompresses one strip or tile. Throws with the codec's name if unsupported. */
export async function decompressBlock(block: Uint8Array, compression: number, expectedBytes: number, codecName: string): Promise<Uint8Array> {
  switch (compression) {
    case COMPRESSION.none:
      return block.length >= expectedBytes ? block.subarray(0, expectedBytes) : padTo(block, expectedBytes);
    case COMPRESSION.packBits:
      return packBitsDecode(block, expectedBytes);
    case COMPRESSION.lzw:
      return lzwDecode(block, expectedBytes);
    case COMPRESSION.deflateAdobe:
    case COMPRESSION.deflate: {
      const inflated = await inflate(block);
      return inflated.length >= expectedBytes ? inflated.subarray(0, expectedBytes) : padTo(inflated, expectedBytes);
    }
    default:
      throw new ConversionError({
        code: 'TIFF_COMPRESSION_UNSUPPORTED',
        what: `This GeoTIFF uses ${codecName} compression, which this build cannot decode.`,
        why: 'Only uncompressed, LZW, Deflate and PackBits data are decoded here. Reading the compressed bytes as if they were pixels would produce a convincing but entirely false raster.',
        action: 'Re-export the file with Deflate or LZW compression (in QGIS: Raster → Conversion → Translate, or gdal_translate -co COMPRESS=DEFLATE), then convert it again.',
      });
  }
}

function padTo(bytes: Uint8Array, size: number): Uint8Array {
  if (bytes.length === size) return bytes;
  const out = new Uint8Array(size);
  out.set(bytes.subarray(0, Math.min(bytes.length, size)));
  return out;
}

/**
 * Undoes horizontal differencing (predictor 2).
 *
 * Each sample was stored as its difference from the sample one pixel to the
 * left in the same band, so the inverse accumulates along each row. The stride
 * is the number of samples per pixel: in an interleaved RGB image the red value
 * predicts the next red value, not the green one beside it.
 */
export function undoHorizontalDifferencing(
  bytes: Uint8Array,
  width: number,
  rows: number,
  samplesPerPixel: number,
  bitsPerSample: number,
  littleEndian: boolean
): void {
  if (bitsPerSample % 8 !== 0) {
    throw new ConversionError({
      code: 'TIFF_PREDICTOR_SUB_BYTE',
      what: 'This GeoTIFF combines horizontal prediction with samples smaller than one byte.',
      why: 'The TIFF specification does not define that combination, so there is no correct way to reverse it.',
      action: 'Re-export the raster without a predictor, or at 8 bits per sample or more.',
    });
  }
  const bytesPerSample = bitsPerSample / 8;
  const rowBytes = width * samplesPerPixel * bytesPerSample;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let row = 0; row < rows; row++) {
    const rowStart = row * rowBytes;
    if (rowStart + rowBytes > bytes.length) break;
    for (let pixel = 1; pixel < width; pixel++) {
      for (let sample = 0; sample < samplesPerPixel; sample++) {
        const at = rowStart + (pixel * samplesPerPixel + sample) * bytesPerSample;
        const previous = at - samplesPerPixel * bytesPerSample;
        switch (bytesPerSample) {
          case 1:
            bytes[at] = (bytes[at] + bytes[previous]) & 0xff;
            break;
          case 2:
            view.setUint16(at, (view.getUint16(at, littleEndian) + view.getUint16(previous, littleEndian)) & 0xffff, littleEndian);
            break;
          case 4:
            view.setUint32(at, (view.getUint32(at, littleEndian) + view.getUint32(previous, littleEndian)) >>> 0, littleEndian);
            break;
          default:
            throw new ConversionError({
              code: 'TIFF_PREDICTOR_WIDTH',
              what: `Horizontal prediction over ${bytesPerSample}-byte samples is not supported.`,
              why: 'Predictor 2 is defined for 8, 16 and 32-bit samples.',
              action: 'Re-export the raster without a predictor.',
            });
        }
      }
    }
  }
}

/**
 * Undoes the floating-point predictor (predictor 3).
 *
 * This one is not horizontal differencing over floats. The encoder splits each
 * row into byte planes — all the high bytes, then all the second bytes, and so
 * on — because the exponent bytes of neighbouring elevations are nearly
 * identical and compress well once grouped. Reversing it is therefore two
 * steps: accumulate the byte deltas, then de-interleave the planes back into
 * whole floats. Skipping the second step yields a raster full of NaN and
 * absurd values, which is why this is implemented rather than approximated.
 */
export function undoFloatingPointPredictor(
  bytes: Uint8Array,
  width: number,
  rows: number,
  samplesPerPixel: number,
  bitsPerSample: number,
  littleEndian: boolean
): void {
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 2) {
    throw new ConversionError({
      code: 'TIFF_FLOAT_PREDICTOR_WIDTH',
      what: `The floating-point predictor was used with ${bitsPerSample}-bit samples.`,
      why: 'Predictor 3 is defined only for floating-point samples of 16, 32 or 64 bits.',
      action: 'Re-export the raster without a predictor.',
    });
  }
  const stride = samplesPerPixel;
  const rowBytes = width * samplesPerPixel * bytesPerSample;
  const samplesInRow = width * samplesPerPixel;
  const scratch = new Uint8Array(rowBytes);

  for (let row = 0; row < rows; row++) {
    const rowStart = row * rowBytes;
    if (rowStart + rowBytes > bytes.length) break;

    // 1. Accumulate byte-wise deltas along the row.
    for (let at = stride; at < rowBytes; at++) {
      bytes[rowStart + at] = (bytes[rowStart + at] + bytes[rowStart + at - stride]) & 0xff;
    }

    // 2. De-interleave the byte planes back into whole samples.
    scratch.set(bytes.subarray(rowStart, rowStart + rowBytes));
    for (let sample = 0; sample < samplesInRow; sample++) {
      for (let byte = 0; byte < bytesPerSample; byte++) {
        // Planes are stored most-significant first; a little-endian sample
        // therefore reads them in reverse.
        const plane = littleEndian ? bytesPerSample - byte - 1 : byte;
        bytes[rowStart + sample * bytesPerSample + byte] = scratch[plane * samplesInRow + sample];
      }
    }
  }
}

export type SampleFormat = 'uint' | 'int' | 'float';

export function sampleFormatOf(code: number): SampleFormat {
  if (code === 2) return 'int';
  if (code === 3) return 'float';
  return 'uint';
}

/** IEEE 754 half precision, which some LiDAR-derived rasters use for intensity. */
export function float16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity;
  return sign * (fraction + 1024) * 2 ** (exponent - 25);
}

export interface SampleReader {
  (view: DataView, byteOffset: number, index: number): number;
}

/**
 * Builds a reader for one sample width and format.
 *
 * Returning a closure rather than switching inside the pixel loop matters here:
 * this runs once per sample of a raster that can be 100 million pixels.
 */
export function sampleReaderFor(format: SampleFormat, bitsPerSample: number, littleEndian: boolean): SampleReader {
  if (format === 'float') {
    if (bitsPerSample === 16) return (view, at, index) => float16(view.getUint16(at + index * 2, littleEndian));
    if (bitsPerSample === 32) return (view, at, index) => view.getFloat32(at + index * 4, littleEndian);
    if (bitsPerSample === 64) return (view, at, index) => view.getFloat64(at + index * 8, littleEndian);
  } else if (format === 'int') {
    if (bitsPerSample === 8) return (view, at, index) => view.getInt8(at + index);
    if (bitsPerSample === 16) return (view, at, index) => view.getInt16(at + index * 2, littleEndian);
    if (bitsPerSample === 32) return (view, at, index) => view.getInt32(at + index * 4, littleEndian);
    if (bitsPerSample === 64) return (view, at, index) => Number(view.getBigInt64(at + index * 8, littleEndian));
  } else {
    if (bitsPerSample === 8) return (view, at, index) => view.getUint8(at + index);
    if (bitsPerSample === 16) return (view, at, index) => view.getUint16(at + index * 2, littleEndian);
    if (bitsPerSample === 32) return (view, at, index) => view.getUint32(at + index * 4, littleEndian);
    if (bitsPerSample === 64) return (view, at, index) => Number(view.getBigUint64(at + index * 8, littleEndian));
  }

  // Sub-byte samples (1, 2 and 4 bits) are packed most-significant bit first.
  if (format === 'uint' && (bitsPerSample === 1 || bitsPerSample === 2 || bitsPerSample === 4)) {
    const perByte = 8 / bitsPerSample;
    const mask = (1 << bitsPerSample) - 1;
    return (view, at, index) => {
      const byte = view.getUint8(at + Math.floor(index / perByte));
      const shift = 8 - bitsPerSample * ((index % perByte) + 1);
      return (byte >> shift) & mask;
    };
  }

  throw new ConversionError({
    code: 'TIFF_SAMPLE_WIDTH_UNSUPPORTED',
    what: `A ${bitsPerSample}-bit ${format} sample was found, which this build cannot read.`,
    why: 'Supported widths are 1, 2, 4, 8, 16, 32 and 64-bit integers and 16, 32 and 64-bit floats.',
    action: 'Re-export the raster as 16 or 32-bit, or as 32-bit float for elevation.',
  });
}
