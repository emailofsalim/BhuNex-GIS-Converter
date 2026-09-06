/**
 * GeoTIFF reader — structure, georeference and pixels.
 *
 * Walks the TIFF IFD (and BigTIFF's 64-bit variant), reads the GeoTIFF keys,
 * and decodes pixel data for the compressions in `tiff-codec.ts`: uncompressed,
 * LZW, Deflate and PackBits, in strips or tiles, in either planar
 * configuration, with predictors 2 and 3.
 *
 * Where a codec genuinely is not bundled — JPEG, JPEG 2000, LERC, WebP,
 * Zstandard — the file is refused **by name** rather than read as raw bytes.
 * A JPEG-compressed tile decoded as raw samples produces a raster that looks
 * like plausible terrain and is entirely fictional, which is precisely what
 * rules R1 and R2 exist to prevent. Metadata, extent and footprint remain
 * available for those files, so nothing that was readable before is lost.
 */

import {
  createDataset,
  warn,
  type CirDataset,
  type CirRaster,
  type CrsRef,
  type PixelType,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { crsFromEpsg } from '../../crs/epsg';
import { parsePrj } from '../../crs/wkt';
import {
  decompressBlock,
  sampleFormatOf,
  sampleReaderFor,
  SUPPORTED_COMPRESSIONS,
  undoFloatingPointPredictor,
  undoHorizontalDifferencing,
} from './tiff-codec';
import { parseWorldFile, worldFileToGeotransform, type Geotransform, type WorldFileTerms } from './worldfile';

const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  planarConfiguration: 284,
  predictor: 317,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
  modelPixelScale: 33550,
  modelTiepoint: 33922,
  modelTransformation: 34264,
  geoKeyDirectory: 34735,
  geoDoubleParams: 34736,
  geoAsciiParams: 34737,
  gdalNoData: 42113,
} as const;

/**
 * Pixel budget for an in-browser decode.
 *
 * Bands are Float64Array, so each band costs 8 bytes per pixel. 120 million
 * samples is roughly a gigabyte — beyond that the honest answer is to say so
 * up front rather than let the tab die halfway through a conversion.
 */
const MAX_SAMPLES = 120_000_000;

const COMPRESSION_NAMES: Record<number, string> = {
  1: 'none',
  2: 'CCITT modified Huffman',
  5: 'LZW',
  6: 'JPEG (old style)',
  7: 'JPEG',
  8: 'Deflate (Adobe)',
  32773: 'PackBits',
  32946: 'Deflate',
  34712: 'JPEG 2000',
  34887: 'LERC',
  50000: 'Zstandard',
  50001: 'WebP',
};

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  values: number[] | string;
}

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

export interface GeoTiffInfo {
  width: number;
  height: number;
  bandCount: number;
  bitsPerSample: number[];
  sampleFormat: number;
  compression: number;
  compressionName: string;
  /** 1 = no prediction, 2 = horizontal differencing, 3 = floating point. */
  predictor: number;
  /** 1 = samples interleaved per pixel, 2 = one plane per band. */
  planarConfiguration: number;
  photometric: number;
  tiled: boolean;
  tileWidth?: number;
  tileLength?: number;
  rowsPerStrip?: number;
  /** Byte offsets of each strip or tile, in reading order. */
  blockOffsets: number[];
  blockByteCounts: number[];
  geotransform: Geotransform | null;
  epsg?: number;
  noData: number | null;
  bigTiff: boolean;
  littleEndian: boolean;
  geoAscii?: string;
}

