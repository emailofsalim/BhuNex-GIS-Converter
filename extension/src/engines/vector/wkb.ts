/**
 * Well-Known Binary geometry.
 *
 * Supports both dimension conventions that exist in the wild: the OGC/PostGIS
 * flag bits (0x80000000 = Z, 0x40000000 = M, plus the SRID flag 0x20000000) and
 * the ISO SQL/MM offsets (1000 = Z, 2000 = M, 3000 = ZM). Guessing between them
 * would misread every 3D geometry, so both are decoded explicitly.
 */

import {
  createDataset,
  createLayer,
  type CirDataset,
  type CirFeature,
  type CirGeometry,
  type GeometryType,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { assertWithinBuffer, ConversionError } from '../../core/errors';
import { coordinateFormatter, type PrecisionPolicy } from '../../core/precision';
import { crsFromEpsg } from '../../crs/epsg';
import { deriveFields } from '../shared';

const TYPE_BY_CODE: Record<number, GeometryType> = {
  1: 'Point',
  2: 'LineString',
  3: 'Polygon',
  4: 'MultiPoint',
  5: 'MultiLineString',
  6: 'MultiPolygon',
  7: 'GeometryCollection',
};

const CODE_BY_TYPE: Record<GeometryType, number> = {
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
  GeometryCollection: 7,
};

const FLAG_Z = 0x80000000;
const FLAG_M = 0x40000000;
const FLAG_SRID = 0x20000000;

interface Reader {
  view: DataView;
  at: number;
  srid: number | null;
}

interface DecodedType {
  type: GeometryType;
  hasZ: boolean;
  hasM: boolean;
}

function decodeTypeCode(raw: number): DecodedType {
  let hasZ = (raw & FLAG_Z) !== 0;
  let hasM = (raw & FLAG_M) !== 0;
  const base = raw & ~(FLAG_Z | FLAG_M | FLAG_SRID);
  let code = base;
  if (base >= 3000) {
    code = base - 3000;
    hasZ = true;
    hasM = true;
  } else if (base >= 2000) {
    code = base - 2000;
    hasM = true;
  } else if (base >= 1000) {
    code = base - 1000;
    hasZ = true;
  }
  const type = TYPE_BY_CODE[code];
  if (!type) {
    throw new ConversionError({
      code: 'WKB_UNKNOWN_TYPE',
      what: `WKB geometry type code ${raw} is not a simple-feature type.`,
      why: 'Only codes 1-7 (with the Z/M/SRID variants) are defined for simple features. Curved and TIN types are not supported.',
      action: 'Convert the geometry to simple features in PostGIS or QGIS before exporting.',
    });
  }
  return { type, hasZ, hasM };
}

function readGeometry(reader: Reader): CirGeometry {
  const littleEndian = reader.view.getUint8(reader.at) === 1;
  reader.at += 1;
  const rawType = reader.view.getUint32(reader.at, littleEndian);
  reader.at += 4;
  if ((rawType & FLAG_SRID) !== 0) {
    reader.srid = reader.view.getUint32(reader.at, littleEndian);
    reader.at += 4;
  }
  const { type, hasZ, hasM } = decodeTypeCode(rawType);
  const ordinates = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  const dimension: 2 | 3 | 4 = hasZ && hasM ? 4 : hasZ || hasM ? 3 : 2;

  const readPosition = (): Position => {
    const position: Position = [];
    for (let i = 0; i < ordinates; i++) {
      position.push(reader.view.getFloat64(reader.at, littleEndian));
      reader.at += 8;
    }
    return position;
  };

  const readCount = (): number => {
    const count = reader.view.getUint32(reader.at, littleEndian);
    reader.at += 4;
    // A corrupt count would otherwise allocate gigabytes; each position needs at
    // least ordinates*8 bytes, so the remaining buffer bounds it.
    assertWithinBuffer(count * ordinates * 8, reader.view.byteLength - reader.at + count * ordinates * 8, {
      code: 'WKB_TRUNCATED',
      unit: 'bytes of coordinate data',
      what: 'The WKB stream declares more coordinates than the file contains.',
      action: 'Re-export the geometry; the file is truncated.',
    });
    return count;
  };

  switch (type) {
    case 'Point':
      return { type, coordinates: readPosition(), dimension };
    case 'LineString':
    case 'MultiPoint': {
      if (type === 'MultiPoint') {
        const count = readCount();
        const points: Position[] = [];
        for (let i = 0; i < count; i++) {
          const child = readGeometry(reader);
          points.push(child.coordinates as Position);
        }
        return { type, coordinates: points, dimension };
      }
      const count = readCount();
      const positions: Position[] = [];
      for (let i = 0; i < count; i++) positions.push(readPosition());
      return { type, coordinates: positions, dimension };
    }
    case 'Polygon': {
      const ringCount = readCount();
      const rings: Position[][] = [];
      for (let r = 0; r < ringCount; r++) {
        const count = readCount();
        const ring: Position[] = [];
        for (let i = 0; i < count; i++) ring.push(readPosition());
        rings.push(ring);
      }
      return { type, coordinates: rings, dimension };
    }
    case 'MultiLineString':
    case 'MultiPolygon':
    case 'GeometryCollection': {
      const count = readCount();
      const children: CirGeometry[] = [];
      for (let i = 0; i < count; i++) children.push(readGeometry(reader));
      if (type === 'GeometryCollection') return { type, geometries: children, dimension };
      return { type, coordinates: children.map((child) => child.coordinates), dimension };
    }
    default:
      throw new ConversionError({
        code: 'WKB_UNKNOWN_TYPE',
        what: `WKB type ${type} could not be decoded.`,
        why: 'The type passed validation but has no reader branch.',
        action: 'Report this file so the reader can be extended.',
      });
  }
}

export function readWkb(bytes: Uint8Array, source: SourceInfo): CirDataset {
  if (bytes.length < 5) {
    throw new ConversionError({
      code: 'WKB_TOO_SHORT',
      what: 'The file is too short to be WKB.',
      why: 'A WKB geometry needs at least a byte-order flag and a 4-byte type code.',
      action: 'Check that the file downloaded completely.',
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reader: Reader = { view, at: 0, srid: null };
  const features: CirFeature[] = [];
  const warnings: Warning[] = [];

  // A .wkb file may hold one geometry or a concatenated stream of them.
  let index = 0;
  while (reader.at < bytes.length - 4) {
    const start = reader.at;
    try {
      features.push({ id: index++, geometry: readGeometry(reader), properties: {} });
    } catch (error) {
      if (features.length === 0) throw error;
      break;
    }
    if (reader.at <= start) break;
  }

  return createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    crs: reader.srid ? crsFromEpsg(reader.srid) : null,
    crsOrigin: reader.srid ? 'declared' : 'unknown',
    axisOrder: 'xy',
    layers: [createLayer(source.fileName, features, deriveFields(features))],
    warnings,
  });
}

export interface WriteWkbOptions {
  precision: PrecisionPolicy;
  /** Prefix the geometry with its SRID, PostGIS EWKB style. */
  includeSrid?: boolean;
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private buffer = new Uint8Array(4096);
  private at = 0;

  private ensure(size: number): void {
    if (this.at + size <= this.buffer.length) return;
    this.chunks.push(this.buffer.subarray(0, this.at));
    this.buffer = new Uint8Array(Math.max(4096, size));
    this.at = 0;
  }

  u8(value: number): void {
    this.ensure(1);
    this.buffer[this.at++] = value;
  }

  u32(value: number): void {
    this.ensure(4);
    new DataView(this.buffer.buffer, this.buffer.byteOffset + this.at, 4).setUint32(0, value >>> 0, true);
    this.at += 4;
  }

  f64(value: number): void {
    this.ensure(8);
    new DataView(this.buffer.buffer, this.buffer.byteOffset + this.at, 8).setFloat64(0, value, true);
    this.at += 8;
  }

  finish(): Uint8Array {
    this.chunks.push(this.buffer.subarray(0, this.at));
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export function writeWkb(dataset: CirDataset, options: WriteWkbOptions): { bytes: Uint8Array; warnings: Warning[] } {
  const writer = new ByteWriter();
  const geographic = dataset.crs?.kind === 'geographic';
  const format = coordinateFormatter(options.precision, geographic);
  const srid = options.includeSrid && dataset.crs?.epsg ? Number(dataset.crs.epsg) : null;
  const warnings: Warning[] = [];

  const writeGeometry = (geometry: CirGeometry, topLevel: boolean): void => {
    const hasZ = geometry.dimension >= 3;
    const hasM = geometry.dimension === 4;
    let typeCode = CODE_BY_TYPE[geometry.type];
    if (hasZ) typeCode |= FLAG_Z;
    if (hasM) typeCode |= FLAG_M;
    if (topLevel && srid !== null) typeCode |= FLAG_SRID;

    writer.u8(1); // little-endian
    writer.u32(typeCode);
    if (topLevel && srid !== null) writer.u32(srid);

    const ordinates = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
    const writePosition = (position: Position): void => {
      writer.f64(format.x(position[0]));
      writer.f64(format.y(position[1]));
      if (ordinates >= 3) writer.f64(format.z(position[2] ?? 0));
      if (ordinates >= 4) writer.f64(position[3] ?? 0);
    };

    switch (geometry.type) {
      case 'Point':
        writePosition((geometry.coordinates as Position) ?? [0, 0]);
        break;
      case 'LineString': {
        const positions = (geometry.coordinates as Position[]) ?? [];
        writer.u32(positions.length);
        for (const position of positions) writePosition(position);
        break;
      }
      case 'MultiPoint': {
        const positions = (geometry.coordinates as Position[]) ?? [];
        writer.u32(positions.length);
        for (const position of positions) writeGeometry({ type: 'Point', coordinates: position, dimension: geometry.dimension }, false);
        break;
      }
      case 'Polygon': {
        const rings = (geometry.coordinates as Position[][]) ?? [];
        writer.u32(rings.length);
        for (const ring of rings) {
          writer.u32(ring.length);
          for (const position of ring) writePosition(position);
        }
        break;
      }
      case 'MultiLineString': {
        const lines = (geometry.coordinates as Position[][]) ?? [];
        writer.u32(lines.length);
        for (const line of lines) writeGeometry({ type: 'LineString', coordinates: line, dimension: geometry.dimension }, false);
        break;
      }
      case 'MultiPolygon': {
        const polygons = (geometry.coordinates as Position[][][]) ?? [];
        writer.u32(polygons.length);
        for (const rings of polygons) writeGeometry({ type: 'Polygon', coordinates: rings, dimension: geometry.dimension }, false);
        break;
      }
      case 'GeometryCollection': {
        const children = geometry.geometries ?? [];
        writer.u32(children.length);
        for (const child of children) writeGeometry(child, false);
        break;
      }
      default:
        break;
    }
  };

  let attributeCount = 0;
  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      if (!feature.geometry) continue;
      if (Object.keys(feature.properties ?? {}).length > 0) attributeCount++;
      writeGeometry(feature.geometry, true);
    }
  }

  if (attributeCount > 0) {
    warnings.push({
      code: 'WKB_ATTRIBUTES_DROPPED',
      severity: 'warning',
      message: `Attributes on ${attributeCount} feature(s) were not written.`,
      reason: 'WKB carries geometry only; it has no attribute container.',
      action: 'Export to GeoPackage, Shapefile or GeoJSON if the attributes must be preserved.',
      count: attributeCount,
    });
  }

  return { bytes: writer.finish(), warnings };
}
