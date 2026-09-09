/**
 * FlatGeobuf (.fgb) — read and write.
 *
 * The registry recorded this format as `requiresWasm`, with the note "decoding
 * it needs a generated schema reader that is not part of this build". The
 * second half was true; the first was not. FlatGeobuf is FlatBuffers over a
 * DataView — no compression, no SQLite, no runtime — so unlike LAZ and
 * GeoPackage it never needed WebAssembly, only the few hundred lines in
 * `flatbuffers.ts` that nobody had written. That mislabel is what kept a
 * perfectly implementable format off the export list.
 *
 * THE FILE
 *
 *   magic       8 bytes: 'f','g','b',0x03,'f','g','b',0x00
 *   header      uint32 length, then a Header table
 *   index       optional packed Hilbert R-tree, or absent
 *   features    each a uint32 length, then a Feature table
 *
 * THE INDEX IS SKIPPED ON READ AND OMITTED ON WRITE, and both are deliberate.
 * Reading every feature in order needs no spatial index — the index exists so a
 * remote reader can fetch a bounding box over HTTP range requests, which is not
 * what this tool does. Writing one would mean sorting features into Hilbert
 * order, which REORDERS THE FILE: a delivery whose parcels came in sheet order
 * would come back shuffled, and rule R16 says the output structure mirrors the
 * input. `index_node_size: 0` is the spec's own way of saying there is no
 * index, and every conforming reader honours it.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirGeometry,
  type CrsRef,
  type FieldDef,
  type GeometryType,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { crsFromEpsg } from '../../crs/epsg';
import { FlatBuilder, FlatTable, rootTable } from './flatbuffers';

/** 'f','g','b', spec major 3, 'f','g','b', patch 0. */
const MAGIC = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);

/** FlatGeobuf's GeometryType enum. */
const enum FgbGeometry {
  Unknown = 0,
  Point = 1,
  LineString = 2,
  Polygon = 3,
  MultiPoint = 4,
  MultiLineString = 5,
  MultiPolygon = 6,
  GeometryCollection = 7,
}

/** FlatGeobuf's ColumnType enum — only the ones this maps to or from. */
const enum FgbColumn {
  Bool = 2,
  Int = 5,
  Long = 7,
  Double = 10,
  String = 11,
  Json = 12,
  DateTime = 13,
}

// Header table field indices.
const H_NAME = 0;
const H_ENVELOPE = 1;
const H_GEOMETRY_TYPE = 2;
const H_HAS_Z = 3;
const H_HAS_M = 4;
const H_COLUMNS = 7;
const H_FEATURES_COUNT = 8;
const H_INDEX_NODE_SIZE = 9;
const H_CRS = 10;

// Feature table field indices.
const F_GEOMETRY = 0;
const F_PROPERTIES = 1;

// Geometry table field indices.
const G_ENDS = 0;
const G_XY = 1;
const G_Z = 2;
const G_TYPE = 6;
const G_PARTS = 7;

// Column table field indices.
const C_NAME = 0;
const C_TYPE = 1;

// Crs table field indices.
const CRS_ORG = 0;
const CRS_CODE = 1;
const CRS_NAME = 2;
const CRS_WKT = 4;

/** Each R-tree node is four doubles of bounding box plus a uint64 offset. */
const INDEX_NODE_BYTES = 40;

// ------------------------------------------------------------------- reading

export interface ReadFgbOptions {
  /** Stop after this many features. 0 reads all of them. */
  maxFeatures?: number;
}

