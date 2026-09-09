/**
 * ZIP engine.
 *
 * Reading uses the central directory (authoritative) and falls back to a local
 * header walk when the directory is missing or damaged, which happens with
 * archives produced by field controllers. DEFLATE runs on the platform's
 * DecompressionStream/CompressionStream, so no compression library ships with
 * the extension.
 *
 * Every guard in instruction §9.3 is enforced here rather than at the call
 * sites: an archive is untrusted input, and a zip bomb or a `../` entry must
 * fail in one place, not in five.
 */

import { ConversionError } from '../../core/errors';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  /** Compressed size as stored, for the archive inspector. */
  compressedSize: number;
  uncompressedSize: number;
  method: number;
}

export interface ZipLimits {
  /** Total decompressed bytes across all entries. */
  maxTotalBytes: number;
  /** Per-entry compression ratio ceiling — the zip-bomb guard. */
  maxRatio: number;
  maxEntries: number;
  /** Nesting depth for archives found inside archives. */
  maxDepth: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxTotalBytes: 1024 * 1024 * 1024,
  maxRatio: 200,
  maxEntries: 20000,
  maxDepth: 4,
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function u64(bytes: Uint8Array, at: number): number {
  // ZIP64 sizes above 2^53 cannot be represented exactly, but they also cannot
  // be held in a browser buffer, so the low 53 bits are the honest limit here.
  const low = u32(bytes, at);
  const high = u32(bytes, at + 4);
  return high * 0x100000000 + low;
}

/**
 * Rejects entry names that would escape the extraction root. Sanitising instead
 * of rejecting is the mistake that makes traversal bugs exploitable: a name that
 * tries to escape is evidence about the archive, not a formatting problem.
 */
function assertSafeName(name: string): void {
  const normalised = name.replace(/\\/g, '/');
  if (normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised) || normalised.split('/').includes('..')) {
    throw new ConversionError({
      code: 'ZIP_UNSAFE_PATH',
      what: `The archive contains an entry with an unsafe path: "${name}".`,
      why: 'The entry is absolute or uses "..", which would write outside the extraction folder.',
      action: 'Repack the archive with relative paths, or extract it with your own tool and add the files directly.',
    });
  }
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  // Corrupt DEFLATE data rejects on both sides of the stream. The read side is
  // awaited and reported; the write-side rejection is the same fault, so it is
  // absorbed here rather than surfacing the single failure twice.
  const pumped = (async () => {
    await writer.write(bytes);
    await writer.close();
  })().catch(() => undefined);

  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    await pumped;
  }
  return concat(chunks);
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const pumped = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await pumped;
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Locates the end-of-central-directory record, tolerating a trailing comment. */
function findEocd(bytes: Uint8Array): number {
  const floor = Math.max(0, bytes.length - 65557);
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (u32(bytes, at) === SIG_EOCD) return at;
  }
  return -1;
}