function readIfd(view: DataView, at: number, littleEndian: boolean, bigTiff: boolean): { entries: IfdEntry[]; next: number } {
  const entryCount = bigTiff ? Number(view.getBigUint64(at, littleEndian)) : view.getUint16(at, littleEndian);
  const entrySize = bigTiff ? 20 : 12;
  const headerSize = bigTiff ? 8 : 2;
  const entries: IfdEntry[] = [];

  for (let index = 0; index < entryCount; index++) {
    const entryAt = at + headerSize + index * entrySize;
    if (entryAt + entrySize > view.byteLength) break;
    const tag = view.getUint16(entryAt, littleEndian);
    const type = view.getUint16(entryAt + 2, littleEndian);
    const count = bigTiff ? Number(view.getBigUint64(entryAt + 4, littleEndian)) : view.getUint32(entryAt + 4, littleEndian);
    const valueFieldAt = entryAt + (bigTiff ? 12 : 8);
    const typeSize = TYPE_SIZES[type] ?? 1;
    const totalBytes = typeSize * count;
    // Values up to the size of the value field are stored inline; larger ones
    // are stored elsewhere and the field holds an offset.
    const inlineCapacity = bigTiff ? 8 : 4;
    const dataAt =
      totalBytes <= inlineCapacity
        ? valueFieldAt
        : bigTiff
          ? Number(view.getBigUint64(valueFieldAt, littleEndian))
          : view.getUint32(valueFieldAt, littleEndian);
    if (dataAt + totalBytes > view.byteLength) {
      entries.push({ tag, type, count, values: [] });
      continue;
    }
    entries.push({ tag, type, count, values: readValues(view, dataAt, type, count, littleEndian) });
  }

  const nextAt = at + headerSize + entryCount * entrySize;
  const next =
    nextAt + (bigTiff ? 8 : 4) <= view.byteLength
      ? bigTiff
        ? Number(view.getBigUint64(nextAt, littleEndian))
        : view.getUint32(nextAt, littleEndian)
      : 0;
  return { entries, next };
}

function readValues(view: DataView, at: number, type: number, count: number, littleEndian: boolean): number[] | string {
  if (type === 2) {
    let out = '';
    for (let index = 0; index < count; index++) {
      const code = view.getUint8(at + index);
      if (code === 0) break;
      out += String.fromCharCode(code);
    }
    return out;
  }
  const values: number[] = [];
  const size = TYPE_SIZES[type] ?? 1;
  for (let index = 0; index < count; index++) {
    const offset = at + index * size;
    switch (type) {
      case 1:
      case 7:
        values.push(view.getUint8(offset));
        break;
      case 3:
        values.push(view.getUint16(offset, littleEndian));
        break;
      case 4:
        values.push(view.getUint32(offset, littleEndian));
        break;
      case 5:
        // RATIONAL: two 32-bit values, numerator over denominator.
        values.push(view.getUint32(offset, littleEndian) / (view.getUint32(offset + 4, littleEndian) || 1));
        break;
      case 6:
        values.push(view.getInt8(offset));
        break;
      case 8:
        values.push(view.getInt16(offset, littleEndian));
        break;
      case 9:
        values.push(view.getInt32(offset, littleEndian));
        break;
      case 10:
        values.push(view.getInt32(offset, littleEndian) / (view.getInt32(offset + 4, littleEndian) || 1));
        break;
      case 11:
        values.push(view.getFloat32(offset, littleEndian));
        break;
      case 12:
        values.push(view.getFloat64(offset, littleEndian));
        break;
      case 16:
        values.push(Number(view.getBigUint64(offset, littleEndian)));
        break;
      case 17:
        values.push(Number(view.getBigInt64(offset, littleEndian)));
        break;
      default:
        values.push(0);
        break;
    }
  }
  return values;
}

