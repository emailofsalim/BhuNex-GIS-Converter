/**
 * LAS point clouds, versions 1.0–1.4.
 *
 * Coordinates are stored as 32-bit integers plus a per-file scale and offset:
 * x = X * scaleX + offsetX. Applying that in double precision is what keeps a
 * millimetre-resolution scan millimetre-accurate.
 *
 * LAZ is refused, never guessed at. The compressed point-format bit is checked
 * before any point is read, because parsing arithmetic-coded bytes as raw
 * records produces coordinates that look plausible and are entirely fictional
 * (rule R5).
 */

import {
  createDataset,
  emptyPointAttributes,
  warn,
  type Bounds3,
  type CirDataset,
  type CirPointArrays,
  type CirPointCloud,
  type PointAttributeFlags,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { parsePrj } from '../../crs/wkt';

/** Byte length of each point data record format. */
const POINT_RECORD_LENGTH: Record<number, number> = {
  0: 20,
  1: 28,
  2: 26,
  3: 34,
  4: 57,
  5: 63,
  6: 30,
  7: 36,
  8: 38,
  9: 59,
  10: 67,
};

const HAS_GPS_TIME = new Set([1, 3, 4, 5, 6, 7, 8, 9, 10]);
const HAS_COLOR = new Set([2, 3, 5, 7, 8, 10]);
/** Formats 6-10 use the extended point record layout with a wider return field. */
const EXTENDED_FORMATS = new Set([6, 7, 8, 9, 10]);

export interface LasHeader {
  versionMajor: number;
  versionMinor: number;
  pointDataOffset: number;
  variableLengthRecordCount: number;
  pointFormat: number;
  pointRecordLength: number;
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  bounds: Bounds3;
  systemIdentifier: string;
  generatingSoftware: string;
  /** True when the point-format high bits mark laszip compression. */
  compressed: boolean;
  /** CRS WKT from a VLR, when the file carries one. */
  wkt?: string;
  /** EPSG code from a GeoTIFF-key VLR, when present. */
  epsg?: number;
}

function readAscii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index++) {
    const code = bytes[at + index];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

export function readLasHeader(bytes: Uint8Array): LasHeader {
  if (bytes.length < 227) {
    throw new ConversionError({
      code: 'LAS_TOO_SHORT',
      what: 'The file is shorter than the smallest LAS header.',
      why: `A LAS 1.0 public header block is 227 bytes; this file is ${bytes.length}.`,
      action: 'Re-copy the file — it did not transfer completely.',
    });
  }
  if (!(bytes[0] === 0x4c && bytes[1] === 0x41 && bytes[2] === 0x53 && bytes[3] === 0x46)) {
    throw new ConversionError({
      code: 'LAS_BAD_SIGNATURE',
      what: 'The file does not begin with the "LASF" signature.',
      why: `Found "${readAscii(bytes, 0, 4)}" instead.`,
      action: 'Confirm the detected format in the inspector; the file may have been renamed.',
    });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionMajor = bytes[24];
  const versionMinor = bytes[25];
  const rawPointFormat = view.getUint8(104);
  // Bits 6 and 7 of the point data format id are the laszip compression flags.
  const compressed = (rawPointFormat & 0xc0) !== 0;
  const pointFormat = rawPointFormat & 0x3f;

  const header: LasHeader = {
    versionMajor,
    versionMinor,
    pointDataOffset: view.getUint32(96, true),
    variableLengthRecordCount: view.getUint32(100, true),
    pointFormat,
    pointRecordLength: view.getUint16(105, true),
    pointCount: view.getUint32(107, true),
    scale: [view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true)],
    offset: [view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true)],
    bounds: {
      maxX: view.getFloat64(179, true),
      minX: view.getFloat64(187, true),
      maxY: view.getFloat64(195, true),
      minY: view.getFloat64(203, true),
      maxZ: view.getFloat64(211, true),
      minZ: view.getFloat64(219, true),
    },
    systemIdentifier: readAscii(bytes, 26, 32),
    generatingSoftware: readAscii(bytes, 58, 32),
    compressed,
  };

  // LAS 1.4 moved the point count to a 64-bit field; the legacy 32-bit field is
  // zero for files with more than 4.29 billion points.
  if (versionMajor === 1 && versionMinor >= 4 && bytes.length >= 375) {
    const extended = Number(view.getBigUint64(247, true));
    if (extended > 0) header.pointCount = extended;
  }

  // Walk the VLRs for a CRS. Both encodings occur: WKT (record 2112) in newer
  // files, GeoTIFF keys (34735) in older ones.
  let at = versionMajor === 1 && versionMinor >= 4 ? 375 : versionMinor >= 3 ? 235 : 227;
  for (let index = 0; index < header.variableLengthRecordCount && at + 54 <= bytes.length; index++) {
    const recordId = view.getUint16(at + 18, true);
    const length = view.getUint16(at + 20, true);
    const payloadAt = at + 54;
    if (payloadAt + length > bytes.length) break;
    if (recordId === 2112) {
      header.wkt = readAscii(bytes, payloadAt, length);
    } else if (recordId === 34735) {
      // GeoKeyDirectory: 4-short header then 4-short entries; key 3072 is the
      // projected CRS code and 2048 the geographic one.
      const keyCount = view.getUint16(payloadAt + 6, true);
      for (let key = 0; key < keyCount; key++) {
        const entryAt = payloadAt + 8 + key * 8;
        if (entryAt + 8 > bytes.length) break;
        const keyId = view.getUint16(entryAt, true);
        const tiffTagLocation = view.getUint16(entryAt + 2, true);
        const value = view.getUint16(entryAt + 6, true);
        if ((keyId === 3072 || keyId === 2048) && tiffTagLocation === 0 && value > 0 && value < 32767) {
          header.epsg = value;
          break;
        }
      }
    }
    at = payloadAt + length;
  }

  return header;
}