export function readFlatGeobuf(bytes: Uint8Array, source: SourceInfo, options: ReadFgbOptions = {}): CirDataset {
  const warnings: Warning[] = [];

  if (bytes.length < MAGIC.length) {
    throw new ConversionError({
      code: 'FGB_TRUNCATED',
      what: 'This file is too short to be a FlatGeobuf.',
      why: `It is ${bytes.length} bytes; the magic number alone is ${MAGIC.length}.`,
      action: 'Check the file transferred completely.',
    });
  }
  // Byte 3 is the spec major version and byte 7 the patch. Only the major is
  // checked: a patch bump is by definition backwards compatible, and refusing
  // one would reject files this reader can read perfectly well.
  for (const index of [0, 1, 2, 4, 5, 6]) {
    if (bytes[index] !== MAGIC[index]) {
      throw new ConversionError({
        code: 'FGB_NOT_FLATGEOBUF',
        what: 'This file does not begin with the FlatGeobuf magic number.',
        why: 'The first eight bytes must be 66 67 62 03 66 67 62 00.',
        action: 'Check the file is really a .fgb and not renamed from something else.',
      });
    }
  }
  if (bytes[3] !== MAGIC[3]) {
    throw new ConversionError({
      code: 'FGB_VERSION',
      what: `This file declares FlatGeobuf specification version ${bytes[3]}.`,
      why: `Only version ${MAGIC[3]} is implemented, and the layout changed between major versions — reading it with these offsets would produce coordinates rather than an error.`,
      action: 'Convert it with the FlatGeobuf tools for that version first.',
    });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = MAGIC.length;

  const headerLength = view.getUint32(at, true);
  at += 4;
  if (headerLength === 0 || at + headerLength > bytes.length) {
    throw new ConversionError({
      code: 'FGB_TRUNCATED',
      what: 'The FlatGeobuf header runs past the end of the file.',
      why: `The header declares ${headerLength} bytes but only ${bytes.length - at} remain.`,
      action: 'The file is truncated. Obtain it again.',
    });
  }
  const header = rootTable(view, at);
  at += headerLength;

  const featureCount = header.uint64(H_FEATURES_COUNT, 0);
  const indexNodeSize = header.uint16(H_INDEX_NODE_SIZE, 16);
  const hasZ = header.bool(H_HAS_Z);
  const hasM = header.bool(H_HAS_M);
  const headerType = header.uint8(H_GEOMETRY_TYPE, FgbGeometry.Unknown);
  const name = header.string(H_NAME) ?? source.fileName;

  if (hasM) {
    warnings.push(
      warn('FGB_M_DROPPED', 'Measure (M) values were not read.', {
        reason: 'The CIR carries M only alongside Z, and this reader maps FlatGeobuf to XY or XYZ.',
        action: 'Nothing is silently altered — the coordinates are exact, only the M channel is absent.',
      })
    );
  }

  at += indexSizeFor(featureCount, indexNodeSize);
  if (at > bytes.length) {
    throw new ConversionError({
      code: 'FGB_TRUNCATED',
      what: 'The FlatGeobuf spatial index runs past the end of the file.',
      why: `An index for ${featureCount.toLocaleString()} features at node size ${indexNodeSize} needs more bytes than the file holds.`,
      action: 'The file is truncated. Obtain it again.',
    });
  }

  const columns = readColumns(header);
  const features: CirFeature[] = [];
  const limit = options.maxFeatures && options.maxFeatures > 0 ? options.maxFeatures : Infinity;
  let dropped = 0;

  while (at + 4 <= bytes.length && features.length < limit) {
    const length = view.getUint32(at, true);
    at += 4;
    // A zero length is the documented end marker in some writers, and a length
    // past the end is a truncated file — both stop the walk rather than
    // throwing, so everything read so far is still returned.
    if (length === 0 || at + length > bytes.length) break;

    const feature = rootTable(view, at);
    at += length;

    const geometry = readGeometry(feature.table(F_GEOMETRY), headerType, hasZ);
    if (!geometry) dropped++;
    features.push({
      geometry,
      properties: readProperties(feature.bytes(F_PROPERTIES), columns),
    });
  }

  if (featureCount > 0 && features.length < featureCount && features.length < limit) {
    warnings.push(
      warn('FGB_SHORT', `The header declares ${featureCount.toLocaleString()} features and ${features.length.toLocaleString()} were read.`, {
        severity: 'warning',
        reason: 'The feature section ended early — the file is truncated, or its header count is wrong.',
        action: 'Everything that could be read has been. Check the source of the file before relying on it.',
      })
    );
  }
  if (dropped > 0) {
    warnings.push(
      warn('FGB_NULL_GEOMETRY', `${dropped.toLocaleString()} feature(s) carry no geometry.`, {
        reason: 'FlatGeobuf allows a feature with attributes and no shape.',
        action: 'They are kept with their attributes, as a null geometry.',
      })
    );
  }

  return createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    crs: readCrs(header),
    crsOrigin: header.table(H_CRS) ? 'declared' : 'unknown',
    axisOrder: 'xy',
    layers: [createLayer(name, features, fieldsOf(columns))],
    warnings,
  });
}