export function readGeoTiffInfo(bytes: Uint8Array): GeoTiffInfo {
  if (bytes.length < 8) {
    throw new ConversionError({
      code: 'TIFF_TOO_SHORT',
      what: 'The file is shorter than a TIFF header.',
      why: 'A TIFF begins with an 8-byte header naming the byte order and the first IFD offset.',
      action: 'Re-copy the file; it did not transfer completely.',
    });
  }
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49;
  const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!littleEndian && !bigEndian) {
    throw new ConversionError({
      code: 'TIFF_BAD_BYTE_ORDER',
      what: 'The file does not begin with a TIFF byte-order mark.',
      why: 'Expected "II" (little-endian) or "MM" (big-endian).',
      action: 'Confirm the detected format in the inspector.',
    });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(2, littleEndian);
  const bigTiff = version === 43;
  if (version !== 42 && version !== 43) {
    throw new ConversionError({
      code: 'TIFF_BAD_VERSION',
      what: `TIFF version word is ${version}.`,
      why: 'Only 42 (TIFF) and 43 (BigTIFF) are defined.',
      action: 'The file is corrupt or is not a TIFF.',
    });
  }

  const firstIfd = bigTiff ? Number(view.getBigUint64(8, littleEndian)) : view.getUint32(4, littleEndian);
  const { entries } = readIfd(view, firstIfd, littleEndian, bigTiff);
  const byTag = new Map(entries.map((entry) => [entry.tag, entry]));
  const numbers = (tag: number): number[] => {
    const entry = byTag.get(tag);
    return Array.isArray(entry?.values) ? (entry!.values as number[]) : [];
  };
  const first = (tag: number, fallback: number): number => numbers(tag)[0] ?? fallback;

  const width = first(TAG.imageWidth, 0);
  const height = first(TAG.imageLength, 0);
  if (width <= 0 || height <= 0) {
    throw new ConversionError({
      code: 'TIFF_NO_DIMENSIONS',
      what: 'The TIFF declares no image dimensions.',
      why: 'The ImageWidth or ImageLength tag is missing from the first IFD.',
      action: 'The file is malformed; re-export it from your GIS or imaging software.',
    });
  }

  // Georeference: ModelTransformation wins when present, otherwise the
  // tiepoint-plus-pixel-scale pair, which is what almost every GeoTIFF uses.
  let geotransform: Geotransform | null = null;
  const transformation = numbers(TAG.modelTransformation);
  if (transformation.length >= 16) {
    geotransform = [transformation[3], transformation[0], transformation[1], transformation[7], transformation[4], transformation[5]];
  } else {
    const scale = numbers(TAG.modelPixelScale);
    const tiepoint = numbers(TAG.modelTiepoint);
    if (scale.length >= 2 && tiepoint.length >= 6) {
      // Tiepoint maps raster (i,j,k) to model (x,y,z); the raster point is
      // normally (0,0,0), i.e. the top-left corner.
      const terms: WorldFileTerms = {
        a: scale[0],
        d: 0,
        b: 0,
        e: -Math.abs(scale[1]),
        c: tiepoint[3] + scale[0] / 2,
        f: tiepoint[4] - Math.abs(scale[1]) / 2,
      };
      geotransform = worldFileToGeotransform(terms);
    }
  }

  // GeoKeyDirectory: 4-short header then 4-short entries.
  let epsg: number | undefined;
  const geoKeys = numbers(TAG.geoKeyDirectory);
  if (geoKeys.length >= 4) {
    const keyCount = geoKeys[3];
    for (let index = 0; index < keyCount; index++) {
      const base = 4 + index * 4;
      if (base + 3 >= geoKeys.length) break;
      const keyId = geoKeys[base];
      const tiffTagLocation = geoKeys[base + 1];
      const value = geoKeys[base + 3];
      // 3072 = ProjectedCSTypeGeoKey, 2048 = GeographicTypeGeoKey. A non-zero
      // tag location means the value lives in another tag, not inline.
      if ((keyId === 3072 || keyId === 2048) && tiffTagLocation === 0 && value > 0 && value < 32767) {
        epsg = value;
        if (keyId === 3072) break;
      }
    }
  }

  const noDataEntry = byTag.get(TAG.gdalNoData);
  const noDataText = typeof noDataEntry?.values === 'string' ? noDataEntry.values : undefined;
  const noData = noDataText !== undefined && Number.isFinite(Number(noDataText)) ? Number(noDataText) : null;
  const compression = first(TAG.compression, 1);
  const geoAsciiEntry = byTag.get(TAG.geoAsciiParams);
  const tiled = byTag.has(TAG.tileWidth);

  return {
    width,
    height,
    bandCount: first(TAG.samplesPerPixel, 1),
    bitsPerSample: numbers(TAG.bitsPerSample).length > 0 ? numbers(TAG.bitsPerSample) : [8],
    sampleFormat: first(TAG.sampleFormat, 1),
    compression,
    compressionName: COMPRESSION_NAMES[compression] ?? `unknown (${compression})`,
    predictor: first(TAG.predictor, 1),
    planarConfiguration: first(TAG.planarConfiguration, 1),
    photometric: first(TAG.photometric, 1),
    tiled,
    tileWidth: tiled ? first(TAG.tileWidth, 0) : undefined,
    tileLength: tiled ? first(TAG.tileLength, 0) : undefined,
    rowsPerStrip: byTag.has(TAG.rowsPerStrip) ? first(TAG.rowsPerStrip, 0) : undefined,
    blockOffsets: tiled ? numbers(TAG.tileOffsets) : numbers(TAG.stripOffsets),
    blockByteCounts: tiled ? numbers(TAG.tileByteCounts) : numbers(TAG.stripByteCounts),
    geotransform,
    epsg,
    noData,
    bigTiff,
    littleEndian,
    geoAscii: typeof geoAsciiEntry?.values === 'string' ? geoAsciiEntry.values : undefined,
  };
}