export interface ReadLasOptions {
  /** Read at most this many points; null loads all of them. */
  maxPoints?: number | null;
  /** Keep every nth point when decimating a preview. */
  stride?: number;
  /** CRS WKT from an accompanying .prj file. */
  prjText?: string;
}

export function readLas(bytes: Uint8Array, source: SourceInfo, options: ReadLasOptions = {}): CirDataset {
  const header = readLasHeader(bytes);
  const warnings: Warning[] = [];

  if (header.compressed) {
    throw new ConversionError({
      code: 'LAZ_NOT_DECODABLE',
      what: `This is a compressed LAZ file (LAS ${header.versionMajor}.${header.versionMinor}, point format ${header.pointFormat}, ${header.pointCount.toLocaleString()} points).`,
      why: 'LAZ point records are arithmetic-coded. No laszip decoder is bundled, and reading the compressed bytes as uncompressed records would produce coordinates that look plausible but are fictional.',
      action: 'Convert the file to .las with LAStools, PDAL or CloudCompare, then bring the .las here. The header above was read correctly and is shown in the inspector.',
      detail: { pointCount: header.pointCount, bounds: header.bounds, version: `${header.versionMajor}.${header.versionMinor}` },
    });
  }

  const expectedLength = POINT_RECORD_LENGTH[header.pointFormat];
  if (expectedLength === undefined) {
    throw new ConversionError({
      code: 'LAS_UNKNOWN_POINT_FORMAT',
      what: `Point data record format ${header.pointFormat} is not defined in the LAS specification.`,
      why: 'Formats 0-10 are the only ones defined through LAS 1.4.',
      action: 'Re-export the file from your point-cloud software using a standard point format.',
    });
  }
  if (header.pointRecordLength < expectedLength) {
    throw new ConversionError({
      code: 'LAS_RECORD_TOO_SHORT',
      what: `The header declares a ${header.pointRecordLength}-byte point record, but format ${header.pointFormat} needs ${expectedLength} bytes.`,
      why: 'The header is inconsistent with its own point format, so the record layout cannot be trusted.',
      action: 'Re-export the file; this one is malformed.',
    });
  }

  const availableBytes = bytes.length - header.pointDataOffset;
  const availablePoints = Math.floor(availableBytes / header.pointRecordLength);
  let pointCount = header.pointCount;
  if (pointCount > availablePoints) {
    warnings.push(
      warn(
        'LAS_TRUNCATED',
        `The header declares ${pointCount.toLocaleString()} points but the file holds only ${availablePoints.toLocaleString()}.`,
        {
          severity: 'error',
          reason: 'The file is truncated or was copied while still being written.',
          action: 'Re-copy the file. The points that are present were read; the rest do not exist in this file.',
          detail: { declared: pointCount, available: availablePoints },
        }
      )
    );
    pointCount = availablePoints;
  }

  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const limit = options.maxPoints === null || options.maxPoints === undefined ? Infinity : options.maxPoints;
  const loaded = Math.min(Math.ceil(pointCount / stride), limit === Infinity ? Number.MAX_SAFE_INTEGER : limit);

  const attributes: PointAttributeFlags = {
    ...emptyPointAttributes(),
    intensity: true,
    classification: true,
    returnNumber: true,
    numberOfReturns: true,
    scanAngle: true,
    sourceId: true,
    gpsTime: HAS_GPS_TIME.has(header.pointFormat),
    color: HAS_COLOR.has(header.pointFormat),
  };

  const points: CirPointArrays = {
    x: new Float64Array(loaded),
    y: new Float64Array(loaded),
    z: new Float64Array(loaded),
    intensity: new Uint16Array(loaded),
    classification: new Uint8Array(loaded),
    returnNumber: new Uint8Array(loaded),
    numberOfReturns: new Uint8Array(loaded),
    scanAngle: new Int16Array(loaded),
    sourceId: new Uint16Array(loaded),
  };
  if (attributes.gpsTime) points.gpsTime = new Float64Array(loaded);
  if (attributes.color) points.rgb = new Uint16Array(loaded * 3);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [scaleX, scaleY, scaleZ] = header.scale;
  const [offsetX, offsetY, offsetZ] = header.offset;
  const extended = EXTENDED_FORMATS.has(header.pointFormat);
  const colorOffset = header.pointFormat === 2 ? 20 : header.pointFormat === 3 ? 28 : header.pointFormat === 5 ? 28 : header.pointFormat === 7 ? 30 : header.pointFormat === 8 ? 30 : header.pointFormat === 10 ? 30 : -1;
  const gpsOffset = extended ? 22 : 20;

  let written = 0;
  for (let index = 0; index < pointCount && written < loaded; index += stride) {
    const at = header.pointDataOffset + index * header.pointRecordLength;
    points.x[written] = view.getInt32(at, true) * scaleX + offsetX;
    points.y[written] = view.getInt32(at + 4, true) * scaleY + offsetY;
    points.z[written] = view.getInt32(at + 8, true) * scaleZ + offsetZ;
    points.intensity![written] = view.getUint16(at + 12, true);

    if (extended) {
      // Formats 6-10: returns occupy a full byte, classification its own byte.
      const returnByte = view.getUint8(at + 14);
      points.returnNumber![written] = returnByte & 0x0f;
      points.numberOfReturns![written] = (returnByte >> 4) & 0x0f;
      points.classification![written] = view.getUint8(at + 16);
      points.scanAngle![written] = view.getInt16(at + 18, true);
      points.sourceId![written] = view.getUint16(at + 20, true);
    } else {
      // Formats 0-5 pack return number, return count, scan direction and edge
      // flag into one byte.
      const flags = view.getUint8(at + 14);
      points.returnNumber![written] = flags & 0x07;
      points.numberOfReturns![written] = (flags >> 3) & 0x07;
      // The low five bits of the classification byte are the class; the top
      // three are synthetic/key-point/withheld flags.
      points.classification![written] = view.getUint8(at + 15) & 0x1f;
      points.scanAngle![written] = view.getInt8(at + 16);
      points.sourceId![written] = view.getUint16(at + 18, true);
    }

    if (points.gpsTime) points.gpsTime[written] = view.getFloat64(at + gpsOffset, true);
    if (points.rgb && colorOffset >= 0) {
      points.rgb[written * 3] = view.getUint16(at + colorOffset, true);
      points.rgb[written * 3 + 1] = view.getUint16(at + colorOffset + 2, true);
      points.rgb[written * 3 + 2] = view.getUint16(at + colorOffset + 4, true);
    }
    written++;
  }

  if (written < loaded) {
    // Trim the typed arrays so `loaded` and the array lengths always agree.
    points.x = points.x.subarray(0, written);
    points.y = points.y.subarray(0, written);
    points.z = points.z.subarray(0, written);
  }

  const decimated = stride > 1 || written < pointCount;
  if (decimated) {
    warnings.push(
      warn('LAS_PREVIEW_DECIMATED', `${written.toLocaleString()} of ${pointCount.toLocaleString()} points were loaded.`, {
        severity: 'info',
        reason: stride > 1 ? `Every ${stride}th point was kept for the preview.` : 'A point limit was applied.',
        action: 'Export runs on the full file unless a decimation filter is set explicitly in the conversion settings.',
      })
    );
  }

  const pointcloud: CirPointCloud = {
    count: pointCount,
    loaded: written,
    bounds: header.bounds,
    scale: header.scale,
    offset: header.offset,
    pointFormat: header.pointFormat,
    versionMajor: header.versionMajor,
    versionMinor: header.versionMinor,
    attributes,
    points,
    decimation: stride > 1 ? { mode: 'nth', factor: stride } : null,
  };

  const prj = options.prjText ? parsePrj(options.prjText) : null;
  const wktCrs = header.wkt ? parsePrj(header.wkt) : null;
  const crs = prj?.crs ?? wktCrs?.crs ?? null;

  if (!crs && header.epsg) {
    warnings.push(
      warn('LAS_EPSG_UNRESOLVED', `The file declares EPSG:${header.epsg}, which is not in the bundled CRS list.`, {
        reason: 'Only the CRS needed for survey and GIS work in this product are bundled.',
        action: 'Select the source CRS manually, or add a .prj file next to the .las.',
      })
    );
  } else if (!crs) {
    warnings.push(
      warn('LAS_NO_CRS', 'The file declares no coordinate reference system.', {
        reason: 'No CRS WKT VLR, GeoTIFF key VLR or .prj sidecar was found.',
        action: 'Select the source CRS before transforming coordinates.',
      })
    );
  }

  return createDataset({
    kind: 'pointcloud',
    name: source.fileName,
    source,
    crs,
    crsOrigin: prj?.crs ? 'sidecar' : wktCrs?.crs ? 'declared' : 'unknown',
    units: crs?.kind === 'projected' ? 'm' : null,
    axisOrder: 'xy',
    // A LAS Z is whatever the surveyor put there; the format does not record
    // which vertical reference it belongs to.
    vertical: { kind: 'unknown' },
    layers: [],
    pointcloud,
    warnings,
    metadata: {
      version: `${header.versionMajor}.${header.versionMinor}`,
      pointFormat: header.pointFormat,
      systemIdentifier: header.systemIdentifier,
      generatingSoftware: header.generatingSoftware,
      variableLengthRecords: header.variableLengthRecordCount,
      declaredEpsg: header.epsg,
    },
  });
}