export async function readZip(source: Uint8Array | ArrayBuffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipEntry[]> {
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  if (bytes.length < 22 || !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new ConversionError({
      code: 'ZIP_NOT_AN_ARCHIVE',
      what: 'The file was opened as a ZIP archive but has no ZIP signature.',
      why: 'The first two bytes are not "PK", so this is not a ZIP, KMZ, XLSX or shapefile package.',
      action: 'Check that the file downloaded completely, then confirm the detected format in the inspector.',
    });
  }

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let totalBytes = 0;

  const readOne = async (name: string, method: number, compressed: Uint8Array, declaredSize: number): Promise<void> => {
    assertSafeName(name);
    // Directory markers carry no payload.
    if (name.endsWith('/')) return;
    if (entries.length >= limits.maxEntries) {
      throw new ConversionError({
        code: 'ZIP_TOO_MANY_ENTRIES',
        what: `The archive holds more than ${limits.maxEntries.toLocaleString()} entries.`,
        why: 'Expanding all of them would exhaust memory before any conversion could start.',
        action: 'Split the archive, or extract the datasets you need and add them directly.',
      });
    }
    let data: Uint8Array;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      // Ratio guard runs on the declared size before inflating, so a bomb is
      // refused rather than expanded.
      if (declaredSize > 0 && compressed.length > 0 && declaredSize / compressed.length > limits.maxRatio) {
        throw new ConversionError({
          code: 'ZIP_RATIO_EXCEEDED',
          what: `Entry "${name}" expands ${Math.round(declaredSize / compressed.length)}:1.`,
          why: `That exceeds the ${limits.maxRatio}:1 safety limit, which is the signature of a decompression bomb.`,
          action: 'Extract this archive with a desktop tool if you trust it, then add the files directly.',
        });
      }
      data = await inflateRaw(compressed);
    } else {
      throw new ConversionError({
        code: 'ZIP_UNSUPPORTED_METHOD',
        what: `Entry "${name}" uses compression method ${method}.`,
        why: 'Only stored (0) and deflate (8) entries can be read; methods such as bzip2, LZMA and zstd are not bundled.',
        action: 'Re-create the archive with standard deflate compression.',
      });
    }
    totalBytes += data.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ConversionError({
        code: 'ZIP_TOTAL_SIZE_EXCEEDED',
        what: `The archive expands to more than ${(limits.maxTotalBytes / 1024 / 1024).toFixed(0)} MB.`,
        why: 'Holding that much decompressed data in the browser would exhaust the tab before conversion could finish.',
        action: 'Extract the archive locally and convert the datasets one at a time, or raise the archive limit in Settings → Performance.',
      });
    }
    entries.push({ name, bytes: data, compressedSize: compressed.length, uncompressedSize: data.length, method });
  };

  const eocd = findEocd(bytes);
  if (eocd >= 0) {
    let centralOffset = u32(bytes, eocd + 16);
    let count = u16(bytes, eocd + 10);

    // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64
    // record that the locator points at.
    if (centralOffset === 0xffffffff || count === 0xffff) {
      const locator = eocd - 20;
      if (locator >= 0 && u32(bytes, locator) === SIG_EOCD64_LOCATOR) {
        const zip64At = u64(bytes, locator + 8);
        if (zip64At >= 0 && zip64At < bytes.length && u32(bytes, zip64At) === SIG_EOCD64) {
          count = u64(bytes, zip64At + 32);
          centralOffset = u64(bytes, zip64At + 48);
        }
      }
    }

    let at = centralOffset;
    for (let index = 0; index < count && at + 46 <= bytes.length; index++) {
      if (u32(bytes, at) !== SIG_CENTRAL) break;
      const method = u16(bytes, at + 10);
      let compressedSize = u32(bytes, at + 20);
      let uncompressedSize = u32(bytes, at + 24);
      const nameLength = u16(bytes, at + 28);
      const extraLength = u16(bytes, at + 30);
      const commentLength = u16(bytes, at + 32);
      let localOffset = u32(bytes, at + 42);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

      if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        // Walk the extra field for the 0x0001 ZIP64 record; its members appear
        // only for the fields that saturated, in a fixed order.
        let extraAt = at + 46 + nameLength;
        const extraEnd = extraAt + extraLength;
        while (extraAt + 4 <= extraEnd) {
          const headerId = u16(bytes, extraAt);
          const size = u16(bytes, extraAt + 2);
          let cursor = extraAt + 4;
          if (headerId === 0x0001) {
            if (uncompressedSize === 0xffffffff) {
              uncompressedSize = u64(bytes, cursor);
              cursor += 8;
            }
            if (compressedSize === 0xffffffff) {
              compressedSize = u64(bytes, cursor);
              cursor += 8;
            }
            if (localOffset === 0xffffffff) localOffset = u64(bytes, cursor);
            break;
          }
          extraAt += 4 + size;
        }
      }

      at += 46 + nameLength + extraLength + commentLength;

      if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== SIG_LOCAL) continue;
      const localNameLength = u16(bytes, localOffset + 26);
      const localExtraLength = u16(bytes, localOffset + 28);
      const dataAt = localOffset + 30 + localNameLength + localExtraLength;
      await readOne(name, method, bytes.subarray(dataAt, dataAt + compressedSize), uncompressedSize);
    }
    if (entries.length > 0) return entries;
  }

  // No usable central directory: walk the local headers. Field controllers and
  // some GIS exporters produce archives that end abruptly, and the payload is
  // still recoverable this way.
  let at = 0;
  while (at + 30 <= bytes.length && u32(bytes, at) === SIG_LOCAL) {
    const flags = u16(bytes, at + 6);
    const method = u16(bytes, at + 8);
    const compressedSize = u32(bytes, at + 18);
    const uncompressedSize = u32(bytes, at + 22);
    const nameLength = u16(bytes, at + 26);
    const extraLength = u16(bytes, at + 28);
    const name = decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const dataAt = at + 30 + nameLength + extraLength;
    // Bit 3 means the sizes live in a trailing data descriptor, which cannot be
    // resolved without the central directory.
    if ((flags & 0x08) !== 0 && compressedSize === 0) {
      throw new ConversionError({
        code: 'ZIP_STREAMED_ENTRY',
        what: `Entry "${name}" was written as a stream without a usable central directory.`,
        why: 'Its compressed size is stored in a trailing data descriptor, and the directory that would locate it is missing or damaged.',
        action: 'Repack the archive with a standard ZIP tool and try again.',
      });
    }
    await readOne(name, method, bytes.subarray(dataAt, dataAt + compressedSize), uncompressedSize);
    at = dataAt + compressedSize;
  }

  if (entries.length === 0) {
    throw new ConversionError({
      code: 'ZIP_EMPTY',
      what: 'No readable entries were found in the archive.',
      why: 'The central directory is missing or damaged and no local file headers could be walked.',
      action: 'Re-download the archive, or extract it locally and add the files directly.',
    });
  }
  return entries;
}

export interface ZipInput {
  name: string;
  bytes: Uint8Array;
  /** Skip compression for data that is already compressed (PNG, JPEG, nested ZIP). */
  store?: boolean;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31),
    date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
  };
}

export async function writeZip(files: ZipInput[], now = new Date()): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(now);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name.replace(/\\/g, '/'));
    const raw = file.bytes;
    const deflated = file.store ? null : await deflateRaw(raw);
    // Storing wins whenever compression would grow the entry, which happens for
    // small files and for already-compressed payloads.
    const stored = !deflated || deflated.length >= raw.length;
    const body = stored ? raw : deflated!;
    const method = stored ? 0 : 8;
    const sum = crc32(raw);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, SIG_LOCAL, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 filename flag
    localView.setUint16(8, method, true);
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, sum, true);
    localView.setUint32(18, body.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, body);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, SIG_CENTRAL, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, stamp.time, true);
    centralView.setUint16(14, stamp.date, true);
    centralView.setUint32(16, sum, true);
    centralView.setUint32(20, body.length, true);
    centralView.setUint32(24, raw.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralBlock = concat(centrals);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, SIG_EOCD, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralBlock.length, true);
  eocdView.setUint32(16, offset, true);

  return concat([...locals, centralBlock, eocd]);
}