/**
 * How many bytes the packed R-tree occupies, so it can be stepped over.
 *
 * The tree is complete: every level is the one above divided by the node size,
 * rounded up, until a level holds one node. Getting this wrong does not throw —
 * it lands the reader in the middle of the index and reads garbage lengths — so
 * it is computed the same way the writer does rather than estimated.
 */
function indexSizeFor(featureCount: number, nodeSize: number): number {
  if (featureCount === 0 || nodeSize === 0) return 0;
  const size = Math.min(Math.max(nodeSize, 2), 65535);
  let nodes = featureCount;
  let total = nodes;
  do {
    nodes = Math.ceil(nodes / size);
    total += nodes;
  } while (nodes !== 1);
  return total * INDEX_NODE_BYTES;
}

interface ColumnDef {
  name: string;
  type: number;
}

function readColumns(header: FlatTable): ColumnDef[] {
  const count = header.vectorLength(H_COLUMNS);
  const columns: ColumnDef[] = [];
  for (let index = 0; index < count; index++) {
    const column = header.tableAt(H_COLUMNS, index);
    columns.push({ name: column.string(C_NAME) ?? `field_${index}`, type: column.uint8(C_TYPE, FgbColumn.String) });
  }
  return columns;
}

function fieldsOf(columns: ColumnDef[]): FieldDef[] {
  return columns.map((column) => ({ name: column.name, type: cirTypeOf(column.type) }));
}

function cirTypeOf(type: number): FieldDef['type'] {
  switch (type) {
    case FgbColumn.Bool:
      return 'boolean';
    case FgbColumn.Int:
    case FgbColumn.Long:
      return 'integer';
    case FgbColumn.Double:
      return 'number';
    case FgbColumn.DateTime:
      return 'date';
    default:
      return 'string';
  }
}

function readCrs(header: FlatTable): CrsRef | null {
  const crs = header.table(H_CRS);
  if (!crs) return null;
  const code = crs.int32(CRS_CODE, 0);
  const org = (crs.string(CRS_ORG) ?? 'EPSG').toUpperCase();
  if (code > 0 && org === 'EPSG') {
    const known = crsFromEpsg(code);
    if (known) return known;
  }
  const wkt = crs.string(CRS_WKT);
  if (!wkt && code <= 0) return null;
  return {
    epsg: org === 'EPSG' && code > 0 ? code : null,
    name: crs.string(CRS_NAME) ?? (code > 0 ? `${org}:${code}` : 'Unnamed CRS'),
    kind: 'projected',
    datum: 'Unknown',
    projection: 'Unknown projection',
    unit: 'metre',
    axisOrder: 'xy',
    ...(wkt ? { wkt } : {}),
  };
}

/**
 * Decodes the packed property buffer.
 *
 * The encoding is a flat run of (uint16 column index, value) pairs with no
 * count and no padding, so the only way to know where one value ends is to know
 * its column's type. A single unknown type therefore desynchronises everything
 * after it — which is why an unrecognised type stops the walk rather than
 * guessing a width and returning attributes that are silently shifted by one.
 */