/**
 * Decodes every band into a Float64Array laid out row-major, top row first.
 *
 * One numeric type for every band regardless of the file's own sample width is
 * a deliberate simplification of the CIR: a DEM's float32 elevations, a
 * classification raster's uint8 codes and a 16-bit intensity band all become
 * doubles, which every downstream writer can consume without a type switch.
 * Float64 represents every one of those exactly, so nothing is lost on the way
 * in — the cost is memory, which `MAX_SAMPLES` bounds.
 */
export async function decodeGeoTiffPixels(bytes: Uint8Array, info: GeoTiffInfo): Promise<Float64Array[]> {
  const { width, height, bandCount } = info;
  const totalSamples = width * height * bandCount;
  if (totalSamples > MAX_SAMPLES) {
    throw new ConversionError({
      code: 'TIFF_TOO_LARGE',
      what: `This raster holds ${totalSamples.toLocaleString()} samples (${width} × ${height} × ${bandCount} bands), beyond what can be decoded in the browser.`,
      why: `Decoding needs roughly ${Math.round((totalSamples * 8) / 1024 / 1024).toLocaleString()} MB of contiguous memory, above the ${Math.round((MAX_SAMPLES * 8) / 1024 / 1024).toLocaleString()} MB ceiling this build sets to avoid crashing mid-conversion.`,
      action: 'Crop or downsample the raster first (gdal_translate -srcwin, or QGIS → Raster → Extraction → Clip), or convert one band at a time.',
    });
  }

  if (!SUPPORTED_COMPRESSIONS.has(info.compression)) {
    throw new ConversionError({
      code: 'TIFF_COMPRESSION_UNSUPPORTED',
      what: `This GeoTIFF uses ${info.compressionName} compression, which this build cannot decode.`,
      why: 'Only uncompressed, LZW, Deflate and PackBits data are decoded here. Reading the compressed bytes as if they were pixels would produce a convincing but entirely false raster.',
      action: 'Re-export the file with Deflate or LZW compression (gdal_translate -co COMPRESS=DEFLATE, or QGIS → Raster → Conversion → Translate), then convert it again. Its georeference, extent and footprint are still readable as they are.',
    });
  }

  const bitsPerSample = info.bitsPerSample[0] ?? 8;
  if (info.bitsPerSample.some((bits) => bits !== bitsPerSample)) {
    throw new ConversionError({
      code: 'TIFF_MIXED_SAMPLE_WIDTHS',
      what: `The bands of this GeoTIFF use different sample widths (${info.bitsPerSample.join(', ')} bits).`,
      why: 'Mixed-width bands are legal TIFF but vanishingly rare, and guessing the packing would risk misreading every pixel.',
      action: 'Re-export the raster with a single sample width for all bands.',
    });
  }

  const format = sampleFormatOf(info.sampleFormat);
  const read = sampleReaderFor(format, bitsPerSample, info.littleEndian);
  const bands: Float64Array[] = [];
  for (let band = 0; band < bandCount; band++) bands.push(new Float64Array(width * height));

  // Planar configuration 2 stores each band as its own sequence of blocks, so a
  // block index maps to (band, block-within-band) rather than to all bands.
  const planar = info.planarConfiguration === 2;
  const samplesPerBlockPixel = planar ? 1 : bandCount;

  const blockWidth = info.tiled ? (info.tileWidth ?? width) : width;
  const blockHeight = info.tiled ? (info.tileLength ?? height) : (info.rowsPerStrip || height);
  const blocksAcross = Math.ceil(width / blockWidth);
  const blocksDown = Math.ceil(height / blockHeight);
  const blocksPerPlane = blocksAcross * blocksDown;

  for (let index = 0; index < info.blockOffsets.length; index++) {
    const offset = info.blockOffsets[index];
    const byteCount = info.blockByteCounts[index] ?? 0;
    if (byteCount <= 0 || offset < 0 || offset + byteCount > bytes.length) continue;

    const planeIndex = planar ? Math.floor(index / blocksPerPlane) : 0;
    if (planeIndex >= bandCount) break;
    const blockIndex = planar ? index % blocksPerPlane : index;
    const blockRow = Math.floor(blockIndex / blocksAcross);
    const blockCol = blockIndex % blocksAcross;
    const originX = blockCol * blockWidth;
    const originY = blockRow * blockHeight;
    if (originY >= height) continue;

    // A strip is clipped to the image; a tile is always full-size and padded,
    // which is why the padding has to be skipped rather than written.
    const rowsInBlock = info.tiled ? blockHeight : Math.min(blockHeight, height - originY);
    const expectedBytes = Math.ceil((blockWidth * samplesPerBlockPixel * bitsPerSample) / 8) * rowsInBlock;

    const decoded = await decompressBlock(bytes.subarray(offset, offset + byteCount), info.compression, expectedBytes, info.compressionName);
    // An uncompressed block comes back as a view onto the source file, and the
    // predictors below mutate in place. Copying only in that case keeps the
    // common compressed path allocation-free.
    const block = info.predictor !== 1 && decoded.buffer === bytes.buffer ? decoded.slice() : decoded;

    if (info.predictor === 2) {
      undoHorizontalDifferencing(block, blockWidth, rowsInBlock, samplesPerBlockPixel, bitsPerSample, info.littleEndian);
    } else if (info.predictor === 3) {
      undoFloatingPointPredictor(block, blockWidth, rowsInBlock, samplesPerBlockPixel, bitsPerSample, info.littleEndian);
    }

    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const rowSampleCount = blockWidth * samplesPerBlockPixel;
    const rowBytes = Math.ceil((rowSampleCount * bitsPerSample) / 8);

    for (let row = 0; row < rowsInBlock; row++) {
      const imageRow = originY + row;
      if (imageRow >= height) break;
      const rowAt = row * rowBytes;
      if (rowAt + rowBytes > block.length) break;
      const columns = Math.min(blockWidth, width - originX);
      for (let column = 0; column < columns; column++) {
        const target = imageRow * width + originX + column;
        if (planar) {
          bands[planeIndex][target] = read(view, rowAt, column);
        } else {
          for (let band = 0; band < bandCount; band++) {
            bands[band][target] = read(view, rowAt, column * bandCount + band);
          }
        }
      }
    }
  }

  return bands;
}