export interface WriteLasOptions {
  versionMinor: 2 | 4;
  pointFormat: number;
  /** Pin the scale instead of deriving it from the data extent. */
  scale?: [number, number, number];
  offset?: [number, number, number];
  /** Default class for sources that carry none. */
  defaultClassification?: number;
  systemIdentifier?: string;
  generatingSoftware?: string;
}

export const DEFAULT_LAS_OPTIONS: WriteLasOptions = {
  versionMinor: 2,
  pointFormat: 1,
  defaultClassification: 0,
  systemIdentifier: 'BhuNex GIS Converter',
  generatingSoftware: 'BhuNex GIS Converter 1.0',
};

/**
 * Derives a scale that keeps the full extent inside the signed 32-bit integer
 * range. 0.001 (millimetre) is the survey default and is used whenever the
 * extent allows it, because a coarser scale silently quantises the data.
 */
function deriveScale(bounds: Bounds3): [number, number, number] {
  const span = (min: number, max: number) => Math.max(1, Math.abs(max - min));
  const needed = (extent: number) => {
    const candidates = [0.0001, 0.001, 0.01, 0.1, 1];
    for (const candidate of candidates) {
      if (extent / candidate < 2 ** 31 - 1) return candidate;
    }
    return extent / (2 ** 31 - 1);
  };
  return [needed(span(bounds.minX, bounds.maxX)), needed(span(bounds.minY, bounds.maxY)), needed(span(bounds.minZ, bounds.maxZ))];
}