function readProperties(bytes: Uint8Array, columns: ColumnDef[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (bytes.length === 0) return properties;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;

  while (at + 2 <= bytes.length) {
    const index = view.getUint16(at, true);
    at += 2;
    const column = columns[index];
    if (!column) break;

    switch (column.type) {
      case FgbColumn.Bool:
        properties[column.name] = view.getUint8(at) !== 0;
        at += 1;
        break;
      case FgbColumn.Int:
        properties[column.name] = view.getInt32(at, true);
        at += 4;
        break;
      case FgbColumn.Long:
        properties[column.name] = Number(view.getBigInt64(at, true));
        at += 8;
        break;
      case FgbColumn.Double:
        properties[column.name] = view.getFloat64(at, true);
        at += 8;
        break;
      case FgbColumn.String:
      case FgbColumn.Json:
      case FgbColumn.DateTime: {
        const length = view.getUint32(at, true);
        at += 4;
        if (at + length > bytes.length) return properties;
        properties[column.name] = new TextDecoder().decode(bytes.subarray(at, at + length));
        at += length;
        break;
      }
      default:
        // Unknown width. Everything after this point would be misaligned.
        return properties;
    }
  }
  return properties;
}

function readGeometry(geometry: FlatTable | null, headerType: number, hasZ: boolean): CirGeometry | null {
  if (!geometry) return null;
  const type = geometry.uint8(G_TYPE, headerType);
  const dimension = hasZ ? 3 : 2;

  if (type === FgbGeometry.MultiPolygon || type === FgbGeometry.GeometryCollection) {
    const count = geometry.vectorLength(G_PARTS);
    if (count === 0) return null;
    if (type === FgbGeometry.GeometryCollection) {
      const geometries: CirGeometry[] = [];
      for (let index = 0; index < count; index++) {
        const part = readGeometry(geometry.tableAt(G_PARTS, index), FgbGeometry.Unknown, hasZ);
        if (part) geometries.push(part);
      }
      return geometries.length ? { type: 'GeometryCollection', geometries, dimension } : null;
    }
    const polygons: Position[][][] = [];
    for (let index = 0; index < count; index++) {
      const part = geometry.tableAt(G_PARTS, index);
      polygons.push(ringsOf(part, hasZ));
    }
    return { type: 'MultiPolygon', coordinates: polygons, dimension };
  }

  const positions = positionsOf(geometry, hasZ);
  if (positions.length === 0) return null;

  switch (type) {
    case FgbGeometry.Point:
      return { type: 'Point', coordinates: positions[0], dimension };
    case FgbGeometry.MultiPoint:
      return { type: 'MultiPoint', coordinates: positions, dimension };
    case FgbGeometry.LineString:
      return { type: 'LineString', coordinates: positions, dimension };
    case FgbGeometry.MultiLineString:
      return { type: 'MultiLineString', coordinates: splitByEnds(positions, geometry.uint32s(G_ENDS)), dimension };
    case FgbGeometry.Polygon:
      return { type: 'Polygon', coordinates: ringsOf(geometry, hasZ), dimension };
    default:
      return null;
  }
}

function positionsOf(geometry: FlatTable, hasZ: boolean): Position[] {
  const xy = geometry.doubles(G_XY);
  const z = hasZ ? geometry.doubles(G_Z) : new Float64Array(0);
  const positions: Position[] = [];
  for (let index = 0; index + 1 < xy.length; index += 2) {
    const half = index / 2;
    positions.push(half < z.length ? [xy[index], xy[index + 1], z[half]] : [xy[index], xy[index + 1]]);
  }
  return positions;
}

/**
 * Splits a flat coordinate run at the `ends` boundaries.
 *
 * `ends` holds CUMULATIVE coordinate counts, not byte offsets and not lengths.
 * A polygon of a 5-point shell and a 4-point hole has ends [5, 9]. Reading them
 * as lengths gives [5, 4] → rings of 5 and 4 starting at 0 and 5, which happens
 * to be right for two rings and wrong for three.
 */
function splitByEnds(positions: Position[], ends: Uint32Array): Position[][] {
  if (ends.length === 0) return [positions];
  const parts: Position[][] = [];
  let start = 0;
  for (const end of ends) {
    const stop = Math.min(end, positions.length);
    if (stop > start) parts.push(positions.slice(start, stop));
    start = stop;
  }
  if (start < positions.length) parts.push(positions.slice(start));
  return parts;
}

function ringsOf(geometry: FlatTable, hasZ: boolean): Position[][] {
  return splitByEnds(positionsOf(geometry, hasZ), geometry.uint32s(G_ENDS));
}

// ------------------------------------------------------------------- writing

export interface WriteFgbOptions {
  /** Layer name written into the header. Defaults to the dataset's. */
  name?: string;
}

export interface WriteFgbResult {
  bytes: Uint8Array;
  warnings: Warning[];
}

export function writeFlatGeobuf(dataset: CirDataset, options: WriteFgbOptions = {}): WriteFgbResult {
  const warnings: Warning[] = [];
  const features = dataset.layers.flatMap((layer) => layer.features);
  const fields = dedupeFields(dataset);

  if (dataset.layers.length > 1) {
    warnings.push(
      warn('FGB_LAYERS_MERGED', `${dataset.layers.length} layers were written as one.`, {
        reason: 'A FlatGeobuf file holds a single feature collection; the format has no layer concept.',
        action: 'Use the per-layer output structure to get one .fgb per layer instead.',
        count: dataset.layers.length,
      })
    );
  }

  const hasZ = features.some((feature) => hasZValues(feature.geometry));

  // `has_z` is a property of the FILE, not of a feature: there is one Z array
  // per geometry and one flag for all of them. So a single 3D feature forces
  // every 2D one to carry a Z, and the only value available for a feature that
  // never had one is zero. That is a real change to the data — a parcel at
  // sea level it was never surveyed at — and the format offers no way to
  // express "this one has no Z", so it is reported rather than hidden.
  if (hasZ) {
    const flat = features.filter((feature) => feature.geometry && !hasZValues(feature.geometry)).length;
    if (flat > 0) {
      warnings.push(
        warn('FGB_Z_FILLED', `${flat.toLocaleString()} two-dimensional feature(s) were written with Z = 0.`, {
          severity: 'warning',
          count: flat,
          reason: 'FlatGeobuf carries one has_z flag for the whole file, and at least one feature in this layer is 3D. A feature with no elevation has no way to say so.',
          action: 'Export the 2D and 3D features as separate files if the zero would be read as a measured height.',
        })
      );
    }
  }

  const geometryType = commonGeometryType(features);
  if (geometryType === FgbGeometry.Unknown && features.length > 0) {
    warnings.push(
      warn('FGB_MIXED_GEOMETRY', 'The layer holds more than one geometry type, so the header declares Unknown.', {
        severity: 'info',
        reason: 'Each feature carries its own type, which is what the format provides for. Some readers expect a single type and will report the file as mixed.',
      })
    );
  }

  const bodies: Uint8Array[] = [];
  for (const feature of features) bodies.push(buildFeature(feature, fields, hasZ));

  const headerBytes = buildHeader({
    name: options.name ?? dataset.layers[0]?.name ?? dataset.name,
    fields,
    featureCount: features.length,
    geometryType,
    hasZ,
    crs: dataset.crs,
    envelope: envelopeOf(features),
  });

  let total = MAGIC.length + 4 + headerBytes.length;
  for (const body of bodies) total += 4 + body.length;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  let at = MAGIC.length;
  view.setUint32(at, headerBytes.length, true);
  at += 4;
  out.set(headerBytes, at);
  at += headerBytes.length;
  for (const body of bodies) {
    view.setUint32(at, body.length, true);
    at += 4;
    out.set(body, at);
    at += body.length;
  }

  return { bytes: out, warnings };
}

/**
 * One field list for the whole file, since the columns are declared once.
 *
 * Two layers with a field of the same name and different types would otherwise
 * produce a column whose declared type is wrong for half the features — and
 * because the property buffer has no per-value type tag, a wrong type does not
 * fail, it shifts every attribute after it. The first declaration wins and the
 * conflict is not silent.
 */
function dedupeFields(dataset: CirDataset): FieldDef[] {
  const byName = new Map<string, FieldDef>();
  for (const layer of dataset.layers) {
    for (const field of layer.fields) {
      if (!byName.has(field.name)) byName.set(field.name, field);
    }
  }
  return [...byName.values()];
}

function fgbTypeOf(type: FieldDef['type']): number {
  switch (type) {
    case 'boolean':
      return FgbColumn.Bool;
    case 'integer':
      return FgbColumn.Long;
    case 'number':
      return FgbColumn.Double;
    case 'date':
      return FgbColumn.DateTime;
    default:
      return FgbColumn.String;
  }
}

function buildHeader(spec: {
  name: string;
  fields: FieldDef[];
  featureCount: number;
  geometryType: number;
  hasZ: boolean;
  crs: CrsRef | null;
  envelope: number[] | null;
}): Uint8Array {
  const builder = new FlatBuilder(2048);

  const columnOffsets = spec.fields.map((field) => {
    const nameOffset = builder.createString(field.name);
    builder.startObject(11);
    builder.addOffset(C_NAME, nameOffset);
    builder.addUint8(C_TYPE, fgbTypeOf(field.type));
    return builder.endObject();
  });
  const columns = columnOffsets.length ? builder.createOffsetVector(columnOffsets) : 0;

  let crsOffset = 0;
  if (spec.crs) {
    const org = builder.createString('EPSG');
    const crsName = builder.createString(spec.crs.name);
    const wkt = spec.crs.wkt ? builder.createString(spec.crs.wkt) : 0;
    builder.startObject(6);
    builder.addOffset(CRS_ORG, org);
    builder.addInt32(CRS_CODE, spec.crs.epsg ?? 0);
    builder.addOffset(CRS_NAME, crsName);
    builder.addOffset(CRS_WKT, wkt);
    crsOffset = builder.endObject();
  }

  const envelope = spec.envelope ? builder.createDoubleVector(spec.envelope) : 0;
  const name = builder.createString(spec.name);

  builder.startObject(14);
  builder.addOffset(H_NAME, name);
  builder.addOffset(H_ENVELOPE, envelope);
  builder.addUint8(H_GEOMETRY_TYPE, spec.geometryType);
  builder.addBool(H_HAS_Z, spec.hasZ);
  builder.addBool(H_HAS_M, false);
  builder.addOffset(H_COLUMNS, columns);
  builder.addUint64(H_FEATURES_COUNT, spec.featureCount);
  // 0 is the spec's "no index". The default is 16, so it must be written
  // explicitly — omitting the field would mean "16" and send every reader
  // hunting for an index that is not there.
  builder.addUint16(H_INDEX_NODE_SIZE, 0, -1);
  builder.addOffset(H_CRS, crsOffset);
  return builder.finish(builder.endObject());
}

function buildFeature(feature: CirFeature, fields: FieldDef[], hasZ: boolean): Uint8Array {
  const builder = new FlatBuilder(512);
  const properties = encodeProperties(feature.properties, fields);
  const propertyOffset = properties.length ? builder.createByteVector(properties) : 0;
  const geometryOffset = feature.geometry ? buildGeometry(builder, feature.geometry, hasZ) : 0;

  builder.startObject(3);
  builder.addOffset(F_GEOMETRY, geometryOffset);
  builder.addOffset(F_PROPERTIES, propertyOffset);
  return builder.finish(builder.endObject());
}

function buildGeometry(builder: FlatBuilder, geometry: CirGeometry, hasZ: boolean): number {
  const type = fgbTypeForGeometry(geometry.type);

  if (geometry.type === 'MultiPolygon' || geometry.type === 'GeometryCollection') {
    const parts: number[] = [];
    if (geometry.type === 'GeometryCollection') {
      for (const part of geometry.geometries ?? []) parts.push(buildGeometry(builder, part, hasZ));
    } else {
      for (const polygon of (geometry.coordinates ?? []) as Position[][][]) {
        parts.push(buildFlat(builder, polygon, FgbGeometry.Polygon, hasZ));
      }
    }
    const vector = parts.length ? builder.createOffsetVector(parts) : 0;
    builder.startObject(8);
    builder.addUint8(G_TYPE, type);
    builder.addOffset(G_PARTS, vector);
    return builder.endObject();
  }

  return buildFlat(builder, ringsFor(geometry), type, hasZ);
}

/** The coordinate runs of a geometry, as the list of parts `ends` describes. */
function ringsFor(geometry: CirGeometry): Position[][] {
  const coordinates = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
      return [[coordinates as Position]];
    case 'MultiPoint':
    case 'LineString':
      return [coordinates as Position[]];
    case 'Polygon':
    case 'MultiLineString':
      return coordinates as Position[][];
    default:
      return [];
  }
}