/** Min/max/mean per band, ignoring nodata — computed once so the UI need not. */
export function bandStatistics(bands: Float64Array[], noData: number | null): { min: number; max: number; mean?: number }[] {
  return bands.map((values) => {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let counted = 0;
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (!Number.isFinite(value)) continue;
      if (noData !== null && value === noData) continue;
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
      counted++;
    }
    return counted > 0 ? { min, max, mean: sum / counted } : { min: 0, max: 0 };
  });
}

function pixelTypeOf(info: GeoTiffInfo): PixelType {
  const bits = info.bitsPerSample[0] ?? 8;
  // SampleFormat: 1 unsigned, 2 signed, 3 IEEE float.
  if (info.sampleFormat === 3) return bits === 64 ? 'float64' : 'float32';
  if (info.sampleFormat === 2) return bits === 8 ? 'int8' : bits === 16 ? 'int16' : bits === 32 ? 'int32' : 'unknown';
  return bits === 8 ? 'uint8' : bits === 16 ? 'uint16' : bits === 32 ? 'uint32' : 'unknown';
}

export interface ReadGeoTiffOptions {
  /** World file text, when one accompanies the image. */
  worldFileText?: string;
  /** .prj text, when one accompanies the image. */
  prjText?: string;
  /**
   * Skip the pixel decode and read structure only. The inspector uses this to
   * show a 2 GB raster's georeference instantly; conversion never does.
   */
  metadataOnly?: boolean;
}