export function writeLas(dataset: CirDataset, options: WriteLasOptions = DEFAULT_LAS_OPTIONS): { bytes: Uint8Array; warnings: Warning[] } {
  const cloud = dataset.pointcloud;
  const warnings: Warning[] = [];
  if (!cloud) {
    throw new ConversionError({
      code: 'LAS_NO_POINTS',
      what: 'The dataset holds no point cloud to write.',
      why: 'LAS output needs point data; this dataset is vector, raster or table only.',
      action: 'Convert points to a coordinate table (CSV/XYZ) instead, or pick a vector target.',
    });
  }

  const count = cloud.loaded;
  const recordLength = POINT_RECORD_LENGTH[options.pointFormat];
  if (recordLength === undefined) {
    throw new ConversionError({
      code: 'LAS_UNSUPPORTED_WRITE_FORMAT',
      what: `Point format ${options.pointFormat} cannot be written.`,
      why: 'The writer supports the formats defined through LAS 1.4 (0-10).',
      action: 'Choose point format 0, 1, 2, 3, 6 or 7 in the conversion settings.',
    });
  }

  const bounds: Bounds3 = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let index = 0; index < count; index++) {
    const x = cloud.points.x[index];
    const y = cloud.points.y[index];
    const z = cloud.points.z[index];
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z > bounds.maxZ) bounds.maxZ = z;
  }
  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = bounds.minY = bounds.minZ = 0;
    bounds.maxX = bounds.maxY = bounds.maxZ = 0;
  }

  const scale = options.scale ?? deriveScale(bounds);
  // Offsets are placed at the extent minimum so the integer range is used from
  // zero upward, which maximises the precision the scale can express.
  const offset = options.offset ?? [Math.floor(bounds.minX), Math.floor(bounds.minY), Math.floor(bounds.minZ)];

  if (!options.scale) {
    warnings.push(
      warn('LAS_SCALE_DERIVED', `Coordinate scale was derived from the data extent: ${scale.map((value) => value.toString()).join(', ')} m.`, {
        severity: 'info',
        reason: 'LAS stores coordinates as scaled integers, so the scale sets the storable resolution.',
        action: 'Pin the scale in the conversion settings if the recipient expects a specific one.',
      })
    );
  }

  const headerLength = options.versionMinor >= 4 ? 375 : 227;
  const bytes = new Uint8Array(headerLength + count * recordLength);
  const view = new DataView(bytes.buffer);
  const encoder = new TextEncoder();

  bytes.set(encoder.encode('LASF'), 0);
  bytes.set(encoder.encode((options.systemIdentifier ?? '').slice(0, 31)), 26);
  bytes.set(encoder.encode((options.generatingSoftware ?? '').slice(0, 31)), 58);
  bytes[24] = 1;
  bytes[25] = options.versionMinor;
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);
  view.setUint16(90, dayOfYear, true);
  view.setUint16(92, now.getUTCFullYear(), true);
  view.setUint16(94, headerLength, true);
  view.setUint32(96, headerLength, true);
  view.setUint32(100, 0, true); // no VLRs
  view.setUint8(104, options.pointFormat);
  view.setUint16(105, recordLength, true);
  // The legacy 32-bit count saturates above 2^32-1; LAS 1.4 carries the real
  // value in its 64-bit field.
  view.setUint32(107, options.versionMinor >= 4 && count > 0xffffffff ? 0 : count, true);
  for (let index = 0; index < 5; index++) view.setUint32(111 + index * 4, 0, true); // points by return (legacy)
  view.setFloat64(131, scale[0], true);
  view.setFloat64(139, scale[1], true);
  view.setFloat64(147, scale[2], true);
  view.setFloat64(155, offset[0], true);
  view.setFloat64(163, offset[1], true);
  view.setFloat64(171, offset[2], true);
  view.setFloat64(179, bounds.maxX, true);
  view.setFloat64(187, bounds.minX, true);
  view.setFloat64(195, bounds.maxY, true);
  view.setFloat64(203, bounds.minY, true);
  view.setFloat64(211, bounds.maxZ, true);
  view.setFloat64(219, bounds.minZ, true);
  if (options.versionMinor >= 4) {
    view.setBigUint64(235, BigInt(headerLength), true); // start of waveform data (none)
    view.setBigUint64(247, BigInt(count), true);
  }

  const extended = EXTENDED_FORMATS.has(options.pointFormat);
  const wantsColor = HAS_COLOR.has(options.pointFormat);
  const wantsGps = HAS_GPS_TIME.has(options.pointFormat);
  const colorOffset = options.pointFormat === 2 ? 20 : options.pointFormat === 3 ? 28 : options.pointFormat === 7 ? 30 : -1;
  const gpsOffset = extended ? 22 : 20;
  const defaultClass = options.defaultClassification ?? 0;

  for (let index = 0; index < count; index++) {
    const at = headerLength + index * recordLength;
    view.setInt32(at, Math.round((cloud.points.x[index] - offset[0]) / scale[0]), true);
    view.setInt32(at + 4, Math.round((cloud.points.y[index] - offset[1]) / scale[1]), true);
    view.setInt32(at + 8, Math.round((cloud.points.z[index] - offset[2]) / scale[2]), true);
    view.setUint16(at + 12, cloud.points.intensity?.[index] ?? 0, true);

    const returnNumber = cloud.points.returnNumber?.[index] ?? 1;
    const numberOfReturns = cloud.points.numberOfReturns?.[index] ?? 1;
    const classification = cloud.points.classification?.[index] ?? defaultClass;

    if (extended) {
      view.setUint8(at + 14, (returnNumber & 0x0f) | ((numberOfReturns & 0x0f) << 4));
      view.setUint8(at + 15, 0);
      view.setUint8(at + 16, classification);
      view.setUint8(at + 17, 0);
      view.setInt16(at + 18, cloud.points.scanAngle?.[index] ?? 0, true);
      view.setUint16(at + 20, cloud.points.sourceId?.[index] ?? 0, true);
    } else {
      view.setUint8(at + 14, (returnNumber & 0x07) | ((numberOfReturns & 0x07) << 3));
      view.setUint8(at + 15, classification & 0x1f);
      const angle = cloud.points.scanAngle?.[index] ?? 0;
      view.setInt8(at + 16, Math.max(-128, Math.min(127, angle)));
      view.setUint8(at + 17, 0);
      view.setUint16(at + 18, cloud.points.sourceId?.[index] ?? 0, true);
    }

    if (wantsGps) view.setFloat64(at + gpsOffset, cloud.points.gpsTime?.[index] ?? 0, true);
    if (wantsColor && colorOffset >= 0) {
      view.setUint16(at + colorOffset, cloud.points.rgb?.[index * 3] ?? 0, true);
      view.setUint16(at + colorOffset + 2, cloud.points.rgb?.[index * 3 + 1] ?? 0, true);
      view.setUint16(at + colorOffset + 4, cloud.points.rgb?.[index * 3 + 2] ?? 0, true);
    }
  }

  if (wantsColor && !cloud.attributes.color) {
    warnings.push(
      warn('LAS_COLOR_ZEROED', `Point format ${options.pointFormat} carries RGB, but the source has no colour; all values were written as 0.`, {
        reason: 'The chosen point format reserves colour fields whether or not the source provides them.',
        action: `Choose point format ${options.pointFormat === 2 ? '0' : '1'} to omit the colour fields entirely.`,
      })
    );
  }
  if (cloud.attributes.color && !wantsColor) {
    warnings.push(
      warn('LAS_COLOR_DROPPED', 'Point colour was not written.', {
        reason: `Point format ${options.pointFormat} has no RGB fields.`,
        action: 'Choose point format 2, 3 or 7 to keep colour.',
      })
    );
  }
  if (cloud.decimation && cloud.decimation.mode !== 'none') {
    warnings.push(
      warn('LAS_WRITTEN_DECIMATED', `The written file holds ${count.toLocaleString()} of the source's ${cloud.count.toLocaleString()} points.`, {
        count,
        reason: `A ${cloud.decimation.mode} decimation filter is active in the conversion settings.`,
        action: 'Set decimation to "None" to write every point.',
      })
    );
  }

  return { bytes, warnings };
}