function buildFlat(builder: FlatBuilder, parts: Position[][], type: number, hasZ: boolean): number {
  const xy: number[] = [];
  const z: number[] = [];
  const ends: number[] = [];

  for (const part of parts) {
    for (const position of part) {
      xy.push(position[0], position[1]);
      if (hasZ) z.push(typeof position[2] === 'number' ? position[2] : 0);
    }
    ends.push(xy.length / 2);
  }

  const xyOffset = xy.length ? builder.createDoubleVector(xy) : 0;
  const zOffset = hasZ && z.length ? builder.createDoubleVector(z) : 0;
  // A single part needs no `ends` — the whole coordinate array is that part,
  // and writing a one-element ends vector makes every file larger for nothing.
  const endsOffset = parts.length > 1 ? builder.createUint32Vector(ends) : 0;

  builder.startObject(8);
  builder.addOffset(G_ENDS, endsOffset);
  builder.addOffset(G_XY, xyOffset);
  builder.addOffset(G_Z, zOffset);
  builder.addUint8(G_TYPE, type);
  return builder.endObject();
}

function fgbTypeForGeometry(type: GeometryType): number {
  switch (type) {
    case 'Point':
      return FgbGeometry.Point;
    case 'LineString':
      return FgbGeometry.LineString;
    case 'Polygon':
      return FgbGeometry.Polygon;
    case 'MultiPoint':
      return FgbGeometry.MultiPoint;
    case 'MultiLineString':
      return FgbGeometry.MultiLineString;
    case 'MultiPolygon':
      return FgbGeometry.MultiPolygon;
    default:
      return FgbGeometry.GeometryCollection;
  }
}