export async function readGeoTiff(bytes: Uint8Array, source: SourceInfo, options: ReadGeoTiffOptions = {}): Promise<CirDataset> {
  const info = readGeoTiffInfo(bytes);
  const warnings: Warning[] = [];

  let geotransform = info.geotransform;
  let crsFromSidecar: CrsRef | null = null;
  if (!geotransform && options.worldFileText) {
    // A world file rescues an ordinary TIFF that carries no GeoTIFF tags.
    geotransform = worldFileToGeotransform(parseWorldFile(options.worldFileText));
  }
  if (options.prjText) crsFromSidecar = parsePrj(options.prjText).crs;

  const crs = crsFromSidecar ?? (info.epsg ? crsFromEpsg(info.epsg) : null);
  const bitsPerSample = info.bitsPerSample[0] ?? 8;
  const isElevation = info.bandCount === 1 && (info.sampleFormat === 3 || bitsPerSample >= 16);

  const extent = geotransform
    ? {
        minX: Math.min(geotransform[0], geotransform[0] + geotransform[1] * info.width),
        maxX: Math.max(geotransform[0], geotransform[0] + geotransform[1] * info.width),
        minY: Math.min(geotransform[3], geotransform[3] + geotransform[5] * info.height),
        maxY: Math.max(geotransform[3], geotransform[3] + geotransform[5] * info.height),
      }
    : null;

  // Pixels are decoded unless the caller asked for structure only or the file
  // uses a codec that is not bundled. A refusal here is reported as a named
  // warning and the dataset still carries everything that *was* readable —
  // failing the whole read would lose the georeference too.
  let bands: Float64Array[] | undefined;
  let statistics: { min: number; max: number; mean?: number }[] | undefined;
  let undecodable: ConversionError | null = null;

  if (!options.metadataOnly) {
    try {
      bands = await decodeGeoTiffPixels(bytes, info);
      statistics = bandStatistics(bands, info.noData);
    } catch (error) {
      if (!(error instanceof ConversionError)) throw error;
      undecodable = error;
      bands = undefined;
    }
  }

  const raster: CirRaster = {
    width: info.width,
    height: info.height,
    bandCount: info.bandCount,
    pixelType: pixelTypeOf(info),
    noData: info.noData,
    geotransform,
    extent,
    statistics,
    bands,
    // Writers check this flag and refuse rather than emitting a blank raster.
    hasPixelData: Boolean(bands),
    isElevation,
    metadata: {
      compression: info.compressionName,
      predictor: info.predictor === 2 ? 'horizontal differencing' : info.predictor === 3 ? 'floating point' : 'none',
      planarConfiguration: info.planarConfiguration === 2 ? 'separate planes' : 'interleaved',
      tiled: info.tiled,
      tileSize: info.tiled ? `${info.tileWidth} × ${info.tileLength}` : undefined,
      rowsPerStrip: info.rowsPerStrip,
      bigTiff: info.bigTiff,
      byteOrder: info.littleEndian ? 'little-endian' : 'big-endian',
      bitsPerSample: info.bitsPerSample,
      geoAscii: info.geoAscii,
    },
  };

  if (undecodable) {
    warnings.push(
      warn('GEOTIFF_PIXELS_NOT_DECODED', undecodable.what, {
        reason: undecodable.why,
        action: `${undecodable.action} The georeference, extent and footprint of this file were read normally and can still be exported.`,
        detail: { width: info.width, height: info.height, bands: info.bandCount, compression: info.compressionName, code: undecodable.code },
      })
    );
  } else if (options.metadataOnly) {
    warnings.push(
      warn('GEOTIFF_METADATA_ONLY', 'Only the georeference and structure were read for this preview.', {
        reason: 'The inspector reads structure first so a large raster opens immediately; the conversion itself decodes every pixel.',
        action: 'No action needed — converting this file will read its pixel data in full.',
      })
    );
  }

  if (!geotransform) {
    warnings.push(
      warn('GEOTIFF_NOT_GEOREFERENCED', 'The image carries no georeference.', {
        reason: 'It has neither GeoTIFF model tags nor an accompanying world file, so its ground position is unknown.',
        action: 'Add a .tfw world file next to the image, or georeference it in QGIS. No coordinates were invented for it.',
      })
    );
  }
  if (!crs) {
    warnings.push(
      warn('GEOTIFF_NO_CRS', 'No coordinate reference system was found.', {
        reason: info.epsg ? `The file declares EPSG:${info.epsg}, which is not in the bundled CRS list.` : 'The file has no GeoKey CRS entry and no .prj sidecar.',
        action: 'Select the source CRS manually before converting coordinates.',
      })
    );
  }

  return createDataset({
    kind: 'raster',
    name: source.fileName,
    source,
    crs,
    crsOrigin: crsFromSidecar ? 'sidecar' : crs ? 'declared' : 'unknown',
    units: crs?.kind === 'projected' ? 'm' : null,
    axisOrder: 'xy',
    layers: [],
    raster,
    warnings,
    metadata: raster.metadata,
  });
}

/**
 * Exports the raster footprint as a vector polygon — the one genuinely useful
 * product available without a pixel codec.
 */
export function rasterFootprint(dataset: CirDataset): CirDataset {
  const raster = dataset.raster;
  if (!raster?.extent) {
    throw new ConversionError({
      code: 'RASTER_NO_EXTENT',
      what: 'The raster has no known extent, so no footprint can be produced.',
      why: 'It carries no georeference.',
      action: 'Add a world file or georeference the image first.',
    });
  }
  const { minX, minY, maxX, maxY } = raster.extent;
  return {
    ...dataset,
    kind: 'vector',
    layers: [
      {
        name: `${dataset.name} footprint`,
        path: ['footprint'],
        fields: [],
        geometryTypes: ['Polygon'],
        features: [
          {
            id: 'footprint',
            geometry: {
              type: 'Polygon',
              coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]],
              dimension: 2,
            },
            properties: {
              source: dataset.source.fileName,
              width: raster.width,
              height: raster.height,
              bands: raster.bandCount,
              pixel_type: raster.pixelType,
              pixel_size_x: raster.geotransform?.[1] ?? null,
              pixel_size_y: raster.geotransform?.[5] ?? null,
            },
          },
        ],
      },
    ],
  };
}
