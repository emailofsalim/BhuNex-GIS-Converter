/**
 * GeoTIFF — metadata and georeference only.
 *
 * This reader walks the TIFF IFD (and BigTIFF's 64-bit variant), reads the GeoTIFF
 * keys, and reports dimensions, bands, pixel type, nodata and extent. It does
 * **not** decode pixels.
 *
 * That limit is deliberate and is surfaced everywhere: the registry marks the
 * format `metadata-only`, raster export from such a source is refused, and the
 * inspector says so. Claiming raster conversion without a codec would violate
 * rule R1, and quietly emitting an empty raster would violate rule R2. What is
 * genuinely useful — the footprint, extent and CRS — is available and can be
 * exported as vector.
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
  tileWidth: 322,
  tileLength: 323,
  sampleFormat: 339,
  modelPixelScale: 33550,
  modelTiepoint: 33922,
  modelTransformation: 34264,
  geoKeyDirectory: 34735,
  geoDoubleParams: 34736,
  geoAsciiParams: 34737,
  gdalNoData: 42113,
} as const;

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
  tiled: boolean;
  tileWidth?: number;
  tileLength?: number;
  rowsPerStrip?: number;
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

  return {
    width,
    height,
    bandCount: first(TAG.samplesPerPixel, 1),
    bitsPerSample: numbers(TAG.bitsPerSample).length > 0 ? numbers(TAG.bitsPerSample) : [8],
    sampleFormat: first(TAG.sampleFormat, 1),
    compression,
    compressionName: COMPRESSION_NAMES[compression] ?? `unknown (${compression})`,
    tiled: byTag.has(TAG.tileWidth),
    tileWidth: byTag.has(TAG.tileWidth) ? first(TAG.tileWidth, 0) : undefined,
    tileLength: byTag.has(TAG.tileLength) ? first(TAG.tileLength, 0) : undefined,
    rowsPerStrip: byTag.has(TAG.rowsPerStrip) ? first(TAG.rowsPerStrip, 0) : undefined,
    geotransform,
    epsg,
    noData,
    bigTiff,
    littleEndian,
    geoAscii: typeof geoAsciiEntry?.values === 'string' ? geoAsciiEntry.values : undefined,
  };
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
}

export function readGeoTiff(bytes: Uint8Array, source: SourceInfo, options: ReadGeoTiffOptions = {}): CirDataset {
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

  const raster: CirRaster = {
    width: info.width,
    height: info.height,
    bandCount: info.bandCount,
    pixelType: pixelTypeOf(info),
    noData: info.noData,
    geotransform,
    extent,
    // No decoder is bundled, so no pixel values are produced. Writers check this
    // flag and refuse rather than emitting a blank raster.
    hasPixelData: false,
    isElevation,
    metadata: {
      compression: info.compressionName,
      tiled: info.tiled,
      tileSize: info.tiled ? `${info.tileWidth} × ${info.tileLength}` : undefined,
      rowsPerStrip: info.rowsPerStrip,
      bigTiff: info.bigTiff,
      byteOrder: info.littleEndian ? 'little-endian' : 'big-endian',
      bitsPerSample: info.bitsPerSample,
      geoAscii: info.geoAscii,
    },
  };

  warnings.push(
    warn(
      'GEOTIFF_METADATA_ONLY',
      `Georeference and structure were read (${info.width} × ${info.height}, ${info.bandCount} band(s), ${info.compressionName} compression). Pixel data was not decoded.`,
      {
        reason: 'No raster codec is bundled with the extension, so pixel values are not available and raster output from this source is disabled.',
        action: 'The extent and footprint can still be exported as vector. To convert the pixels, use GDAL (gdal_translate) or QGIS.',
        detail: { width: info.width, height: info.height, bands: info.bandCount, compression: info.compressionName },
      }
    )
  );

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