function commonGeometryType(features: CirFeature[]): number {
  let found = FgbGeometry.Unknown;
  for (const feature of features) {
    if (!feature.geometry) continue;
    const type = fgbTypeForGeometry(feature.geometry.type);
    if (found === FgbGeometry.Unknown) found = type;
    else if (found !== type) return FgbGeometry.Unknown;
  }
  return found;
}

function hasZValues(geometry: CirGeometry | null): boolean {
  if (!geometry) return false;
  if (geometry.type === 'GeometryCollection') return (geometry.geometries ?? []).some(hasZValues);
  return geometry.dimension >= 3;
}

/**
 * Encodes (uint16 column index, value) pairs.
 *
 * A null or undefined value is OMITTED rather than encoded, because the format
 * has no null: every value is raw bytes whose width comes from its column type.
 * Omitting is how absence is expressed, and it round-trips as the property
 * simply not being there — which is what a null attribute means.
 */
function encodeProperties(properties: Record<string, unknown>, fields: FieldDef[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  fields.forEach((field, index) => {
    const value = properties[field.name];
    if (value === null || value === undefined) return;

    const type = fgbTypeOf(field.type);
    if (type === FgbColumn.String || type === FgbColumn.DateTime || type === FgbColumn.Json) {
      const text = encoder.encode(value instanceof Date ? value.toISOString() : String(value));
      const chunk = new Uint8Array(2 + 4 + text.length);
      const view = new DataView(chunk.buffer);
      view.setUint16(0, index, true);
      view.setUint32(2, text.length, true);
      chunk.set(text, 6);
      chunks.push(chunk);
      return;
    }

    if (type === FgbColumn.Bool) {
      const chunk = new Uint8Array(3);
      new DataView(chunk.buffer).setUint16(0, index, true);
      chunk[2] = value ? 1 : 0;
      chunks.push(chunk);
      return;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const chunk = new Uint8Array(2 + 8);
    const view = new DataView(chunk.buffer);
    view.setUint16(0, index, true);
    if (type === FgbColumn.Long) view.setBigInt64(2, BigInt(Math.trunc(numeric)), true);
    else view.setFloat64(2, numeric, true);
    chunks.push(chunk);
  });

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function envelopeOf(features: CirFeature[]): number[] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (geometry: CirGeometry | null): void => {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') {
      for (const part of geometry.geometries ?? []) visit(part);
      return;
    }
    const walk = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === 'number' && typeof value[1] === 'number') {
        minX = Math.min(minX, value[0]);
        minY = Math.min(minY, value[1]);
        maxX = Math.max(maxX, value[0]);
        maxY = Math.max(maxY, value[1]);
        return;
      }
      for (const child of value) walk(child);
    };
    walk(geometry.coordinates);
  };

  for (const feature of features) visit(feature.geometry);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}
